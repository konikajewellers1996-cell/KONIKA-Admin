import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  calculateProductPrice,
  formatGrams,
  formatINR,
  type MakingChargeType,
} from "../lib/pricing";
import {
  DEFAULT_DIAMOND_CUTS,
  formatCentsRange,
  quoteDiamondValue,
  type DiamondQualityLike,
} from "../lib/diamond-pricing";
import { deleteProductFromShopify, syncSingleProductToShopify } from "../lib/shopify-catalog.server";
import {
  readFormFile,
  uploadImageToShopifyFiles,
} from "../lib/shopify-files.server";
import {
  buildProductCsv,
  buildProductExcel,
  groupProductExcelRows,
  parseProductExcel,
  type ProductExportVariant,
} from "../lib/product-excel";
import { ALL_COLLECTIONS_NAME } from "../lib/collections";
import { ensureAllCollectionsCollection } from "../lib/seed.server";
import { htmlToPlainText, normalizeImageUrl } from "../lib/text";

type VariantDraft = {
  key: string;
  id?: string;
  metalId: string;
  purityId: string;
  metalColor: string;
  grossWeight: number;
  stoneIncluded: boolean;
  stoneType: string;
  stoneWeight: number;
  diamondCategory: string;
  diamondQualityId?: string | null;
  diamondCount: number;
  pricePerCarat: number;
  wastagePercent: number;
  makingChargeType: MakingChargeType;
  makingChargeValue: number;
  stoneRate: number;
  status: "Active" | "Draft";
  imagePreview?: string;
  existingImageUrl?: string;
  existingFileId?: string | null;
};

type ProductImageItem = {
  key: string;
  url: string;
  shopifyFileId: string | null;
  preview: string;
};

type ProductFormState = {
  sku: string;
  name: string;
  description: string;
  gender: string;
  collectionIds: string[];
  status: string;
};

function parseProductImages(
  imagesJson: string | null | undefined,
  fallbackUrl = "",
  fallbackFileId: string | null = null,
): Array<{ url: string; shopifyFileId: string | null }> {
  const dedupe = (
    items: Array<{ url: string; shopifyFileId: string | null }>,
  ) => {
    const seen = new Set<string>();
    const unique: Array<{ url: string; shopifyFileId: string | null }> = [];
    for (const item of items) {
      const key = normalizeImageUrl(item.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }
    return unique;
  };

  try {
    const parsed = JSON.parse(imagesJson || "[]") as Array<{
      url?: string;
      shopifyFileId?: string | null;
    }>;
    if (Array.isArray(parsed) && parsed.length) {
      return dedupe(
        parsed
          .filter((item) => item?.url)
          .map((item) => ({
            url: String(item.url),
            shopifyFileId: item.shopifyFileId ?? null,
          })),
      );
    }
  } catch {
    // ignore invalid json
  }
  if (fallbackUrl) {
    return [{ url: fallbackUrl, shopifyFileId: fallbackFileId }];
  }
  return [];
}

const emptyVariant = (metalId = "", purityId = "", metalColor = ""): VariantDraft => ({
  key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  metalId,
  purityId,
  metalColor,
  grossWeight: 0,
  stoneIncluded: false,
  stoneType: "Diamond",
  stoneWeight: 0,
  diamondCategory: "Round",
  diamondQualityId: "",
  diamondCount: 1,
  pricePerCarat: 0,
  wastagePercent: 5,
  makingChargeType: "percent",
  makingChargeValue: 10,
  stoneRate: 0,
  status: "Active",
  imagePreview: "",
  existingImageUrl: "",
  existingFileId: null,
});

const emptyProductForm = (collectionIds: string[] = []): ProductFormState => ({
  sku: "",
  name: "",
  description: "",
  gender: "Women",
  collectionIds,
  status: "Active",
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [settings, collections, metals, purities, products, diamondQualities] = await Promise.all([
    prisma.appSetting.findUnique({ where: { id: "default" } }),
    prisma.collection.findMany({
      include: { parent: true },
      orderBy: { name: "asc" },
    }),
    prisma.metalType.findMany({
      where: { status: "Active" },
      orderBy: { color: "asc" },
    }),
    prisma.purityLevel.findMany({
      include: { metal: true },
      orderBy: { karat: "asc" },
    }),
    prisma.product.findMany({
      include: {
        collections: true,
        variants: {
          include: {
            metal: true,
            purity: true,
            diamondQuality: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.diamondQuality.findMany({
      include: { slabs: { orderBy: { centsFrom: "asc" } } },
      orderBy: [{ color: "asc" }, { clarity: "asc" }],
    }),
  ]);

  const goldPricePerGram = settings?.goldPricePerGram ?? 6500;

  // De-duplicate products by SKU / shopifyProductId
  const seenSkus = new Map<string, (typeof products)[0]>();
  const duplicateProductIds: string[] = [];

  for (const p of products) {
    const key = p.sku.trim().toUpperCase();
    if (!seenSkus.has(key)) {
      seenSkus.set(key, p);
    } else {
      const existing = seenSkus.get(key)!;
      const existingWeight = existing.variants.reduce((sum, v) => sum + v.grossWeight, 0);
      const curWeight = p.variants.reduce((sum, v) => sum + v.grossWeight, 0);
      if (
        curWeight > existingWeight ||
        (curWeight === existingWeight && p.variants.length > existing.variants.length) ||
        (!existing.shopifyProductId && p.shopifyProductId)
      ) {
        duplicateProductIds.push(existing.id);
        seenSkus.set(key, p);
      } else {
        duplicateProductIds.push(p.id);
      }
    }
  }

  if (duplicateProductIds.length > 0) {
    prisma.product
      .deleteMany({ where: { id: { in: duplicateProductIds } } })
      .catch((e) => console.error("Error cleaning duplicate products:", e));
  }

  const uniqueProducts = Array.from(seenSkus.values());

  const catalog = uniqueProducts.map((product) => {
    const prices = product.variants.map((variant) =>
      calculateProductPrice({
        grossWeight: variant.grossWeight,
        stoneWeight: variant.stoneWeight,
        stoneIncluded: variant.stoneIncluded,
        stoneType: variant.stoneType,
        wastagePercent: variant.wastagePercent,
        makingChargeType: variant.makingChargeType as MakingChargeType,
        makingChargeValue: variant.makingChargeValue,
        stoneRate: variant.stoneRate,
        goldPricePerGram: variant.purity
          ? (goldPricePerGram / 0.916) * variant.purity.purityValue
          : goldPricePerGram,
      }).total,
    );

    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      description: htmlToPlainText(product.description),
      imageUrl: product.imageUrl,
      shopifyFileId: product.shopifyFileId,
      images: parseProductImages(
        product.imagesJson,
        product.imageUrl,
        product.shopifyFileId,
      ),
      gender: product.gender,
      collectionIds: product.collections.map((c) => c.id),
      collection: product.collections.map((c) => c.name).join(", ") || "—",
      status: product.status,
      synced: Boolean(product.shopifyProductId),
      variantCount: product.variants.length,
      fromPrice: prices.length ? Math.min(...prices) : 0,
      initials: product.name
        .split(" ")
        .slice(0, 2)
        .map((w) => w[0] ?? "")
        .join("")
        .toUpperCase(),
      variants: product.variants.map((variant) => ({
        id: variant.id,
        metalId: variant.metalId,
        purityId: variant.purityId,
        metalColor: variant.metalColor,
        grossWeight: variant.grossWeight,
        stoneIncluded: variant.stoneIncluded,
        stoneType: variant.stoneType,
        stoneWeight: variant.stoneWeight,
        diamondCategory: variant.diamondCategory,
        diamondQualityId: variant.diamondQualityId,
        diamondQualityName: variant.diamondQuality?.name || "",
        diamondCount: variant.diamondCount,
        pricePerCarat: variant.pricePerCarat,
        wastagePercent: variant.wastagePercent,
        makingChargeType: variant.makingChargeType as MakingChargeType,
        makingChargeValue: variant.makingChargeValue,
        stoneRate: variant.stoneRate,
        status: variant.status as "Active" | "Draft",
        imageUrl: variant.imageUrl,
        shopifyFileId: variant.shopifyFileId,
        purityLabel: variant.purity?.label || "",
        label: `${variant.metalColor} · ${variant.purity?.label || "22K"}`,
        price: calculateProductPrice({
          grossWeight: variant.grossWeight,
          stoneWeight: variant.stoneWeight,
          stoneIncluded: variant.stoneIncluded,
          stoneType: variant.stoneType,
          wastagePercent: variant.wastagePercent,
          makingChargeType: variant.makingChargeType as MakingChargeType,
          makingChargeValue: variant.makingChargeValue,
          stoneRate: variant.stoneRate,
          goldPricePerGram: variant.purity
            ? (goldPricePerGram / 0.916) * variant.purity.purityValue
            : goldPricePerGram,
        }).total,
      })),
    };
  });

  return { goldPricePerGram, collections, metals, purities, catalog, diamondQualities };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "delete") {
      const id = String(form.get("id") || "");
      const product = await prisma.product.findUnique({ where: { id } });
      if (!product) return { ok: false, message: "Product not found." };

      if (product.shopifyProductId) {
        await deleteProductFromShopify(admin.graphql, product.shopifyProductId);
      }
      await prisma.product.delete({ where: { id } });
      return { ok: true, message: "Product deleted from app and Shopify.", clearEdit: true };
    }

    if (intent === "import-product-excel") {
      const uploaded = form.get("excelFile");
      if (!(uploaded instanceof File) || uploaded.size === 0) {
        return { ok: false, message: "Choose an Excel file (.xlsx) to import products." };
      }

      const fileName = uploaded.name.toLowerCase();
      const rows = fileName.endsWith(".csv")
        ? parseProductExcel(await uploaded.text())
        : parseProductExcel(new Uint8Array(await uploaded.arrayBuffer()));

      if (!rows.length) {
        return { ok: false, message: "No product rows found in the Excel file." };
      }

      const [metals, purities, collections, diamondQualities, existingProducts] =
        await Promise.all([
          prisma.metalType.findMany(),
          prisma.purityLevel.findMany({ include: { metal: true } }),
          prisma.collection.findMany(),
          prisma.diamondQuality.findMany({ include: { slabs: true } }),
          prisma.product.findMany({ select: { sku: true } }),
        ]);

      const existingSkus = new Set(
        existingProducts.map((p) => p.sku.trim().toLowerCase()),
      );
      const metalByColor = new Map(
        metals.map((m) => [m.color.trim().toLowerCase(), m]),
      );
      const purityByKey = new Map(
        purities.map((p) => [
          `${p.metal.color.trim().toLowerCase()}|${p.label.trim().toLowerCase()}`,
          p,
        ]),
      );
      const purityByLabel = new Map(
        purities.map((p) => [p.label.trim().toLowerCase(), p]),
      );
      const collectionByName = new Map(
        collections.map((c) => [c.name.trim().toLowerCase(), c]),
      );
      const qualityByName = new Map(
        diamondQualities.map((q) => [q.name.trim().toLowerCase(), q]),
      );

      const grouped = groupProductExcelRows(rows);
      let created = 0;
      let skipped = 0;
      let variantsCreated = 0;
      const syncFailures: string[] = [];

      for (const [, productRows] of grouped) {
        const first = productRows[0];
        const sku = first.sku.trim();
        const name = first.name.trim() || sku;
        if (!sku) {
          skipped += 1;
          continue;
        }
        if (existingSkus.has(sku.toLowerCase())) {
          skipped += 1;
          continue;
        }

        const variantCreateData: Array<{
          metalId: string;
          purityId: string;
          metalColor: string;
          grossWeight: number;
          stoneIncluded: boolean;
          stoneType: string;
          stoneWeight: number;
          diamondCategory: string;
          diamondQualityId: string | null;
          diamondCount: number;
          pricePerCarat: number;
          wastagePercent: number;
          makingChargeType: string;
          makingChargeValue: number;
          stoneRate: number;
          status: string;
        }> = [];

        let rowFailed = false;
        const seenVariantKeys = new Set<string>();

        for (const row of productRows) {
          const metal =
            metalByColor.get(row.metalColor.toLowerCase()) ||
            metals.find(
              (m) => m.name.trim().toLowerCase() === row.metalColor.toLowerCase(),
            );
          if (!metal) {
            skipped += 1;
            rowFailed = true;
            break;
          }

          const purity =
            purityByKey.get(
              `${metal.color.trim().toLowerCase()}|${row.purityLabel.trim().toLowerCase()}`,
            ) || purityByLabel.get(row.purityLabel.trim().toLowerCase());
          if (!purity) {
            skipped += 1;
            rowFailed = true;
            break;
          }

          if (!(row.grossWeight > 0)) {
            skipped += 1;
            rowFailed = true;
            break;
          }

          const variantKey = `${metal.id}|${purity.id}|${metal.color}`;
          if (seenVariantKeys.has(variantKey)) {
            continue;
          }
          seenVariantKeys.add(variantKey);

          const stoneIncluded = Boolean(
            row.stoneIncluded ||
              (row.stoneType && row.stoneType !== "None" && row.stoneWeight > 0),
          );
          const stoneType = stoneIncluded
            ? row.stoneType && row.stoneType !== "None"
              ? row.stoneType
              : "Diamond"
            : "None";

          let diamondQualityId: string | null = null;
          let pricePerCarat = 0;
          let stoneRate = stoneIncluded ? Number(row.stoneRate) || 0 : 0;
          let diamondCount = 1;
          let diamondCategory = "";

          if (stoneIncluded && stoneType === "Diamond") {
            const quality = qualityByName.get(row.diamondQuality.trim().toLowerCase());
            if (!quality) {
              skipped += 1;
              rowFailed = true;
              break;
            }
            const quote = quoteDiamondValue({
              totalCarat: Number(row.stoneWeight) || 0,
              diamondCount: Number(row.diamondCount) || 1,
              quality: {
                id: quality.id,
                name: quality.name,
                color: quality.color,
                clarity: quality.clarity,
                slabs: quality.slabs,
              },
            });
            if (!quote.ok) {
              skipped += 1;
              rowFailed = true;
              break;
            }
            diamondQualityId = quality.id;
            pricePerCarat = quote.pricePerCarat;
            stoneRate = quote.diamondValue;
            diamondCount = quote.diamondCount;
            diamondCategory = row.diamondCut || "Round";
          }

          variantCreateData.push({
            metalId: metal.id,
            purityId: purity.id,
            metalColor: metal.color,
            grossWeight: Number(row.grossWeight) || 0,
            stoneIncluded,
            stoneType,
            stoneWeight: stoneIncluded ? Number(row.stoneWeight) || 0 : 0,
            diamondCategory,
            diamondQualityId,
            diamondCount,
            pricePerCarat,
            wastagePercent: Number(row.wastagePercent) || 0,
            makingChargeType: row.makingChargeType === "fixed" ? "fixed" : "percent",
            makingChargeValue: Number(row.makingChargeValue) || 0,
            stoneRate,
            status: row.variantStatus === "Draft" ? "Draft" : "Active",
          });
        }

        if (rowFailed || !variantCreateData.length) {
          continue;
        }

        const collectionIds = first.collections
          .split(/[,|;]/)
          .map((part) => part.trim())
          .filter(Boolean)
          .map((namePart) => collectionByName.get(namePart.toLowerCase())?.id)
          .filter((id): id is string => Boolean(id));

        const allCollections = await ensureAllCollectionsCollection();
        const mergedIds = Array.from(new Set([...collectionIds, allCollections.id]));

        const createdProduct = await prisma.product.create({
          data: {
            sku,
            name,
            description: first.description || "",
            gender: first.gender || "Unisex",
            status: first.status === "Draft" ? "Draft" : "Active",
            variants: { create: variantCreateData },
            collections: {
              connect: mergedIds.map((id) => ({ id })),
            },
          },
        });

        existingSkus.add(sku.toLowerCase());
        created += 1;
        variantsCreated += variantCreateData.length;

        try {
          await syncSingleProductToShopify(createdProduct.id, admin.graphql);
        } catch {
          syncFailures.push(sku);
        }
      }

      const syncNote = syncFailures.length
        ? ` ${syncFailures.length} product${syncFailures.length === 1 ? "" : "s"} saved but failed Shopify sync — use Sync to Shopify.`
        : "";

      return {
        ok: true,
        message: `Import finished. Created ${created} product${created === 1 ? "" : "s"} (${variantsCreated} variant${variantsCreated === 1 ? "" : "s"}), skipped ${skipped} duplicate/invalid row group${skipped === 1 ? "" : "s"}.${syncNote}`,
      };
    }

    if (intent !== "create" && intent !== "update") {
      return { ok: false, message: "Unknown action." };
    }

    const editingId = String(form.get("productId") || "") || null;
    if (intent === "update" && !editingId) {
      return { ok: false, message: "Missing product id for update." };
    }

    const sku = String(form.get("sku") || "").trim();
    const name = String(form.get("name") || "").trim();
    const description = htmlToPlainText(String(form.get("description") || "").trim());
    const gender = String(form.get("gender") || "Unisex");
    const collectionIds = form.getAll("collectionIds").map(String);
    const status = String(form.get("status") || "Active");
    const variantsRaw = String(form.get("variantsJson") || "[]");

    if (!sku || !name) {
      return { ok: false, message: "SKU and product name are required." };
    }

    const allCollections = await ensureAllCollectionsCollection();
    const mergedCollectionIds = Array.from(
      new Set([...collectionIds.filter(Boolean), allCollections.id]),
    );

    let drafts: VariantDraft[] = [];
    try {
      drafts = JSON.parse(variantsRaw) as VariantDraft[];
    } catch {
      return { ok: false, message: "Invalid variant data." };
    }

    if (!drafts.length) {
      const defaultMetal =
        (await prisma.metalType.findFirst({ where: { status: "Active" } })) ||
        (await prisma.metalType.findFirst());
      const defaultPurity = defaultMetal
        ? await prisma.purityLevel.findFirst({ where: { metalId: defaultMetal.id } })
        : await prisma.purityLevel.findFirst();
      if (defaultMetal && defaultPurity) {
        drafts = [
          {
            key: "default-1",
            metalId: defaultMetal.id,
            purityId: defaultPurity.id,
            metalColor: defaultMetal.color || defaultMetal.name,
            grossWeight: 0,
            stoneIncluded: false,
            stoneType: "None",
            stoneWeight: 0,
            diamondCategory: "",
            diamondCount: 1,
            pricePerCarat: 0,
            wastagePercent: 5,
            makingChargeType: "percent",
            makingChargeValue: 10,
            stoneRate: 0,
            status: "Active",
          },
        ];
      }
    }

    const existingImages = parseProductImages(
      String(form.get("existingImagesJson") || "[]"),
    );

    const productImages: Array<{ url: string; shopifyFileId: string | null }> = [
      ...existingImages,
    ];
    const seenUploadUrls = new Set(
      productImages.map((image) => normalizeImageUrl(image.url)).filter(Boolean),
    );

    const productImageKeys = [...form.keys()].filter((key) =>
      String(key).startsWith("productImage_"),
    );
    for (const key of productImageKeys) {
      const file = await readFormFile(form, key);
      if (!file) {
        return {
          ok: false,
          message: "Could not read a product image upload. Please re-select the images and save again.",
        };
      }
      const uploaded = await uploadImageToShopifyFiles(admin.graphql, file, name);
      const uploadedKey = normalizeImageUrl(uploaded.url);
      if (uploadedKey && seenUploadUrls.has(uploadedKey)) continue;
      if (uploadedKey) seenUploadUrls.add(uploadedKey);
      productImages.push({
        url: uploaded.url,
        shopifyFileId: uploaded.fileId,
      });
    }

    const imageUrl = productImages[0]?.url || "";
    const shopifyFileId = productImages[0]?.shopifyFileId || null;
    const imagesJson = JSON.stringify(productImages);

    const variantAssets: Array<{ imageUrl: string; shopifyFileId: string | null }> =
      [];
    for (let i = 0; i < drafts.length; i += 1) {
      const file = await readFormFile(form, `variantImage_${i}`);
      if (file) {
        const uploaded = await uploadImageToShopifyFiles(
          admin.graphql,
          file,
          `${name} ${drafts[i].metalColor}`,
        );
        variantAssets.push({
          imageUrl: uploaded.url,
          shopifyFileId: uploaded.fileId,
        });
      } else {
        variantAssets.push({
          imageUrl: drafts[i].existingImageUrl || "",
          shopifyFileId: drafts[i].existingFileId || null,
        });
      }
    }

    const diamondQualities = await prisma.diamondQuality.findMany({
      include: { slabs: true },
    });

    const quotedDrafts: Array<
      VariantDraft & { quotedStoneRate: number; quotedPricePerCarat: number }
    > = [];
    for (const draft of drafts) {
      if (!(draft.stoneIncluded && draft.stoneType === "Diamond")) {
        quotedDrafts.push({
          ...draft,
          quotedStoneRate: Number(draft.stoneRate) || 0,
          quotedPricePerCarat: 0,
        });
        continue;
      }

      const quality = diamondQualities.find((item) => item.id === draft.diamondQualityId);
      const quote = quoteDiamondValue({
        totalCarat: Number(draft.stoneWeight) || 0,
        diamondCount: Number(draft.diamondCount) || 0,
        quality: quality
          ? {
              id: quality.id,
              name: quality.name,
              color: quality.color,
              clarity: quality.clarity,
              slabs: quality.slabs,
            }
          : null,
      });
      if (!quote.ok) {
        return { ok: false, message: quote.message };
      }
      quotedDrafts.push({
        ...draft,
        diamondCount: quote.diamondCount,
        quotedStoneRate: quote.diamondValue,
        quotedPricePerCarat: quote.pricePerCarat,
      });
    }

    const variantCreateData = quotedDrafts.map((draft, index) => ({
      metalId: draft.metalId,
      purityId: draft.purityId,
      metalColor: draft.metalColor,
      grossWeight: Number(draft.grossWeight) || 0,
      stoneIncluded: Boolean(draft.stoneIncluded),
      stoneType: draft.stoneIncluded ? draft.stoneType : "None",
      stoneWeight: draft.stoneIncluded ? Number(draft.stoneWeight) || 0 : 0,
      diamondCategory:
        draft.stoneIncluded && draft.stoneType === "Diamond" ? draft.diamondCategory : "",
      diamondQualityId:
        draft.stoneIncluded && draft.stoneType === "Diamond" ? draft.diamondQualityId || null : null,
      diamondCount:
        draft.stoneIncluded && draft.stoneType === "Diamond" ? Number(draft.diamondCount) || 1 : 1,
      pricePerCarat:
        draft.stoneIncluded && draft.stoneType === "Diamond" ? draft.quotedPricePerCarat : 0,
      wastagePercent: Number(draft.wastagePercent) || 0,
      makingChargeType: draft.makingChargeType,
      makingChargeValue: Number(draft.makingChargeValue) || 0,
      stoneRate: draft.quotedStoneRate,
      imageUrl: variantAssets[index]?.imageUrl || "",
      shopifyFileId: variantAssets[index]?.shopifyFileId || null,
      status: draft.status,
    }));

    let productId = editingId;

    if (intent === "update" && editingId) {
      const current = await prisma.product.findUnique({
        where: { id: editingId },
        include: { variants: true },
      });
      if (!current) return { ok: false, message: "Product not found." };

      const currentVariantMap = new Map(current.variants.map((v) => [v.id, v]));
      const keptVariantIds: string[] = [];

      for (let i = 0; i < quotedDrafts.length; i++) {
        const draft = quotedDrafts[i];
        const vData = variantCreateData[i];
        if (draft.id && currentVariantMap.has(draft.id)) {
          keptVariantIds.push(draft.id);
          await prisma.productVariant.update({
            where: { id: draft.id },
            data: {
              metalId: vData.metalId,
              purityId: vData.purityId,
              metalColor: vData.metalColor,
              grossWeight: vData.grossWeight,
              stoneIncluded: vData.stoneIncluded,
              stoneType: vData.stoneType,
              stoneWeight: vData.stoneWeight,
              diamondCategory: vData.diamondCategory,
              diamondQualityId: vData.diamondQualityId,
              diamondCount: vData.diamondCount,
              pricePerCarat: vData.pricePerCarat,
              wastagePercent: vData.wastagePercent,
              makingChargeType: vData.makingChargeType,
              makingChargeValue: vData.makingChargeValue,
              stoneRate: vData.stoneRate,
              status: vData.status,
              ...(vData.imageUrl ? { imageUrl: vData.imageUrl, shopifyFileId: vData.shopifyFileId } : {}),
            },
          });
        } else {
          const createdV = await prisma.productVariant.create({
            data: {
              productId: editingId,
              ...vData,
            },
          });
          keptVariantIds.push(createdV.id);
        }
      }

      if (keptVariantIds.length > 0) {
        await prisma.productVariant.deleteMany({
          where: {
            productId: editingId,
            id: { notIn: keptVariantIds },
          },
        });
      }

      await prisma.product.update({
        where: { id: editingId },
        data: {
          sku,
          name,
          description,
          imageUrl,
          shopifyFileId,
          imagesJson,
          gender,
          status,
          collections: {
            set: mergedCollectionIds.map((id) => ({ id })),
          },
        },
      });
    } else {
      const created = await prisma.product.create({
        data: {
          sku,
          name,
          description,
          imageUrl,
          shopifyFileId,
          imagesJson,
          gender,
          status,
          variants: { create: variantCreateData },
          collections: {
            connect: mergedCollectionIds.map((id) => ({ id })),
          },
        },
      });
      productId = created.id;
    }

    // Sync to Shopify automatically!
    try {
      await syncSingleProductToShopify(productId!, admin.graphql);
    } catch (syncErr) {
      console.error("[Product Action] Auto-sync failed:", syncErr);
      return {
        ok: true,
        message: `"${name}" saved locally, but failed to sync to Shopify: ${syncErr instanceof Error ? syncErr.message : "unknown error"}.`,
        clearEdit: true,
        productId,
      };
    }

    return {
      ok: true,
      message:
        intent === "update"
          ? `"${name}" updated and synced to Shopify.`
          : `"${name}" created and synced to Shopify.`,
      clearEdit: true,
      productId,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Something went wrong.",
    };
  }
};

export default function ProductsPage() {
  const { goldPricePerGram, collections, metals, purities, catalog, diamondQualities } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [searchParams, setSearchParams] = useSearchParams();
  const busy = navigation.state !== "idle";
  const view = searchParams.get("view") === "catalog" ? "catalog" : "edit";
  const showForm = view === "edit";
  const editIdFromUrl = searchParams.get("id");

  const firstMetal = metals[0];
  const firstPurity =
    purities.find((p) => p.metalId === firstMetal?.id) ?? purities[0];

  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [productForm, setProductForm] = useState<ProductFormState>(
    emptyProductForm([]),
  );
  const [productImages, setProductImages] = useState<ProductImageItem[]>([]);
  const [variants, setVariants] = useState<VariantDraft[]>([]);
  const [variantForm, setVariantForm] = useState<VariantDraft>(
    emptyVariant(firstMetal?.id ?? "", firstPurity?.id ?? "", firstMetal?.color ?? ""),
  );
  const [draftPreview, setDraftPreview] = useState("");
  const [editingVariantKey, setEditingVariantKey] = useState<string | null>(null);
  const [productFileMap, setProductFileMap] = useState<Record<string, File>>({});
  const [variantFileMap, setVariantFileMap] = useState<Record<string, File>>({});
  const [draftFile, setDraftFile] = useState<File | null>(null);
  const productImageInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedCollections, setSelectedCollections] = useState<Array<{ id: string; name: string }>>([]);
  const [collectionSelectVal, setCollectionSelectVal] = useState("");
  const hydratedEditIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (actionData && "clearEdit" in actionData && actionData.clearEdit && actionData.ok) {
      resetForm();
      hydratedEditIdRef.current = null;
      setSearchParams({ view: "catalog" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  const exportRows = useMemo((): ProductExportVariant[] => {
    return catalog.flatMap((product) =>
      product.variants.map((variant) => ({
        sku: product.sku,
        name: product.name,
        description: product.description,
        gender: product.gender,
        collections: product.collection === "—" ? "" : product.collection,
        status: product.status,
        metalColor: variant.metalColor,
        purityLabel: variant.purityLabel || "",
        grossWeight: variant.grossWeight,
        wastagePercent: variant.wastagePercent,
        makingChargeType: variant.makingChargeType,
        makingChargeValue: variant.makingChargeValue,
        stoneIncluded: variant.stoneIncluded,
        stoneType: variant.stoneType,
        stoneWeight: variant.stoneWeight,
        stoneRate: variant.stoneRate,
        diamondCount: variant.diamondCount || 1,
        diamondQuality: variant.diamondQualityName || "",
        diamondCut: variant.diamondCategory || "",
        variantStatus: variant.status,
      })),
    );
  }, [catalog]);

  const excelLookups = useMemo(
    () => ({
      metals: metals.map((m) => ({ color: m.color })),
      purities: purities.map((p) => ({
        label: p.label,
        metalColor: p.metal?.color || "",
      })),
      collections: collections.map((c) => ({ name: c.name })),
      diamondQualities: diamondQualities.map((q) => ({ name: q.name })),
    }),
    [metals, purities, collections, diamondQualities],
  );

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const downloadProductExcel = () => {
    const buffer = buildProductExcel(exportRows, excelLookups);
    triggerDownload(
      new Blob([new Uint8Array(buffer)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "konika-products.xlsx",
    );
  };

  const downloadProductCsv = () => {
    triggerDownload(
      new Blob([buildProductCsv(exportRows)], { type: "text/csv;charset=utf-8;" }),
      "konika-products.csv",
    );
  };

  const downloadProductTemplate = () => {
    const buffer = buildProductExcel([], excelLookups);
    triggerDownload(
      new Blob([new Uint8Array(buffer)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "konika-products-template.xlsx",
    );
  };

  const availablePurities = useMemo(
    () => purities.filter((p) => p.metalId === variantForm.metalId),
    [purities, variantForm.metalId],
  );

  const selectedPurity = useMemo(
    () => purities.find((p) => p.id === variantForm.purityId),
    [purities, variantForm.purityId],
  );

  const adjustedGoldPrice = useMemo(
    () => (selectedPurity ? (goldPricePerGram / 0.916) * selectedPurity.purityValue : goldPricePerGram),
    [selectedPurity, goldPricePerGram],
  );

  const selectedDiamondQuality = useMemo(
    () => diamondQualities.find((item) => item.id === variantForm.diamondQualityId) ?? null,
    [diamondQualities, variantForm.diamondQualityId],
  );

  const diamondQuote = useMemo(
    () =>
      quoteDiamondValue({
        totalCarat: variantForm.stoneWeight,
        diamondCount: variantForm.diamondCount,
        quality: selectedDiamondQuality as DiamondQualityLike | null,
      }),
    [variantForm.stoneWeight, variantForm.diamondCount, selectedDiamondQuality],
  );

  const quotedStoneRate =
    variantForm.stoneIncluded && variantForm.stoneType === "Diamond"
      ? diamondQuote.ok
        ? diamondQuote.diamondValue
        : 0
      : variantForm.stoneRate;
  const quotedPricePerCarat =
    variantForm.stoneIncluded && variantForm.stoneType === "Diamond" && diamondQuote.ok
      ? diamondQuote.pricePerCarat
      : variantForm.pricePerCarat;

  const preview = useMemo(
    () =>
      calculateProductPrice({
        grossWeight: variantForm.grossWeight,
        stoneWeight: variantForm.stoneWeight,
        stoneIncluded: variantForm.stoneIncluded,
        stoneType: variantForm.stoneType,
        wastagePercent: variantForm.wastagePercent,
        makingChargeType: variantForm.makingChargeType,
        makingChargeValue: variantForm.makingChargeValue,
        stoneRate: quotedStoneRate,
        goldPricePerGram: adjustedGoldPrice,
      }),
    [variantForm, adjustedGoldPrice, quotedStoneRate],
  );

  const variantsForSave = useMemo(() => {
    // While editing an existing list item, show the live form values in that row.
    if (editingVariantKey) {
      return variants.map((v) =>
        v.key === editingVariantKey
            ? {
                ...variantForm,
                stoneRate: quotedStoneRate,
                pricePerCarat: quotedPricePerCarat,
                key: v.key,
              id: v.id,
              imagePreview: draftPreview || variantForm.imagePreview || v.imagePreview,
              existingImageUrl: variantForm.existingImageUrl || v.existingImageUrl,
              existingFileId: variantForm.existingFileId ?? v.existingFileId,
            }
          : v,
      );
    }

    const list = [...variants];
    const canIncludeDraft =
      Number(variantForm.grossWeight) > 0 &&
      Boolean(variantForm.metalId) &&
      Boolean(variantForm.purityId) &&
      !list.some(
        (v) =>
          v.metalId === variantForm.metalId &&
          v.purityId === variantForm.purityId &&
          v.metalColor === variantForm.metalColor,
      );
    if (canIncludeDraft) {
      list.push({
        ...variantForm,
        stoneRate: quotedStoneRate,
        pricePerCarat: quotedPricePerCarat,
        key: emptyVariant().key,
        imagePreview: draftPreview || variantForm.imagePreview,
      });
    }
    return list;
  }, [
    variants,
    variantForm,
    draftPreview,
    editingVariantKey,
    quotedStoneRate,
    quotedPricePerCarat,
  ]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.collection.toLowerCase().includes(q),
    );
  }, [catalog, search]);

  const allCollectionsEntry = useMemo(
    () => collections.find((c) => c.name === ALL_COLLECTIONS_NAME) ?? null,
    [collections],
  );

  // New-product form: always pre-select ALL Collections
  useEffect(() => {
    if (editingId) return;
    if (!allCollectionsEntry) return;
    setSelectedCollections((prev) =>
      prev.some((c) => c.id === allCollectionsEntry.id)
        ? prev
        : [{ id: allCollectionsEntry.id, name: allCollectionsEntry.name }, ...prev],
    );
  }, [allCollectionsEntry, editingId]);

  function resetForm() {
    setEditingId(null);
    setEditingVariantKey(null);
    setProductForm(emptyProductForm());
    setSelectedCollections(
      allCollectionsEntry
        ? [{ id: allCollectionsEntry.id, name: allCollectionsEntry.name }]
        : [],
    );
    setCollectionSelectVal("");
    setProductImages([]);
    setVariants([]);
    setVariantForm(
      emptyVariant(firstMetal?.id ?? "", firstPurity?.id ?? "", firstMetal?.color ?? ""),
    );
    setDraftPreview("");
    setDraftFile(null);
    setProductFileMap({});
    setVariantFileMap({});
    if (productImageInputRef.current) productImageInputRef.current.value = "";
  }

  const clearVariantEditor = (keepMetal = true) => {
    setEditingVariantKey(null);
    setDraftFile(null);
    setDraftPreview("");
    setVariantForm((current) =>
      keepMetal
        ? {
            ...emptyVariant(current.metalId, current.purityId, current.metalColor),
            wastagePercent: current.wastagePercent,
            makingChargeType: current.makingChargeType,
            makingChargeValue: current.makingChargeValue,
          }
        : emptyVariant(firstMetal?.id ?? "", firstPurity?.id ?? "", firstMetal?.color ?? ""),
    );
  };

  const startCreate = () => {
    resetForm();
    hydratedEditIdRef.current = null;
    setSearchParams({ view: "edit" });
  };

  const startEdit = (productId: string) => {
    const product = catalog.find((p) => p.id === productId);
    if (!product) return;

    setEditingId(product.id);
    hydratedEditIdRef.current = product.id;
    setEditingVariantKey(null);
    setProductForm({
      sku: product.sku,
      name: product.name,
      description: htmlToPlainText(product.description),
      gender: product.gender,
      collectionIds: product.collectionIds,
      status: product.status,
    });
    const selectedColls = product.collectionIds
      .map((id) => {
        const coll = collections.find((c) => c.id === id);
        return { id, name: coll?.name ?? "Unknown" };
      })
      .filter((c) => c.id);
    if (
      allCollectionsEntry &&
      !selectedColls.some((c) => c.id === allCollectionsEntry.id)
    ) {
      selectedColls.unshift({
        id: allCollectionsEntry.id,
        name: allCollectionsEntry.name,
      });
    }
    setSelectedCollections(selectedColls);
    setCollectionSelectVal("");
    setProductImages(
      product.images.map((image, index) => ({
        key: `saved-${index}-${normalizeImageUrl(image.url).slice(-18) || index}`,
        url: image.url,
        shopifyFileId: image.shopifyFileId,
        preview: image.url,
      })),
    );
    setProductFileMap({});
    setVariantFileMap({});
    setDraftFile(null);
    if (productImageInputRef.current) productImageInputRef.current.value = "";

    const mappedVariants = product.variants.map((variant) => ({
      key: variant.id,
      id: variant.id,
      metalId: variant.metalId,
      purityId: variant.purityId,
      metalColor: variant.metalColor,
      grossWeight: Number(variant.grossWeight) || 0,
      stoneIncluded: Boolean(variant.stoneIncluded),
      stoneType: variant.stoneType || "Diamond",
      stoneWeight: Number(variant.stoneWeight) || 0,
      diamondCategory: variant.diamondCategory || "Round",
      diamondQualityId: variant.diamondQualityId || "",
      diamondCount: Number(variant.diamondCount) || 1,
      pricePerCarat: Number(variant.pricePerCarat) || 0,
      wastagePercent: Number(variant.wastagePercent) || 0,
      makingChargeType: variant.makingChargeType,
      makingChargeValue: Number(variant.makingChargeValue) || 0,
      stoneRate: Number(variant.stoneRate) || 0,
      status: variant.status,
      imagePreview: variant.imageUrl || "",
      existingImageUrl: variant.imageUrl || "",
      existingFileId: variant.shopifyFileId,
    }));
    setVariants(mappedVariants);

    const firstVariant = mappedVariants[0];
    if (firstVariant) {
      setEditingVariantKey(firstVariant.key);
      setVariantForm({
        ...firstVariant,
        imagePreview: firstVariant.imagePreview || firstVariant.existingImageUrl || "",
      });
      setDraftPreview(firstVariant.imagePreview || firstVariant.existingImageUrl || "");
    } else {
      setEditingVariantKey(null);
      setVariantForm(
        emptyVariant(
          firstMetal?.id || "",
          firstPurity?.id || "",
          firstMetal?.color || "",
        ),
      );
      setDraftPreview("");
    }
    setSearchParams({ view: "edit", id: product.id });
  };

  // Open edit form when arriving from dashboard (or deep link) with ?id=
  useEffect(() => {
    if (view !== "edit" || !editIdFromUrl) return;
    if (hydratedEditIdRef.current === editIdFromUrl && editingId === editIdFromUrl) return;
    if (!catalog.some((p) => p.id === editIdFromUrl)) return;
    startEdit(editIdFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, editIdFromUrl, catalog]);

  const startEditVariant = (variant: VariantDraft) => {
    setEditingVariantKey(variant.key);
    setVariantForm({
      ...variant,
      imagePreview: variant.imagePreview || variant.existingImageUrl || "",
    });
    setDraftPreview(variant.imagePreview || variant.existingImageUrl || "");
    setDraftFile(variantFileMap[variant.key] ?? null);
  };

  const onMetalChange = (metalId: string) => {
    const metal = metals.find((m) => m.id === metalId);
    const nextPurity = purities.find((p) => p.metalId === metalId);
    setVariantForm((current) => ({
      ...current,
      metalId,
      metalColor: metal?.color ?? current.metalColor,
      purityId: nextPurity?.id ?? "",
    }));
  };

  const saveVariantToList = () => {
    if (!variantForm.metalId || !variantForm.purityId) return;
    if (!(Number(variantForm.grossWeight) > 0)) return;
    if (variantForm.stoneIncluded && variantForm.stoneType === "Diamond" && !diamondQuote.ok) return;

    const variantFormQuoted = {
      ...variantForm,
      stoneRate: quotedStoneRate,
      pricePerCarat: quotedPricePerCarat,
    };

    const duplicate = variants.some(
      (v) =>
        v.key !== editingVariantKey &&
        v.metalId === variantForm.metalId &&
        v.purityId === variantForm.purityId &&
        v.metalColor === variantForm.metalColor,
    );
    if (duplicate) return;

    if (editingVariantKey) {
      if (draftFile) {
        setVariantFileMap((current) => ({ ...current, [editingVariantKey]: draftFile }));
      }
      setVariants((current) =>
        current.map((v) =>
          v.key === editingVariantKey
            ? {
                ...variantFormQuoted,
                key: editingVariantKey,
                id: v.id,
                imagePreview:
                  draftPreview ||
                  variantForm.imagePreview ||
                  v.existingImageUrl ||
                  "",
                existingImageUrl: v.existingImageUrl || variantForm.existingImageUrl || "",
                existingFileId: v.existingFileId ?? variantForm.existingFileId ?? null,
              }
            : v,
        ),
      );
      clearVariantEditor(true);
      return;
    }

    const key = emptyVariant().key;
    if (draftFile) {
      setVariantFileMap((current) => ({ ...current, [key]: draftFile }));
    }

    setVariants((current) => [
      ...current,
      {
        ...variantFormQuoted,
        key,
        imagePreview: draftPreview || "",
      },
    ]);
    clearVariantEditor(true);
  };

  const handleSaveSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    fd.set("intent", editingId ? "update" : "create");
    if (editingId) fd.set("productId", editingId);

    const keptImages = productImages
      .filter((image) => image.url)
      .map((image) => ({
        url: image.url,
        shopifyFileId: image.shopifyFileId,
      }));
    fd.set("existingImagesJson", JSON.stringify(keptImages));

    const nextVariantFiles: Record<string, File> = { ...variantFileMap };

    // Commit any in-progress variant edit before save.
    let list = [...variants];
    if (editingVariantKey) {
      if (!(Number(variantForm.grossWeight) > 0)) return;
      if (variantForm.stoneIncluded && variantForm.stoneType === "Diamond" && !diamondQuote.ok) return;
      if (draftFile) nextVariantFiles[editingVariantKey] = draftFile;
      list = list.map((v) =>
        v.key === editingVariantKey
          ? {
              ...variantForm,
              stoneRate: quotedStoneRate,
              pricePerCarat: quotedPricePerCarat,
              key: editingVariantKey,
              id: v.id,
              imagePreview: draftPreview || variantForm.imagePreview || v.existingImageUrl || "",
              existingImageUrl: v.existingImageUrl || variantForm.existingImageUrl || "",
              existingFileId: v.existingFileId ?? variantForm.existingFileId ?? null,
            }
          : v,
      );
    } else {
      const canIncludeDraft =
        Number(variantForm.grossWeight) > 0 &&
        Boolean(variantForm.metalId) &&
        Boolean(variantForm.purityId) &&
        !list.some(
          (v) =>
            v.metalId === variantForm.metalId &&
            v.purityId === variantForm.purityId &&
            v.metalColor === variantForm.metalColor,
        );
      if (
        canIncludeDraft &&
        !(variantForm.stoneIncluded && variantForm.stoneType === "Diamond" && !diamondQuote.ok)
      ) {
        const draftKey = emptyVariant().key;
        list.push({
          ...variantForm,
          stoneRate: quotedStoneRate,
          pricePerCarat: quotedPricePerCarat,
          key: draftKey,
          imagePreview: draftPreview || variantForm.imagePreview || "",
        });
        if (draftFile) nextVariantFiles[draftKey] = draftFile;
      }
    }

    if (!list.length) {
      const draftKey = emptyVariant().key;
      list.push({
        ...variantForm,
        metalId: variantForm.metalId || firstMetal?.id || "",
        purityId: variantForm.purityId || firstPurity?.id || "",
        metalColor: variantForm.metalColor || firstMetal?.color || "",
        grossWeight: Number(variantForm.grossWeight) || 0,
        stoneRate: quotedStoneRate || 0,
        pricePerCarat: quotedPricePerCarat || 0,
        key: draftKey,
        imagePreview: draftPreview || variantForm.imagePreview || "",
      });
      if (draftFile) nextVariantFiles[draftKey] = draftFile;
    }

    fd.set(
      "variantsJson",
      JSON.stringify(list.map(({ imagePreview: _p, ...rest }) => rest)),
    );

    let newImageIndex = 0;
    let attachedProductFiles = 0;
    productImages.forEach((image) => {
      const file = productFileMap[image.key];
      if (file) {
        fd.set(`productImage_${newImageIndex}`, file);
        newImageIndex += 1;
        attachedProductFiles += 1;
      }
    });

    let attachedVariantFiles = 0;
    list.forEach((variant, index) => {
      const file = nextVariantFiles[variant.key];
      if (file) {
        fd.set(`variantImage_${index}`, file);
        attachedVariantFiles += 1;
      }
    });

    const pendingProductPreviews = productImages.filter((image) => !image.url).length;
    if (pendingProductPreviews > 0 && attachedProductFiles === 0) {
      window.alert("Product images were selected but not attached. Please re-select the images and save again.");
      return;
    }
    const pendingVariantPreviews = list.filter(
      (variant) => variant.imagePreview && !variant.existingImageUrl && !nextVariantFiles[variant.key],
    ).length;
    if (pendingVariantPreviews > 0 && attachedVariantFiles === 0) {
      window.alert("Variant images were selected but not attached. Please re-select each variant image and save again.");
      return;
    }

    submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">
            {showForm ? (editingId ? "Edit product" : "Add product") : "Products"}
          </h2>
          <p className="page-sub">
            {showForm
              ? editingId
                ? "Update details, images, and variants, then sync to Shopify."
                : "Add images and metal variants, save, then sync to Shopify."
              : `${filteredCatalog.length} product${filteredCatalog.length === 1 ? "" : "s"} in the catalog`}
          </p>
        </div>
        <div className="head-actions">
          {showForm ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                resetForm();
                hydratedEditIdRef.current = null;
                setSearchParams({ view: "catalog" });
              }}
            >
              View catalog
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={downloadProductTemplate}>
                Excel template
              </button>
              <button type="button" className="btn" onClick={downloadProductExcel}>
                Export Excel
              </button>
              <button type="button" className="btn primary" onClick={startCreate}>
                Add product
              </button>
            </>
          )}
        </div>
      </div>

              {actionData?.message ? (
        <div className={`flash ${actionData.ok ? "ok" : "err"}`} role="status">{actionData.message}</div>
      ) : null}

      {showForm ? (
        <Form method="post" encType="multipart/form-data" onSubmit={handleSaveSubmit}>
          <div className="form-grid">
            <div>
              <div className="panel">
                {editingId ? (
                  <div className="hint" style={{ marginBottom: 12 }}>
                    Editing existing product — change any field below, then Save. Use Sync all to push.
                  </div>
                ) : null}
                <div className="field">
                  <label>Product name</label>
                  <input
                    name="name"
                    value={productForm.name}
                    onChange={(e) =>
                      setProductForm((c) => ({ ...c, name: e.target.value }))
                    }
                    placeholder="e.g. 22K Gold Solitaire Ring"
                    required
                  />
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>SKU</label>
                    <input
                      name="sku"
                      className="mono"
                      value={productForm.sku}
                      onChange={(e) =>
                        setProductForm((c) => ({ ...c, sku: e.target.value }))
                      }
                      placeholder="JW-1001"
                      required
                    />
                  </div>
                  <div className="field">
                    <label>Gender preference</label>
                    <select
                      name="gender"
                      value={productForm.gender}
                      onChange={(e) =>
                        setProductForm((c) => ({ ...c, gender: e.target.value }))
                      }
                    >
                      <option>Women</option>
                      <option>Men</option>
                      <option>Unisex</option>
                    </select>
                  </div>
                </div>
                <div className="field">
                  <label>Description</label>
                  <textarea
                    name="description"
                    value={productForm.description}
                    onChange={(e) =>
                      setProductForm((c) => ({ ...c, description: e.target.value }))
                    }
                    placeholder="Short product description"
                  />
                </div>

                <div className="field">
                  <label>Product images (multiple — Shopify Files)</label>
                  <input
                    ref={productImageInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      if (!files.length) return;
                      const additions: ProductImageItem[] = [];
                      const fileEntries: Record<string, File> = {};
                      files.forEach((file) => {
                        const key = `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                        fileEntries[key] = file;
                        additions.push({
                          key,
                          url: "",
                          shopifyFileId: null,
                          preview: URL.createObjectURL(file),
                        });
                      });
                      setProductFileMap((current) => ({ ...current, ...fileEntries }));
                      setProductImages((current) => [...current, ...additions]);
                      event.target.value = "";
                    }}
                  />
                  <div className="hint">
                    Add several product photos. First image is used as the catalog thumbnail.
                  </div>
                  {productImages.length ? (
                    <div className="upload-gallery">
                      {productImages.map((image, index) => (
                        <div key={image.key} className="upload-gallery-item">
                          <img src={image.preview} alt={`Product ${index + 1}`} />
                          {index === 0 ? (
                            <div className="hint" style={{ marginTop: 4 }}>
                              Primary
                            </div>
                          ) : null}
                          <button
                            type="button"
                            className="btn small danger"
                            onClick={() => {
                              setProductFileMap((current) => {
                                const next = { ...current };
                                delete next[image.key];
                                return next;
                              });
                              setProductImages((current) =>
                                current.filter((item) => item.key !== image.key),
                              );
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="field">
                  <label>Collections</label>
                  <select
                    value={collectionSelectVal}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setCollectionSelectVal("");
                      if (!nextId) return;
                      const coll = collections.find((c) => c.id === nextId);
                      if (!coll) return;
                      setSelectedCollections((prev) =>
                        prev.some((sc) => sc.id === coll.id)
                          ? prev
                          : [...prev, { id: coll.id, name: coll.name }],
                      );
                    }}
                  >
                    <option value="">Select a collection to add…</option>
                    {collections
                      .filter((c) => !selectedCollections.some((sc) => sc.id === c.id))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} {c.parent ? `(Sub of ${c.parent.name})` : ""}
                        </option>
                      ))}
                  </select>
                  <div className="hint">
                    Selecting a collection adds it immediately. Every product is also kept in {ALL_COLLECTIONS_NAME}.
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                    {selectedCollections.map((coll) => {
                      const isAll = coll.name === ALL_COLLECTIONS_NAME;
                      return (
                        <div
                          key={coll.id}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "6px 12px",
                            borderRadius: 20,
                            fontSize: "0.9em",
                            backgroundColor: isAll ? "var(--gold-tint)" : "#f0f0f0",
                            border: "1px solid #ddd",
                          }}
                        >
                          <span>{coll.name}</span>
                          {!isAll ? (
                            <button
                              type="button"
                              style={{
                                border: "none",
                                background: "transparent",
                                cursor: "pointer",
                                fontSize: "1.1em",
                                padding: 0,
                                lineHeight: 1,
                                color: "#888",
                              }}
                              onClick={() => {
                                setSelectedCollections((prev) =>
                                  prev.filter((c) => c.id !== coll.id),
                                );
                              }}
                              aria-label={`Remove ${coll.name}`}
                            >
                              &times;
                            </button>
                          ) : null}
                          <input type="hidden" name="collectionIds" value={coll.id} />
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="field">
                  <label>Status</label>
                  <select
                    name="status"
                    value={productForm.status}
                    onChange={(e) =>
                      setProductForm((c) => ({ ...c, status: e.target.value }))
                    }
                  >
                    <option value="Active">Active</option>
                    <option value="Draft">Draft</option>
                  </select>
                </div>
              </div>

              <div className="panel">
                <div className="panel-title">
                  {editingVariantKey ? "Edit colour × purity variant" : "Colour × purity variant"}
                </div>
                {editingVariantKey ? (
                  <div className="hint" style={{ marginBottom: 12 }}>
                    Editing a listed variant — update fields, then click{" "}
                    <strong>Update variant</strong>.
                  </div>
                ) : null}
                <div className="field-row4">
                  <div className="field">
                    <label>Metal colour</label>
                    <select
                      value={variantForm.metalId}
                      onChange={(e) => onMetalChange(e.target.value)}
                    >
                      {metals.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.color}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Purity</label>
                    <select
                      value={variantForm.purityId}
                      onChange={(e) =>
                        setVariantForm((c) => ({ ...c, purityId: e.target.value }))
                      }
                    >
                      {availablePurities.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Gross weight (g)</label>
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      value={
                        Number.isFinite(variantForm.grossWeight)
                          ? variantForm.grossWeight
                          : ""
                      }
                      onChange={(e) =>
                        setVariantForm((c) => ({
                          ...c,
                          grossWeight: Number(e.target.value),
                        }))
                      }
                      placeholder="0.00"
                    />
                  </div>
                  <div className="field">
                    <label>Net weight (g)</label>
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      value={
                        (() => {
                          const gross = variantForm.grossWeight || 0;
                          const stone = variantForm.stoneIncluded ? variantForm.stoneWeight || 0 : 0;
                          const stoneInGrams = variantForm.stoneIncluded && variantForm.stoneType === "Diamond"
                            ? stone / 5
                            : stone;
                          const net = gross - stoneInGrams;
                          return net > 0 ? Number(net.toFixed(3)) : "";
                        })()
                      }
                      onChange={(e) => {
                        const newNet = Number(e.target.value) || 0;
                        setVariantForm((c) => {
                          const stone = c.stoneIncluded ? c.stoneWeight || 0 : 0;
                          const stoneInGrams = c.stoneIncluded && c.stoneType === "Diamond"
                            ? stone / 5
                            : stone;
                          return {
                            ...c,
                            grossWeight: Number((newNet + stoneInGrams).toFixed(3)),
                          };
                        });
                      }}
                      placeholder="0.00"
                    />
                  </div>
                </div>

                <div className="field">
                  <label>Variant image (one image only)</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      setDraftFile(file);
                      setDraftPreview(file ? URL.createObjectURL(file) : "");
                    }}
                  />
                  <div className="hint">Each colour × purity variant can have one image.</div>
                  {draftPreview ? (
                    <img src={draftPreview} alt="Variant preview" className="upload-preview" />
                  ) : null}
                </div>

                <div className="field-row">
                  <div className="field">
                    <label>Stone?</label>
                    <select
                      value={String(variantForm.stoneIncluded)}
                      onChange={(e) =>
                        setVariantForm((c) => ({
                          ...c,
                          stoneIncluded: e.target.value === "true",
                        }))
                      }
                    >
                      <option value="false">Without stone</option>
                      <option value="true">With stone</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Wastage %</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={variantForm.wastagePercent}
                      onChange={(e) =>
                        setVariantForm((c) => ({
                          ...c,
                          wastagePercent: Number(e.target.value),
                        }))
                      }
                    />
                  </div>
                </div>

                 {variantForm.stoneIncluded ? (
                  <>
                    {variantForm.stoneType === "Diamond" ? (
                      <>
                        <div className="field-row4">
                          <div className="field">
                            <label>Stone type</label>
                            <select
                              value={variantForm.stoneType}
                              onChange={(e) =>
                                setVariantForm((c) => ({
                                  ...c,
                                  stoneType: e.target.value,
                                  diamondQualityId: "",
                                  diamondCount: 1,
                                  pricePerCarat: 0,
                                  stoneRate: 0,
                                }))
                              }
                            >
                              <option>Diamond</option>
                              <option>Ruby</option>
                              <option>Emerald</option>
                              <option>Sapphire</option>
                              <option>Pearl</option>
                            </select>
                          </div>
                          <div className="field">
                            <label>Total carat weight</label>
                            <input
                              type="number"
                              step="0.001"
                              min="0"
                              placeholder="2.000"
                              value={
                                Number.isFinite(variantForm.stoneWeight)
                                  ? variantForm.stoneWeight
                                  : ""
                              }
                              onChange={(e) =>
                                setVariantForm((c) => ({
                                  ...c,
                                  stoneWeight: Number(e.target.value),
                                }))
                              }
                            />
                          </div>
                          <div className="field">
                            <label>No. of diamonds</label>
                            <input
                              type="number"
                              step="1"
                              min="1"
                              placeholder="50"
                              value={variantForm.diamondCount || ""}
                              onChange={(e) =>
                                setVariantForm((c) => ({
                                  ...c,
                                  diamondCount: Number(e.target.value),
                                }))
                              }
                            />
                            <div className="hint">Price uses average size: total ct ÷ this count.</div>
                          </div>
                          <div className="field">
                            <label>Stone weight (g)</label>
                            <input
                              type="text"
                              readOnly
                              disabled
                              value={variantForm.stoneWeight ? (variantForm.stoneWeight / 5).toFixed(3) : "0.000"}
                            />
                          </div>
                        </div>
                        <div className="field-row">
                          <div className="field">
                            <label>Diamond quality</label>
                            <select
                              value={variantForm.diamondQualityId || ""}
                              onChange={(e) =>
                                setVariantForm((c) => ({
                                  ...c,
                                  diamondQualityId: e.target.value,
                                }))
                              }
                            >
                              <option value="">Select color + clarity…</option>
                              {diamondQualities.map((quality) => (
                                <option key={quality.id} value={quality.id}>
                                  {quality.name}
                                </option>
                              ))}
                            </select>
                            {diamondQualities.length === 0 ? (
                              <div className="hint">
                                Add diamond qualities and pricing slabs under Metals &amp; purity → Diamond Pricing.
                              </div>
                            ) : null}
                          </div>
                          <div className="field">
                            <label>Cut / shape</label>
                            <select
                              value={variantForm.diamondCategory}
                              onChange={(e) =>
                                setVariantForm((c) => ({
                                  ...c,
                                  diamondCategory: e.target.value,
                                }))
                              }
                            >
                              {Array.from(
                                new Set([
                                  ...DEFAULT_DIAMOND_CUTS,
                                  ...(variantForm.diamondCategory ? [variantForm.diamondCategory] : []),
                                ]),
                              ).map((cutName) => (
                                <option key={cutName} value={cutName}>
                                  {cutName}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        {diamondQuote.ok ? (
                          <div className="hint">
                            Avg {diamondQuote.averageCarat.toFixed(4)} ct/stone ({diamondQuote.averageCents.toFixed(2)} cents)
                            {" "}→ {diamondQuote.qualityName} slab {formatCentsRange(diamondQuote.slabFrom, diamondQuote.slabTo)}
                            {" "}→ {formatINR(diamondQuote.pricePerCarat)}/ct
                            {" "}→ diamond value {formatINR(diamondQuote.diamondValue)}
                          </div>
                        ) : (
                          <div className="hint" style={{ color: "var(--red)" }}>
                            {diamondQuote.message}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="field-row3">
                        <div className="field">
                          <label>Stone type</label>
                          <select
                            value={variantForm.stoneType}
                            onChange={(e) =>
                              setVariantForm((c) => ({
                                ...c,
                                stoneType: e.target.value,
                                diamondQualityId: "",
                              }))
                            }
                          >
                            <option>Diamond</option>
                            <option>Ruby</option>
                            <option>Emerald</option>
                            <option>Sapphire</option>
                            <option>Pearl</option>
                          </select>
                        </div>
                        <div className="field">
                          <label>Stone weight (g)</label>
                          <input
                            type="number"
                            step="0.001"
                            min="0"
                            value={
                              Number.isFinite(variantForm.stoneWeight)
                                ? variantForm.stoneWeight
                                : ""
                            }
                            onChange={(e) =>
                              setVariantForm((c) => ({
                                ...c,
                                stoneWeight: Number(e.target.value),
                              }))
                            }
                          />
                        </div>
                        <div className="field">
                          <label>Stone rate (₹ / g)</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={
                              Number.isFinite(variantForm.stoneRate)
                                ? variantForm.stoneRate
                                : ""
                            }
                            onChange={(e) =>
                              setVariantForm((c) => ({
                                ...c,
                                stoneRate: Number(e.target.value),
                              }))
                            }
                          />
                        </div>
                      </div>
                    )}
                  </>
                ) : null}

                <div className="field-row">
                  <div className="field">
                    <label>Making charge type</label>
                    <select
                      value={variantForm.makingChargeType}
                      onChange={(e) =>
                        setVariantForm((c) => ({
                          ...c,
                          makingChargeType: e.target.value as MakingChargeType,
                        }))
                      }
                    >
                      <option value="percent">Percentage (%)</option>
                      <option value="fixed">Plain rate (₹)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>
                      Making charge{" "}
                      {variantForm.makingChargeType === "percent" ? "(%)" : "(₹)"}
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={variantForm.makingChargeValue}
                      onChange={(e) =>
                        setVariantForm((c) => ({
                          ...c,
                          makingChargeValue: Number(e.target.value),
                        }))
                      }
                    />
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={saveVariantToList}
                    disabled={
                      variantForm.stoneIncluded &&
                      variantForm.stoneType === "Diamond" &&
                      !diamondQuote.ok
                    }
                  >
                    {editingVariantKey ? "Update variant" : "Add this variant to list"}
                  </button>
                  {editingVariantKey ? (
                    <button type="button" className="btn" onClick={() => clearVariantEditor(true)}>
                      Cancel variant edit
                    </button>
                  ) : null}
                </div>

                {variantsForSave.length > 0 ? (
                  <div className="variant-list">
                    {variantsForSave.map((variant) => {
                      const purity = purities.find((p) => p.id === variant.purityId);
                      const price = calculateProductPrice({
                        grossWeight: variant.grossWeight,
                        stoneWeight: variant.stoneWeight,
                        stoneIncluded: variant.stoneIncluded,
                        stoneType: variant.stoneType,
                        wastagePercent: variant.wastagePercent,
                        makingChargeType: variant.makingChargeType,
                        makingChargeValue: variant.makingChargeValue,
                        stoneRate: variant.stoneRate,
                        goldPricePerGram,
                      }).total;
                      const thumb = variant.imagePreview || variant.existingImageUrl;
                      const inList = variants.some((v) => v.key === variant.key);
                      const isEditingRow = editingVariantKey === variant.key;
                      return (
                        <div
                          key={variant.key}
                          className="variant-chip"
                          style={
                            isEditingRow
                              ? { borderColor: "var(--gold)", background: "var(--gold-tint)" }
                              : undefined
                          }
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 8,
                              alignItems: "center",
                            }}
                          >
                            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                              {thumb ? (
                                <img src={thumb} alt="" className="upload-thumb" />
                              ) : (
                                <div className="prod-thumb">
                                  {(variant.metalColor[0] || "V").toUpperCase()}
                                </div>
                              )}
                              <div>
                                <strong>
                                  {variant.metalColor} · {purity?.label} · Gross:{" "}
                                  {formatGrams(variant.grossWeight)} (Net:{" "}
                                  {formatGrams(
                                    variant.grossWeight -
                                      (variant.stoneIncluded
                                        ? (variant.stoneType === "Diamond" ? (variant.stoneWeight || 0) / 5 : variant.stoneWeight || 0)
                                        : 0)
                                  )}
                                  )
                                </strong>
                                {isEditingRow ? (
                                  <div className="hint">Currently editing</div>
                                ) : null}
                              </div>
                            </div>
                            <span className="mono">{formatINR(price)}</span>
                          </div>
                          {inList ? (
                            <div
                              className="row-actions"
                              style={{ justifyContent: "flex-start", marginTop: 8 }}
                            >
                              <button
                                type="button"
                                className="btn small"
                                onClick={() => startEditVariant(variant)}
                                disabled={isEditingRow}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn small danger"
                                onClick={() => {
                                  if (editingVariantKey === variant.key) {
                                    clearVariantEditor(true);
                                  }
                                  setVariantFileMap((current) => {
                                    const next = { ...current };
                                    delete next[variant.key];
                                    return next;
                                  });
                                  setVariants((cur) =>
                                    cur.filter((v) => v.key !== variant.key),
                                  );
                                }}
                              >
                                Remove
                              </button>
                            </div>
                          ) : (
                            <div className="hint">Current form (included on save)</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="summary-card">
              <div className="panel-title" style={{ marginBottom: 10 }}>
                Price breakdown
              </div>
              {productImages[0]?.preview ? (
                <img
                  src={productImages[0].preview}
                  alt="Product"
                  className="upload-preview"
                />
              ) : null}
              <div className="summary-row">
                <span className="l">Gold rate used</span>
                <span className="v">{formatINR(adjustedGoldPrice)} / g</span>
              </div>
              <div className="summary-row">
                <span className="l">Net gold weight</span>
                <span className="v">{formatGrams(preview.netGoldWeight)}</span>
              </div>
              <div className="summary-row">
                <span className="l">Chargeable weight</span>
                <span className="v">{formatGrams(preview.chargeableGoldWeight)}</span>
              </div>
              <div className="summary-row">
                <span className="l">Gold value</span>
                <span className="v">{formatINR(preview.goldValue)}</span>
              </div>
              <div className="summary-row">
                <span className="l">Making charge</span>
                <span className="v">{formatINR(preview.makingCharge)}</span>
              </div>
              {variantForm.stoneIncluded && variantForm.stoneType === "Diamond" ? (
                <>
                  <div className="summary-row">
                    <span className="l">Total carat</span>
                    <span className="v">{(variantForm.stoneWeight || 0).toFixed(3)} ct</span>
                  </div>
                  <div className="summary-row">
                    <span className="l">No. of diamonds</span>
                    <span className="v">{variantForm.diamondCount || 0}</span>
                  </div>
                  <div className="summary-row">
                    <span className="l">Avg size</span>
                    <span className="v">
                      {diamondQuote.averageCarat.toFixed(4)} ct ({diamondQuote.averageCents.toFixed(2)} ¢)
                    </span>
                  </div>
                  <div className="summary-row">
                    <span className="l">Quality</span>
                    <span className="v">{selectedDiamondQuality?.name || "—"}</span>
                  </div>
                  {diamondQuote.ok ? (
                    <>
                      <div className="summary-row">
                        <span className="l">Pricing slab</span>
                        <span className="v">{formatCentsRange(diamondQuote.slabFrom, diamondQuote.slabTo)}</span>
                      </div>
                      <div className="summary-row">
                        <span className="l">Price / ct</span>
                        <span className="v">{formatINR(diamondQuote.pricePerCarat)}</span>
                      </div>
                    </>
                  ) : (
                    <div className="summary-row">
                      <span className="l">Pricing slab</span>
                      <span className="v" style={{ color: "var(--red)" }}>Not matched</span>
                    </div>
                  )}
                  <div className="summary-row">
                    <span className="l">Stone weight (g)</span>
                    <span className="v">{((variantForm.stoneWeight || 0) / 5).toFixed(3)} g</span>
                  </div>
                </>
              ) : variantForm.stoneIncluded ? (
                <div className="summary-row">
                  <span className="l">Stone weight (g)</span>
                  <span className="v">{formatGrams(variantForm.stoneWeight)}</span>
                </div>
              ) : null}
              <div className="summary-row">
                <span className="l">Stone charges</span>
                <span className="v">{formatINR(preview.stoneCharge)}</span>
              </div>
              <div className="summary-total">
                <span className="l">Sell price</span>
                <span className="v">{formatINR(preview.total)}</span>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button
                  className="btn primary"
                  style={{ flex: 1, justifyContent: "center" }}
                  type="submit"
                  disabled={busy || variantsForSave.length === 0}
                >
                  {busy
                    ? "Saving…"
                    : editingId
                      ? "Save product"
                      : "Save product"}
                </button>
              </div>
              {editingId ? (
                <button
                  type="button"
                  className="btn"
                  style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
                  onClick={startCreate}
                >
                  Cancel edit / new product
                </button>
              ) : null}
              <div className="hint" style={{ marginTop: 10 }}>
                After saving, use <strong>Sync all to Shopify</strong> in the sidebar to push
                catalog changes.
              </div>
            </div>
          </div>
        </Form>
      ) : (
        <>
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-title">Bulk import / export</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              Export current products, or download a blank template. Each Excel row is one metal × purity variant.
              Use the same SKU on multiple rows to add variants under one product. Duplicate SKUs are skipped.
            </p>
            <div className="row-actions" style={{ justifyContent: "flex-start", marginBottom: 12 }}>
              <button type="button" className="btn" onClick={downloadProductTemplate}>
                Download template
              </button>
              <button type="button" className="btn" onClick={downloadProductExcel}>
                Export Excel
              </button>
              <button type="button" className="btn" onClick={downloadProductCsv}>
                Export CSV
              </button>
            </div>
            <Form method="post" encType="multipart/form-data">
              <input type="hidden" name="intent" value="import-product-excel" />
              <div className="field-row">
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="product-excel-file">Upload filled Excel / CSV</label>
                  <input
                    id="product-excel-file"
                    type="file"
                    name="excelFile"
                    accept=".xlsx,.xls,.csv"
                    required
                  />
                </div>
                <div className="field" style={{ marginBottom: 0, display: "flex", alignItems: "flex-end" }}>
                  <button className="btn primary" type="submit" disabled={busy}>
                    {busy ? "Importing…" : "Import products"}
                  </button>
                </div>
              </div>
            </Form>
          </div>

          <div className="toolbar">
            <div className="search-wrap">
              <label htmlFor="product-search">Search products</label>
              <input
                id="product-search"
                className="search-input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, SKU or collection"
              />
            </div>
          </div>

          <div className="table-wrap">
            {filteredCatalog.length === 0 ? (
              <div className="empty-state">No products match your filters.</div>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>SKU</th>
                    <th>Variants</th>
                    <th>From price</th>
                    <th>Status</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCatalog.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <div className="prod-cell">
                          {product.imageUrl ? (
                            <img
                              src={product.imageUrl}
                              alt={product.name}
                              className="prod-thumb-img"
                            />
                          ) : (
                            <div className="prod-thumb">{product.initials}</div>
                          )}
                          <div>
                            <div className="prod-name">{product.name}</div>
                            <div className="prod-sub">
                              {product.collection} · {product.gender}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="mono">{product.sku}</td>
                      <td>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {product.variants.map((v) =>
                            v.imageUrl ? (
                              <img
                                key={v.id}
                                src={v.imageUrl}
                                alt={v.label}
                                title={v.label}
                                className="upload-thumb"
                              />
                            ) : (
                              <span key={v.id} className="badge draft">
                                {v.label}
                              </span>
                            ),
                          )}
                        </div>
                      </td>
                      <td className="mono">{formatINR(product.fromPrice)}</td>
                      <td>
                        <span className={`badge ${product.synced ? "active" : "draft"}`}>
                          <span className="badge-dot" />
                          {product.synced ? "Synced" : "Not synced"}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            className="btn small"
                            onClick={() => startEdit(product.id)}
                          >
                            Edit
                          </button>
                          <Form method="post">
                            <input type="hidden" name="intent" value="delete" />
                            <input type="hidden" name="id" value={product.id} />
                            <button className="btn small danger" type="submit" disabled={busy}>
                              Delete
                            </button>
                          </Form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}
