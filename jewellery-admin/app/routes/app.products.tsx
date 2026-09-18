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
  normalizeMakingChargeType,
  normalizePricingMode,
  type MakingChargeType,
  type PricingMode,
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
import {
  saveProductFormSession,
  loadProductFormSession,
  clearProductFormSession,
  productFormSessionIsEmpty,
} from "../lib/product-form-session";
import { ALL_COLLECTIONS_NAME } from "../lib/collections";
import { ensureAllCollectionsCollection } from "../lib/seed.server";
import { htmlToPlainText, normalizeImageUrl } from "../lib/text";
import {
  emptyStoneLine,
  isDiamondStone,
  parseStonesJson,
  serializeStones,
  stoneChargeForLine,
  stonesToLegacy,
  stoneWeightInGrams,
  type StoneLine,
} from "../lib/stones";

type VariantDraft = {
  key: string;
  id?: string;
  metalId: string;
  purityId: string;
  metalColor: string;
  grossWeight: number;
  netGoldWeight: number;
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
  wastageType: MakingChargeType;
  otherCharges: number;
  gstPercent: number;
  manualPrice: number;
  stoneRate: number;
  stones: StoneLine[];
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
  dimensionWidth: string;
  dimensionHeight: string;
  availableSizes: string[];
  collectionIds: string[];
  status: string;
  pricingMode: PricingMode;
  isRing: boolean;
};

const RING_SIZE_OPTIONS = Array.from({ length: 26 }, (_, i) => String(i + 5));

function parseAvailableSizes(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function looksLikeRing(name: string, collections: Array<{ name: string }>) {
  if (/ring/i.test(name)) return true;
  return collections.some((item) => /ring/i.test(item.name));
}

function stoneGramsOnVariant(variant: { stoneIncluded?: boolean; stones?: StoneLine[] }) {
  if (!variant.stoneIncluded) return 0;
  return (variant.stones || []).reduce((sum, stone) => sum + stoneWeightInGrams(stone), 0);
}

function withGrossFromNet<T>(form: T): T {
  return form;
}

function netFromStoredGross(gross: number, stones: StoneLine[], stoneIncluded: boolean) {
  const grams = stoneIncluded ? stones.reduce((sum, stone) => sum + stoneWeightInGrams(stone), 0) : 0;
  return Number(Math.max(0, (Number(gross) || 0) - grams).toFixed(3));
}

function ChargeBasisRadios({
  name,
  value,
  onChange,
}: {
  name: string;
  value: string;
  onChange: (type: MakingChargeType) => void;
}) {
  const current = normalizeMakingChargeType(value);
  return (
    <div className="radio-inline">
      {([
        ["flat", "Flat"],
        ["per_gram", "Per gram"],
        ["percent", "Percentage"],
      ] as const).map(([type, label]) => (
        <label key={type}>
          <input
            type="radio"
            name={name}
            checked={current === type}
            onChange={() => onChange(type)}
          />
          {label}
        </label>
      ))}
    </div>
  );
}

function variantPriceInput(
  variant: {
    grossWeight: number;
    netGoldWeight?: number;
    stoneWeight: number;
    stoneIncluded: boolean;
    stoneType: string;
    wastagePercent: number;
    wastageType?: string;
    makingChargeType: string;
    makingChargeValue: number;
    stoneRate: number;
    otherCharges?: number;
    gstPercent?: number;
    manualPrice?: number;
    stones?: StoneLine[];
  },
  goldPricePerGram: number,
  pricingMode: PricingMode | string = "auto",
) {
  return {
    grossWeight: variant.grossWeight,
    netGoldWeight: variant.netGoldWeight,
    stoneWeight: variant.stoneWeight,
    stoneIncluded: variant.stoneIncluded,
    stoneType: variant.stoneType,
    wastagePercent: variant.wastagePercent,
    wastageType: variant.wastageType,
    makingChargeType: variant.makingChargeType,
    makingChargeValue: variant.makingChargeValue,
    stoneRate: variant.stoneRate,
    goldPricePerGram,
    stones: variant.stones,
    otherCharges: variant.otherCharges,
    gstPercent: variant.gstPercent,
    pricingMode,
    manualPrice: variant.manualPrice,
  };
}

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

function dedupeProductImageItems(items: ProductImageItem[]): ProductImageItem[] {
  const seen = new Set<string>();
  const unique: ProductImageItem[] = [];
  for (const item of items) {
    const key = item.url
      ? normalizeImageUrl(item.url)
      : `preview:${item.preview || item.key}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

const emptyVariant = (metalId = "", purityId = "", metalColor = ""): VariantDraft => ({
  key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  metalId,
  purityId,
  metalColor,
  grossWeight: 0,
  netGoldWeight: 0,
  stoneIncluded: false,
  stoneType: "Diamond",
  stoneWeight: 0,
  diamondCategory: "Round",
  diamondQualityId: "",
  diamondCount: 1,
  pricePerCarat: 0,
  wastagePercent: 5,
  wastageType: "percent",
  makingChargeType: "percent",
  makingChargeValue: 10,
  otherCharges: 0,
  gstPercent: 3,
  manualPrice: 0,
  stoneRate: 0,
  stones: [],
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
  dimensionWidth: "",
  dimensionHeight: "",
  availableSizes: [],
  collectionIds,
  status: "Active",
  pricingMode: "auto",
  isRing: false,
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [settings, collections, metals, purities, products, diamondQualities, gemstones] = await Promise.all([
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
    prisma.gemstoneType.findMany({
      where: { status: "Active" },
      orderBy: { name: "asc" },
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
      calculateProductPrice(
        variantPriceInput(
          {
            ...variant,
            makingChargeType: variant.makingChargeType,
            stones: parseStonesJson(variant.stonesJson, variant),
          },
          variant.purity
            ? (goldPricePerGram / 0.916) * variant.purity.purityValue
            : goldPricePerGram,
          product.pricingMode,
        ),
      ).total,
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
      dimensionWidth: product.dimensionWidth || "",
      dimensionHeight: product.dimensionHeight || "",
      availableSizes: parseAvailableSizes(product.availableSizes),
      isRing: Boolean(product.isRing),
      collectionIds: product.collections.map((c) => c.id),
      collection: product.collections.map((c) => c.name).join(", ") || "—",
      status: product.status,
      pricingMode: normalizePricingMode(product.pricingMode),
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
        netGoldWeight: variant.netGoldWeight,
        stoneIncluded: variant.stoneIncluded,
        stoneType: variant.stoneType,
        stoneWeight: variant.stoneWeight,
        diamondCategory: variant.diamondCategory,
        diamondQualityId: variant.diamondQualityId,
        diamondQualityName: variant.diamondQuality?.name || "",
        diamondCount: variant.diamondCount,
        pricePerCarat: variant.pricePerCarat,
        wastagePercent: variant.wastagePercent,
        wastageType: (variant.wastageType as MakingChargeType) || "percent",
        makingChargeType: variant.makingChargeType as MakingChargeType,
        makingChargeValue: variant.makingChargeValue,
        otherCharges: variant.otherCharges,
        gstPercent: variant.gstPercent,
        manualPrice: variant.manualPrice,
        stoneRate: variant.stoneRate,
        status: variant.status as "Active" | "Draft",
        imageUrl: variant.imageUrl,
        shopifyFileId: variant.shopifyFileId,
        purityLabel: variant.purity?.label || "",
        label: `${variant.metalColor} · ${variant.purity?.label || "22K"}`,
        stones: parseStonesJson(variant.stonesJson, variant),
        price: calculateProductPrice(
          variantPriceInput(
            {
              ...variant,
              stones: parseStonesJson(variant.stonesJson, variant),
            },
            variant.purity
              ? (goldPricePerGram / 0.916) * variant.purity.purityValue
              : goldPricePerGram,
            product.pricingMode,
          ),
        ).total,
      })),
    };
  });

  return { goldPricePerGram, collections, metals, purities, catalog, diamondQualities, gemstones };
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
          netGoldWeight?: number;
          stoneIncluded: boolean;
          stoneType: string;
          stoneWeight: number;
          diamondCategory: string;
          diamondQualityId: string | null;
          diamondCount: number;
          pricePerCarat: number;
          wastagePercent: number;
          wastageType?: string;
          makingChargeType: string;
          makingChargeValue: number;
          otherCharges?: number;
          gstPercent?: number;
          manualPrice?: number;
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
            wastageType: "percent",
            makingChargeType: row.makingChargeType === "per_gram" ? "per_gram" : row.makingChargeType === "fixed" || row.makingChargeType === "flat" ? "flat" : "percent",
            makingChargeValue: Number(row.makingChargeValue) || 0,
            otherCharges: 0,
            gstPercent: 3,
            manualPrice: 0,
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

    if (intent !== "create" && intent !== "update" && intent !== "autosave-draft") {
      return { ok: false, message: "Unknown action." };
    }

    const isAutosave = intent === "autosave-draft";
    const editingId = String(form.get("productId") || "") || null;
    if ((intent === "update" || isAutosave) && !editingId && intent === "update") {
      return { ok: false, message: "Missing product id for update." };
    }

    const sku =
      String(form.get("sku") || "").trim() ||
      (isAutosave ? `DRAFT-${Date.now().toString().slice(-8)}` : "");
    const name =
      String(form.get("name") || "").trim() ||
      (isAutosave ? "Untitled draft" : "");
    const description = htmlToPlainText(String(form.get("description") || "").trim());
    const gender = String(form.get("gender") || "Unisex");
    const dimensionWidth = String(form.get("dimensionWidth") || "").trim();
    const dimensionHeight = String(form.get("dimensionHeight") || "").trim();
    let availableSizes: string[] = [];
    try {
      const parsed = JSON.parse(String(form.get("availableSizes") || "[]"));
      availableSizes = Array.isArray(parsed)
        ? parsed.map((item) => String(item).trim()).filter(Boolean)
        : [];
    } catch {
      availableSizes = [];
    }
    const isRing = String(form.get("isRing") || "") === "true";
    const availableSizesJson = JSON.stringify(isRing ? availableSizes : []);
    const collectionIds = form.getAll("collectionIds").map(String);
    const status = isAutosave ? "Draft" : String(form.get("status") || "Active");
    const pricingMode = normalizePricingMode(String(form.get("pricingMode") || "auto"));
    const variantsRaw = String(form.get("variantsJson") || "[]");

    if (!isAutosave && (!sku || !name)) {
      return { ok: false, message: "SKU and product name are required." };
    }
    if (!isAutosave && isRing && !availableSizes.length) {
      return { ok: false, message: "This is a ring — select at least one size variant." };
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
            netGoldWeight: 0,
            stoneIncluded: false,
            stoneType: "None",
            stoneWeight: 0,
            diamondCategory: "",
            diamondCount: 1,
            pricePerCarat: 0,
            wastagePercent: 5,
            wastageType: "percent",
            makingChargeType: "percent",
            makingChargeValue: 10,
            otherCharges: 0,
            gstPercent: 3,
            manualPrice: 0,
            stoneRate: 0,
            stones: [],
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

    const quotedDrafts: VariantDraft[] = [];
    for (const draft of drafts) {
      const sourceStones =
        draft.stoneIncluded
          ? Array.isArray(draft.stones) && draft.stones.length
            ? draft.stones
            : parseStonesJson("", draft)
          : [];
      const quotedStones: StoneLine[] = [];
      for (const stone of sourceStones) {
        if (!isDiamondStone(stone.stoneType)) {
          quotedStones.push(stone);
          continue;
        }
        const quality = diamondQualities.find((item) => item.id === stone.diamondQualityId);
        const quote = quoteDiamondValue({
          totalCarat: Number(stone.weight) || 0,
          diamondCount: Number(stone.diamondCount) || 0,
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
          if (isAutosave) {
            quotedStones.push(stone);
            continue;
          }
          return { ok: false, message: quote.message };
        }
        quotedStones.push({
          ...stone,
          diamondCount: quote.diamondCount,
          rate: quote.diamondValue,
          pricePerCarat: quote.pricePerCarat,
        });
      }
      const legacy = stonesToLegacy(quotedStones);
      quotedDrafts.push(
        withGrossFromNet({
          ...draft,
          ...legacy,
          stones: quotedStones,
        }),
      );
    }

    const variantCreateData = quotedDrafts.map((draft, index) => ({
      metalId: draft.metalId,
      purityId: draft.purityId,
      metalColor: draft.metalColor,
      grossWeight: Number(draft.grossWeight) || 0,
      netGoldWeight: Number(draft.netGoldWeight) || 0,
      stoneIncluded: Boolean(draft.stoneIncluded),
      stoneType: draft.stoneIncluded ? draft.stoneType : "None",
      stoneWeight: draft.stoneIncluded ? Number(draft.stoneWeight) || 0 : 0,
      diamondCategory: draft.stoneIncluded ? draft.diamondCategory : "",
      diamondQualityId: draft.stoneIncluded ? draft.diamondQualityId || null : null,
      diamondCount: draft.stoneIncluded ? Number(draft.diamondCount) || 1 : 1,
      pricePerCarat: draft.stoneIncluded ? Number(draft.pricePerCarat) || 0 : 0,
      wastagePercent: Number(draft.wastagePercent) || 0,
      wastageType: normalizeMakingChargeType(draft.wastageType || "percent"),
      makingChargeType: normalizeMakingChargeType(draft.makingChargeType),
      makingChargeValue: Number(draft.makingChargeValue) || 0,
      otherCharges: Number(draft.otherCharges) || 0,
      gstPercent: Number.isFinite(Number(draft.gstPercent)) ? Number(draft.gstPercent) : 3,
      manualPrice: Number(draft.manualPrice) || 0,
      stoneRate: Number(draft.stoneRate) || 0,
      stonesJson: draft.stoneIncluded ? serializeStones(draft.stones || []) : "[]",
      imageUrl: variantAssets[index]?.imageUrl || "",
      shopifyFileId: variantAssets[index]?.shopifyFileId || null,
      status: draft.status,
    }));

    let productId = editingId;
    let savedExisting = false;

    if ((intent === "update" || isAutosave) && editingId) {
      const current = await prisma.product.findUnique({
        where: { id: editingId },
        include: { variants: true },
      });
      if (!current) {
        if (!isAutosave) return { ok: false, message: "Product not found." };
      } else {
        savedExisting = true;

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
              netGoldWeight: vData.netGoldWeight,
              stoneIncluded: vData.stoneIncluded,
              stoneType: vData.stoneType,
              stoneWeight: vData.stoneWeight,
              diamondCategory: vData.diamondCategory,
              diamondQualityId: vData.diamondQualityId,
              diamondCount: vData.diamondCount,
              pricePerCarat: vData.pricePerCarat,
              wastagePercent: vData.wastagePercent,
              wastageType: vData.wastageType,
              makingChargeType: vData.makingChargeType,
              makingChargeValue: vData.makingChargeValue,
              otherCharges: vData.otherCharges,
              gstPercent: vData.gstPercent,
              manualPrice: vData.manualPrice,
              stoneRate: vData.stoneRate,
              stonesJson: vData.stonesJson,
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
          dimensionWidth,
          dimensionHeight,
          availableSizes: availableSizesJson,
          isRing,
          pricingMode,
          status,
          collections: {
            set: mergedCollectionIds.map((id) => ({ id })),
          },
        },
      });
      }
    }
    if (!savedExisting) {
      const created = await prisma.product.create({
        data: {
          sku,
          name,
          description,
          imageUrl,
          shopifyFileId,
          imagesJson,
          gender,
          dimensionWidth,
          dimensionHeight,
          availableSizes: availableSizesJson,
          isRing,
          pricingMode,
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
    if (!isAutosave) {
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
    }

    if (isAutosave) {
      return {
        ok: true,
        message: "Draft saved.",
        clearEdit: false,
        productId,
        draftSaved: true,
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
  const { goldPricePerGram, collections, metals, purities, catalog, diamondQualities, gemstones } =
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
  const [enableVariants, setEnableVariants] = useState(false);
  const [dragImageKey, setDragImageKey] = useState<string | null>(null);
  const [viewingProductId, setViewingProductId] = useState<string | null>(null);
  const [customRingSize, setCustomRingSize] = useState("");
  const hydratedEditIdRef = useRef<string | null>(null);
  const sessionRestoredRef = useRef(false);
  const persistDraftOnLeaveRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (actionData && "clearEdit" in actionData && actionData.clearEdit && actionData.ok) {
      clearProductFormSession();
      resetForm();
      hydratedEditIdRef.current = null;
      sessionRestoredRef.current = false;
      setSearchParams({ view: "catalog" });
    }
    if (actionData && "draftSaved" in actionData && actionData.draftSaved && actionData.productId) {
      setEditingId(actionData.productId);
      hydratedEditIdRef.current = actionData.productId;
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

  const stoneOptions = useMemo(
    () => ["Diamond", ...gemstones.map((gem) => gem.name)],
    [gemstones],
  );

  const quotedStones = useMemo(() => {
    if (!variantForm.stoneIncluded) return [];
    const lines = variantForm.stones?.length ? variantForm.stones : [];
    return lines.map((stone) => {
      if (!isDiamondStone(stone.stoneType)) {
        return { stone, quote: { ok: true as const } };
      }
      const quality = diamondQualities.find((item) => item.id === stone.diamondQualityId) ?? null;
      return {
        stone,
        quote: quoteDiamondValue({
          totalCarat: stone.weight,
          diamondCount: stone.diamondCount,
          quality: quality as DiamondQualityLike | null,
        }),
      };
    });
  }, [variantForm.stoneIncluded, variantForm.stones, diamondQualities]);

  const diamondQuote = useMemo(() => {
    const failed = quotedStones.find((item) => "ok" in item.quote && !item.quote.ok);
    return failed?.quote || { ok: true as const, message: "" };
  }, [quotedStones]);

  const quotedStoneRate = quotedStones.reduce((sum, item) => {
    if (isDiamondStone(item.stone.stoneType)) {
      return sum + (item.quote.ok && "diamondValue" in item.quote ? item.quote.diamondValue : 0);
    }
    return sum + stoneChargeForLine(item.stone);
  }, 0);

  const quotedPricePerCarat = (() => {
    const diamond = quotedStones.find(
      (item) => isDiamondStone(item.stone.stoneType) && item.quote.ok && "pricePerCarat" in item.quote,
    );
    return diamond && "pricePerCarat" in diamond.quote ? Number(diamond.quote.pricePerCarat) || 0 : 0;
  })();

  const formStoneGrams = useMemo(() => {
    if (!variantForm.stoneIncluded) return 0;
    return (variantForm.stones || []).reduce((sum, stone) => sum + stoneWeightInGrams(stone), 0);
  }, [variantForm.stoneIncluded, variantForm.stones]);

  const flattenQuotedVariant = (form: VariantDraft): VariantDraft => {
    const stones = form.stoneIncluded
      ? quotedStones.map((item) => ({
          ...item.stone,
          rate:
            isDiamondStone(item.stone.stoneType) && item.quote.ok && "diamondValue" in item.quote
              ? item.quote.diamondValue
              : Number(item.stone.rate) || 0,
          pricePerCarat:
            isDiamondStone(item.stone.stoneType) && item.quote.ok && "pricePerCarat" in item.quote
              ? item.quote.pricePerCarat
              : Number(item.stone.pricePerCarat) || 0,
        }))
      : [];
    return withGrossFromNet({
      ...form,
      ...stonesToLegacy(stones),
      stones,
      stoneRate: quotedStoneRate,
      pricePerCarat: quotedPricePerCarat,
    });
  };

  const updateStoneLine = (key: string, patch: Partial<StoneLine>) => {
    setVariantForm((current) =>
      withGrossFromNet({
        ...current,
        stones: (current.stones || []).map((stone) => {
          if (stone.key !== key) return stone;
          const next = { ...stone, ...patch };
          if (patch.stoneType) {
            const gem = gemstones.find((item) => item.name === patch.stoneType);
            next.gemstoneTypeId = gem?.id || "";
            if (!isDiamondStone(patch.stoneType)) {
              next.diamondQualityId = "";
              next.diamondCount = 1;
              next.pricePerCarat = 0;
              next.weight = 0;
              next.rateMode = "flat";
              if (gem && Number(gem.defaultRate) > 0) next.rate = Number(gem.defaultRate);
            }
          }
          return next;
        }),
      }),
    );
  };

  const preview = useMemo(
    () =>
      calculateProductPrice({
        grossWeight: variantForm.grossWeight,
        netGoldWeight: variantForm.netGoldWeight,
        stoneWeight: variantForm.stoneWeight,
        stoneIncluded: variantForm.stoneIncluded,
        stoneType: variantForm.stoneType,
        wastagePercent: variantForm.wastagePercent,
        wastageType: variantForm.wastageType,
        makingChargeType: variantForm.makingChargeType,
        makingChargeValue: variantForm.makingChargeValue,
        stoneRate: quotedStoneRate,
        goldPricePerGram: adjustedGoldPrice,
        otherCharges: variantForm.otherCharges,
        gstPercent: variantForm.gstPercent,
        pricingMode: productForm.pricingMode,
        manualPrice: variantForm.manualPrice,
        stones: quotedStones.map((item) => ({
          stoneType: item.stone.stoneType,
          weight: item.stone.weight,
          rate: isDiamondStone(item.stone.stoneType) && item.quote.ok && "diamondValue" in item.quote
            ? item.quote.diamondValue
            : item.stone.rate,
          rateMode: item.stone.rateMode,
        })),
      }),
    [variantForm, adjustedGoldPrice, quotedStoneRate, quotedStones, productForm.pricingMode],
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
      (Number(variantForm.netGoldWeight) > 0 || Number(variantForm.grossWeight) > 0) &&
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

  const viewingProduct = useMemo(
    () => catalog.find((p) => p.id === viewingProductId) ?? null,
    [catalog, viewingProductId],
  );

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
    setEnableVariants(false);
    setDragImageKey(null);
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

  const applyProductFormSession = (session: NonNullable<ReturnType<typeof loadProductFormSession>>) => {
    sessionRestoredRef.current = true;
    setEditingId(session.editingId);
    hydratedEditIdRef.current = session.editingId || "__session-new__";
    setEditingVariantKey(session.editingVariantKey);
    setEnableVariants(Boolean(session.enableVariants));
    if (session.productForm && typeof session.productForm === "object") {
      setProductForm({
        ...emptyProductForm(),
        ...(session.productForm as ProductFormState),
      });
    }
    if (session.variantForm && typeof session.variantForm === "object") {
      setVariantForm({
        ...emptyVariant(firstMetal?.id ?? "", firstPurity?.id ?? "", firstMetal?.color ?? ""),
        ...(session.variantForm as VariantDraft),
      });
    }
    setVariants(Array.isArray(session.variants) ? (session.variants as VariantDraft[]) : []);
    setSelectedCollections(session.selectedCollections || []);
    setProductImages(session.productImages || []);
    setDraftPreview(session.draftPreview || "");
  };

  const startCreate = () => {
    const session = loadProductFormSession();
    if (!productFormSessionIsEmpty(session) && session) {
      applyProductFormSession(session);
      setSearchParams(
        session.editingId ? { view: "edit", id: session.editingId } : { view: "edit" },
      );
      return;
    }
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
      dimensionWidth: product.dimensionWidth || "",
      dimensionHeight: product.dimensionHeight || "",
      availableSizes: product.availableSizes || [],
      collectionIds: product.collectionIds,
      status: product.status,
      pricingMode: normalizePricingMode(product.pricingMode),
      isRing: Boolean(product.isRing),
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
    setEnableVariants(product.variants.length > 1);
    setDragImageKey(null);
    setProductImages(
      dedupeProductImageItems(
        product.images.map((image, index) => ({
          key: `saved-${normalizeImageUrl(image.url) || index}`,
          url: image.url,
          shopifyFileId: image.shopifyFileId,
          preview: image.url,
        })),
      ),
    );
    setProductFileMap({});
    setVariantFileMap({});
    setDraftFile(null);
    if (productImageInputRef.current) productImageInputRef.current.value = "";

    const mappedVariants = product.variants.map((variant) => {
      const stones = Array.isArray(variant.stones)
        ? variant.stones
        : parseStonesJson("", variant);
      const stoneIncluded = Boolean(variant.stoneIncluded);
      return {
      key: variant.id,
      id: variant.id,
      metalId: variant.metalId,
      purityId: variant.purityId,
      metalColor: variant.metalColor,
      grossWeight: Number(variant.grossWeight) || 0,
      netGoldWeight:
        Number(variant.netGoldWeight) > 0
          ? Number(variant.netGoldWeight)
          : netFromStoredGross(Number(variant.grossWeight) || 0, stones, stoneIncluded),
      stoneIncluded,
      stoneType: variant.stoneType || "Diamond",
      stoneWeight: Number(variant.stoneWeight) || 0,
      diamondCategory: variant.diamondCategory || "Round",
      diamondQualityId: variant.diamondQualityId || "",
      diamondCount: Number(variant.diamondCount) || 1,
      pricePerCarat: Number(variant.pricePerCarat) || 0,
      wastagePercent: Number(variant.wastagePercent) || 0,
      wastageType: normalizeMakingChargeType(variant.wastageType || "percent"),
      makingChargeType: normalizeMakingChargeType(variant.makingChargeType),
      makingChargeValue: Number(variant.makingChargeValue) || 0,
      otherCharges: Number(variant.otherCharges) || 0,
      gstPercent: Number.isFinite(Number(variant.gstPercent)) ? Number(variant.gstPercent) : 3,
      manualPrice: Number(variant.manualPrice) || 0,
      stoneRate: Number(variant.stoneRate) || 0,
      stones,
      status: variant.status,
      imagePreview: variant.imageUrl || "",
      existingImageUrl: variant.imageUrl || "",
      existingFileId: variant.shopifyFileId,
    };
    });
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

  useEffect(() => {
    if (view !== "edit") return;
    if (sessionRestoredRef.current) return;
    const session = loadProductFormSession();
    if (productFormSessionIsEmpty(session) || !session) return;
    if (editIdFromUrl && session.editingId && session.editingId !== editIdFromUrl) return;
    applyProductFormSession(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, editIdFromUrl]);

  // Open edit form when arriving from dashboard (or deep link) with ?id=
  // Hydrate once per product id — never re-run on catalog refreshes or local form edits
  // (re-running was duplicating images when collections were changed).
  useEffect(() => {
    if (view !== "edit" || !editIdFromUrl) return;
    if (hydratedEditIdRef.current === editIdFromUrl) return;
    if (sessionRestoredRef.current && hydratedEditIdRef.current === editIdFromUrl) return;
    if (!catalog.some((p) => p.id === editIdFromUrl)) return;
    startEdit(editIdFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, editIdFromUrl, catalog]);

  useEffect(() => {
    if (!showForm) return;
    const payload = {
      editingId,
      productForm,
      variantForm,
      variants,
      enableVariants,
      selectedCollections,
      productImages,
      editingVariantKey,
      draftPreview,
    };
    if (productFormSessionIsEmpty(payload)) return;
    saveProductFormSession(payload);
  }, [
    showForm,
    editingId,
    productForm,
    variantForm,
    variants,
    enableVariants,
    selectedCollections,
    productImages,
    editingVariantKey,
    draftPreview,
  ]);

  const persistDraftOnLeave = () => {
    if (!showForm) return;
    const payload = {
      editingId,
      productForm,
      variantForm,
      variants,
      enableVariants,
      selectedCollections,
      productImages,
      editingVariantKey,
      draftPreview,
    };
    if (productFormSessionIsEmpty(payload)) return;
    saveProductFormSession(payload);
    const fd = new FormData();
    fd.set("intent", "autosave-draft");
    if (editingId) fd.set("productId", editingId);
    fd.set("sku", productForm.sku);
    fd.set("name", productForm.name);
    fd.set("description", productForm.description);
    fd.set("gender", productForm.gender);
    fd.set("dimensionWidth", productForm.dimensionWidth);
    fd.set("dimensionHeight", productForm.dimensionHeight);
    fd.set("availableSizes", JSON.stringify(productForm.availableSizes));
    fd.set("isRing", String(productForm.isRing));
    fd.set("pricingMode", productForm.pricingMode);
    fd.set("status", "Draft");
    selectedCollections.forEach((c) => fd.append("collectionIds", c.id));
    fd.set(
      "existingImagesJson",
      JSON.stringify(
        productImages
          .filter((image) => image.url)
          .map((image) => ({ url: image.url, shopifyFileId: image.shopifyFileId })),
      ),
    );
    let list = [...variants];
    if (
      (Number(variantForm.netGoldWeight) > 0 || Number(variantForm.grossWeight) > 0) &&
      variantForm.metalId &&
      variantForm.purityId
    ) {
      const key = editingVariantKey || variants[0]?.key || emptyVariant().key;
      const current = {
        ...flattenQuotedVariant(variantForm),
        key,
        id: variants.find((v) => v.key === key)?.id || variantForm.id,
      };
      if (editingVariantKey || !enableVariants || list.length === 0) {
        list = enableVariants
          ? list.some((v) => v.key === key)
            ? list.map((v) => (v.key === key ? { ...v, ...current } : v))
            : [...list, current]
          : [current];
      }
    }
    fd.set(
      "variantsJson",
      JSON.stringify(list.map(({ imagePreview: _p, ...rest }) => rest)),
    );
    submit(fd, { method: "post", encType: "multipart/form-data", navigate: false });
  };
  persistDraftOnLeaveRef.current = persistDraftOnLeave;

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") persistDraftOnLeaveRef.current();
    };
    const onPageHide = () => persistDraftOnLeaveRef.current();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      persistDraftOnLeaveRef.current();
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  const reorderProductImages = (fromKey: string, toKey: string) => {
    if (!fromKey || !toKey || fromKey === toKey) return;
    setProductImages((current) => {
      const fromIndex = current.findIndex((item) => item.key === fromKey);
      const toIndex = current.findIndex((item) => item.key === toKey);
      if (fromIndex < 0 || toIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const makePrimaryImage = (key: string) => {
    setProductImages((current) => {
      const index = current.findIndex((item) => item.key === key);
      if (index <= 0) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.unshift(moved);
      return next;
    });
  };

  const startEditVariant = (variant: VariantDraft) => {
    setEditingVariantKey(variant.key);
    setVariantForm(
      withGrossFromNet({
        ...variant,
        imagePreview: variant.imagePreview || variant.existingImageUrl || "",
      }),
    );
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
    if (!(Number(variantForm.netGoldWeight) > 0) && !(Number(variantForm.grossWeight) > 0)) return;
    if (productForm.pricingMode === "manual" && !(Number(variantForm.manualPrice) > 0)) return;
    if (variantForm.stoneIncluded && !diamondQuote.ok) return;

    const variantFormQuoted = flattenQuotedVariant(variantForm);

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
    if (productForm.isRing && !productForm.availableSizes.length) {
      window.alert("This is a ring — select at least one size variant.");
      return;
    }
    const form = event.currentTarget;
    const fd = new FormData(form);
    fd.set("intent", editingId ? "update" : "create");
    if (editingId) fd.set("productId", editingId);

    const keptImages = dedupeProductImageItems(productImages)
      .filter((image) => image.url)
      .map((image) => ({
        url: image.url,
        shopifyFileId: image.shopifyFileId,
      }));
    fd.set("existingImagesJson", JSON.stringify(keptImages));

    const nextVariantFiles: Record<string, File> = { ...variantFileMap };

    // Commit any in-progress variant edit before save.
    let list = [...variants];
    if (!enableVariants) {
      // Direct product: persist only the current metal/pricing form as a single entry
      if (!(Number(variantForm.netGoldWeight) > 0) && !(Number(variantForm.grossWeight) > 0)) return;
      if (productForm.pricingMode === "manual" && !(Number(variantForm.manualPrice) > 0)) return;
      if (variantForm.stoneIncluded && !diamondQuote.ok) return;
      const directKey = editingVariantKey || variants[0]?.key || emptyVariant().key;
      list = [
        {
          ...flattenQuotedVariant(variantForm),
          key: directKey,
          id: variants[0]?.id || variantForm.id,
          imagePreview: draftPreview || variantForm.imagePreview || variants[0]?.existingImageUrl || "",
          existingImageUrl: variants[0]?.existingImageUrl || variantForm.existingImageUrl || "",
          existingFileId: variants[0]?.existingFileId ?? variantForm.existingFileId ?? null,
        },
      ];
      if (draftFile) nextVariantFiles[directKey] = draftFile;
    } else if (editingVariantKey) {
      if (!(Number(variantForm.netGoldWeight) > 0) && !(Number(variantForm.grossWeight) > 0)) return;
      if (productForm.pricingMode === "manual" && !(Number(variantForm.manualPrice) > 0)) return;
      if (variantForm.stoneIncluded && !diamondQuote.ok) return;
      if (draftFile) nextVariantFiles[editingVariantKey] = draftFile;
      list = list.map((v) =>
        v.key === editingVariantKey
          ? {
              ...flattenQuotedVariant(variantForm),
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
        (Number(variantForm.netGoldWeight) > 0 || Number(variantForm.grossWeight) > 0) &&
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
        !(variantForm.stoneIncluded && !diamondQuote.ok)
      ) {
        const draftKey = emptyVariant().key;
        list.push({
          ...flattenQuotedVariant(variantForm),
          key: draftKey,
          imagePreview: draftPreview || variantForm.imagePreview || "",
        });
        if (draftFile) nextVariantFiles[draftKey] = draftFile;
      }
    }

    if (!list.length) {
      const draftKey = emptyVariant().key;
      list.push({
        ...flattenQuotedVariant(variantForm),
        metalId: variantForm.metalId || firstMetal?.id || "",
        purityId: variantForm.purityId || firstPurity?.id || "",
        metalColor: variantForm.metalColor || firstMetal?.color || "",
        grossWeight: Number(variantForm.grossWeight) || 0,
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
    const orderedImages = dedupeProductImageItems(productImages);
    orderedImages.forEach((image) => {
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

    const pendingProductPreviews = orderedImages.filter((image) => !image.url).length;
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
                persistDraftOnLeaveRef.current();
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

              {actionData?.message && !("draftSaved" in actionData && actionData.draftSaved) ? (
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
                <div className="field">
                  <label>Pricing mode</label>
                  <input type="hidden" name="pricingMode" value={productForm.pricingMode} />
                  <div className="mode-switch" role="group" aria-label="Pricing mode">
                    <button
                      type="button"
                      className={productForm.pricingMode === "auto" ? "is-active" : ""}
                      onClick={() => setProductForm((c) => ({ ...c, pricingMode: "auto" }))}
                    >
                      Auto
                    </button>
                    <button
                      type="button"
                      className={productForm.pricingMode === "manual" ? "is-active" : ""}
                      onClick={() => setProductForm((c) => ({ ...c, pricingMode: "manual" }))}
                    >
                      Manual
                    </button>
                  </div>
                  <div className="hint">
                    {productForm.pricingMode === "manual"
                      ? "Enter the sell price directly. Formula charges are skipped."
                      : "Price is calculated from gold, stones, making, other charges, and GST."}
                  </div>
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
                <div className="field-row">
                  <div className="field">
                    <label>Width (optional)</label>
                    <input
                      name="dimensionWidth"
                      value={productForm.dimensionWidth}
                      onChange={(e) =>
                        setProductForm((c) => ({ ...c, dimensionWidth: e.target.value }))
                      }
                      placeholder="e.g. 12 mm"
                    />
                  </div>
                  <div className="field">
                    <label>Height (optional)</label>
                    <input
                      name="dimensionHeight"
                      value={productForm.dimensionHeight}
                      onChange={(e) =>
                        setProductForm((c) => ({ ...c, dimensionHeight: e.target.value }))
                      }
                      placeholder="e.g. 18 mm"
                    />
                  </div>
                </div>
                <input type="hidden" name="availableSizes" value={JSON.stringify(productForm.availableSizes)} />
                <input type="hidden" name="isRing" value={String(productForm.isRing)} />
                <div className="field">
                  <label>Is this a ring?</label>
                  <div className="radio-inline">
                    <label>
                      <input
                        type="radio"
                        name="is-ring"
                        checked={!productForm.isRing}
                        onChange={() =>
                          setProductForm((c) => ({ ...c, isRing: false, availableSizes: [] }))
                        }
                      />
                      No
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="is-ring"
                        checked={productForm.isRing}
                        onChange={() => setProductForm((c) => ({ ...c, isRing: true }))}
                      />
                      Yes
                    </label>
                  </div>
                </div>
                {productForm.isRing ? (
                <div className="field">
                  <label>Ring size variants</label>
                  <div className="hint" style={{ marginBottom: 8 }}>
                    Select every size this ring should be available in. Each size is a storefront size variant.
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {RING_SIZE_OPTIONS.map((size) => {
                      const selected = productForm.availableSizes.includes(size);
                      return (
                        <button
                          key={size}
                          type="button"
                          className={`btn small${selected ? " primary" : ""}`}
                          onClick={() =>
                            setProductForm((current) => ({
                              ...current,
                              availableSizes: selected
                                ? current.availableSizes.filter((item) => item !== size)
                                : [...current.availableSizes, size].sort(
                                    (a, b) => Number(a) - Number(b) || a.localeCompare(b),
                                  ),
                            }))
                          }
                        >
                          {size}
                        </button>
                      );
                    })}
                  </div>
                  <div className="field-row" style={{ marginTop: 10 }}>
                    <div className="field">
                      <label>Add custom size</label>
                      <input
                        value={customRingSize}
                        onChange={(e) => setCustomRingSize(e.target.value)}
                        placeholder="e.g. 12.5 or US 7"
                      />
                    </div>
                    <div className="field" style={{ justifyContent: "flex-end" }}>
                      <label>&nbsp;</label>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          const size = customRingSize.trim();
                          if (!size) return;
                          setProductForm((current) => ({
                            ...current,
                            availableSizes: current.availableSizes.includes(size)
                              ? current.availableSizes
                              : [...current.availableSizes, size],
                          }));
                          setCustomRingSize("");
                        }}
                      >
                        Add size variant
                      </button>
                    </div>
                  </div>
                  {productForm.availableSizes.length ? (
                    <div className="hint" style={{ marginTop: 8 }}>
                      Size variants: {productForm.availableSizes.join(", ")}
                    </div>
                  ) : (
                    <div className="hint" style={{ marginTop: 8 }}>
                      Choose at least one size before saving.
                    </div>
                  )}
                </div>
                ) : null}

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
                      setProductImages((current) =>
                        dedupeProductImageItems([...current, ...additions]),
                      );
                      event.target.value = "";
                    }}
                  />
                  <div className="hint">
                    Drag images to reorder. The first image is Primary (catalog thumbnail). Use Set primary on any photo.
                  </div>
                  {productImages.length ? (
                    <div className="upload-gallery">
                      {dedupeProductImageItems(productImages).map((image, index) => (
                        <div
                          key={image.key}
                          className={`upload-gallery-item${dragImageKey === image.key ? " dragging" : ""}`}
                          draggable
                          onDragStart={() => setDragImageKey(image.key)}
                          onDragOver={(event) => {
                            event.preventDefault();
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            if (dragImageKey) reorderProductImages(dragImageKey, image.key);
                            setDragImageKey(null);
                          }}
                          onDragEnd={() => setDragImageKey(null)}
                        >
                          <div className="upload-drag-handle" title="Drag to reorder">
                            ⋮⋮
                          </div>
                          <img src={image.preview} alt={`Product ${index + 1}`} />
                          {index === 0 ? (
                            <div className="hint" style={{ marginTop: 4 }}>
                              Primary
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="btn small"
                              style={{ marginTop: 4 }}
                              onClick={() => makePrimaryImage(image.key)}
                            >
                              Set primary
                            </button>
                          )}
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
                      // Selecting collections must never remount / rehydrate product images
                      setProductImages((current) => dedupeProductImageItems(current));
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
                  {enableVariants
                    ? editingVariantKey
                      ? "Edit colour × purity variant"
                      : "Colour × purity variants"
                    : "Product metal & pricing"}
                </div>
                {enableVariants && editingVariantKey ? (
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
                    <label>Net gold weight (g)</label>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={
                        Number.isFinite(variantForm.netGoldWeight)
                          ? variantForm.netGoldWeight
                          : ""
                      }
                      onChange={(e) =>
                        setVariantForm((c) => ({
                          ...c,
                          netGoldWeight: Number(e.target.value) || 0,
                        }))
                      }
                      placeholder="0.00"
                    />
                    <div className="hint">Gold weight. Entered separately from gross weight.</div>
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

                <div className="field">
                    <label>Stone?</label>
                    <select
                      value={String(variantForm.stoneIncluded)}
                      onChange={(e) =>
                        setVariantForm((c) => {
                          const included = e.target.value === "true";
                          return withGrossFromNet({
                            ...c,
                            stoneIncluded: included,
                            stones: included
                              ? c.stones?.length
                                ? c.stones
                                : [emptyStoneLine()]
                              : [],
                          });
                        })
                      }
                    >
                      <option value="false">Without stone</option>
                      <option value="true">With stone</option>
                    </select>
                  </div>

                {variantForm.stoneIncluded ? (
                  <div style={{ display: "grid", gap: 14 }}>
                    {(variantForm.stones?.length ? variantForm.stones : [emptyStoneLine()]).map((stone) => {
                      const quoted = quotedStones.find((item) => item.stone.key === stone.key);
                      const quote = quoted?.quote;
                      const diamond = isDiamondStone(stone.stoneType);
                      return (
                        <div
                          key={stone.key}
                          style={{
                            border: "1px solid var(--line, #e6e4e3)",
                            padding: 12,
                            display: "grid",
                            gap: 10,
                          }}
                        >
                          <div className="field-row">
                            <div className="field">
                              <label>Stone type</label>
                              <select
                                value={stone.stoneType}
                                onChange={(e) => updateStoneLine(stone.key, { stoneType: e.target.value })}
                              >
                                {stoneOptions.map((name) => (
                                  <option key={name} value={name}>
                                    {name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {diamond ? (
                              <div className="field">
                                <label>Total carat weight</label>
                                <input
                                  type="number"
                                  step="any"
                                  min="0"
                                  placeholder="2.000"
                                  value={Number.isFinite(stone.weight) ? stone.weight : ""}
                                  onChange={(e) =>
                                    updateStoneLine(stone.key, { weight: Number(e.target.value) })
                                  }
                                />
                              </div>
                            ) : null}
                          </div>
                          {diamond ? (
                            <>
                              <div className="field-row4">
                                <div className="field">
                                  <label>No. of diamonds</label>
                                  <input
                                    type="number"
                                    step="1"
                                    min="1"
                                    placeholder="50"
                                    value={stone.diamondCount || ""}
                                    onChange={(e) =>
                                      updateStoneLine(stone.key, {
                                        diamondCount: Number(e.target.value),
                                      })
                                    }
                                  />
                                </div>
                                <div className="field">
                                  <label>Stone weight (g)</label>
                                  <input
                                    type="text"
                                    readOnly
                                    disabled
                                    value={stone.weight ? (stone.weight / 5).toFixed(3) : "0.000"}
                                  />
                                </div>
                                <div className="field">
                                  <label>Diamond quality</label>
                                  <select
                                    value={stone.diamondQualityId || ""}
                                    onChange={(e) =>
                                      updateStoneLine(stone.key, { diamondQualityId: e.target.value })
                                    }
                                  >
                                    <option value="">Select color + clarity…</option>
                                    {diamondQualities.map((quality) => (
                                      <option key={quality.id} value={quality.id}>
                                        {quality.name}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                <div className="field">
                                  <label>Cut / shape</label>
                                  <select
                                    value={stone.diamondCategory}
                                    onChange={(e) =>
                                      updateStoneLine(stone.key, { diamondCategory: e.target.value })
                                    }
                                  >
                                    {Array.from(
                                      new Set([
                                        ...DEFAULT_DIAMOND_CUTS,
                                        ...(stone.diamondCategory ? [stone.diamondCategory] : []),
                                      ]),
                                    ).map((cutName) => (
                                      <option key={cutName} value={cutName}>
                                        {cutName}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </div>
                              {quote && "ok" in quote && quote.ok && "averageCarat" in quote ? (
                                <div className="hint">
                                  Avg {quote.averageCarat.toFixed(4)} ct/stone ({quote.averageCents.toFixed(2)} cents)
                                  {" "}→ {quote.qualityName} slab {formatCentsRange(quote.slabFrom, quote.slabTo)}
                                  {" "}→ {formatINR(quote.pricePerCarat)}/ct
                                  {" "}→ diamond value {formatINR(quote.diamondValue)}
                                </div>
                              ) : (
                                <div className="hint" style={{ color: "var(--red)" }}>
                                  {quote && "message" in quote ? String(quote.message) : "Select diamond quality to quote."}
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="field">
                              <label>Gemstone price (flat)</label>
                              <input
                                type="number"
                                step="any"
                                min="0"
                                value={Number.isFinite(stone.rate) ? stone.rate : ""}
                                onChange={(e) =>
                                  updateStoneLine(stone.key, { rate: Number(e.target.value), rateMode: "flat" })
                                }
                              />
                              <div className="hint">
                                Flat charge for this gemstone. Weight is not used.
                              </div>
                            </div>
                          )}
                          {(variantForm.stones || []).length > 1 ? (
                            <button
                              type="button"
                              className="btn small"
                              onClick={() =>
                                setVariantForm((current) =>
                                  withGrossFromNet({
                                    ...current,
                                    stones: current.stones.filter((item) => item.key !== stone.key),
                                  }),
                                )
                              }
                            >
                              Remove stone
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        setVariantForm((current) =>
                          withGrossFromNet({
                            ...current,
                            stones: [...(current.stones || []), emptyStoneLine(stoneOptions[1] || "Diamond")],
                          }),
                        )
                      }
                    >
                      Add another stone
                    </button>
                    {gemstones.length === 0 ? (
                      <div className="hint">
                        Gemstones (Ruby, Emerald, etc.) are managed under Metals &amp; purity → Gemstones.
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="field">
                  <label>Gross weight (g)</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={
                      Number.isFinite(variantForm.grossWeight) ? variantForm.grossWeight : ""
                    }
                    onChange={(e) =>
                      setVariantForm((c) => ({
                        ...c,
                        grossWeight: Number(e.target.value) || 0,
                      }))
                    }
                    placeholder="0.00"
                  />
                  <div className="hint">
                    Full piece weight. Independent of net gold.
                  </div>
                </div>

                {productForm.pricingMode === "auto" ? (
                  <div className="field">
                    <label>Wastage</label>
                    <ChargeBasisRadios
                      name="wastage-basis"
                      value={variantForm.wastageType}
                      onChange={(type) => setVariantForm((c) => ({ ...c, wastageType: type }))}
                    />
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
                    <div className="hint">
                      {normalizeMakingChargeType(variantForm.wastageType) === "per_gram"
                        ? "₹ per gram of net gold"
                        : normalizeMakingChargeType(variantForm.wastageType) === "flat"
                          ? "Flat wastage amount"
                          : "Percent extra gold on net weight"}
                    </div>
                  </div>
                ) : null}

                {productForm.pricingMode === "manual" ? (
                  <div className="field">
                    <label>Direct sell price (₹)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={Number.isFinite(variantForm.manualPrice) ? variantForm.manualPrice : ""}
                      onChange={(e) =>
                        setVariantForm((c) => ({
                          ...c,
                          manualPrice: Number(e.target.value),
                        }))
                      }
                    />
                    <div className="hint">This amount is saved as the Shopify sell price. No gold or GST formula is applied.</div>
                  </div>
                ) : (
                <div className="field-row">
                  <div className="field">
                    <label>Making charge</label>
                    <ChargeBasisRadios
                      name="making-basis"
                      value={variantForm.makingChargeType}
                      onChange={(type) => setVariantForm((c) => ({ ...c, makingChargeType: type }))}
                    />
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
                    <div className="hint">
                      {normalizeMakingChargeType(variantForm.makingChargeType) === "per_gram"
                        ? "₹ per gram of net gold"
                        : normalizeMakingChargeType(variantForm.makingChargeType) === "percent"
                          ? "Percent of gold value (including wastage)"
                          : "Flat making amount"}
                    </div>
                  </div>
                  <div className="field">
                    <label>Other charges (₹)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={Number.isFinite(variantForm.otherCharges) ? variantForm.otherCharges : ""}
                      onChange={(e) =>
                        setVariantForm((c) => ({
                          ...c,
                          otherCharges: Number(e.target.value),
                        }))
                      }
                    />
                  </div>
                </div>
                )}

                {productForm.pricingMode === "auto" ? (
                  <div className="field">
                    <label>GST %</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={Number.isFinite(variantForm.gstPercent) ? variantForm.gstPercent : 3}
                      onChange={(e) =>
                        setVariantForm((c) => ({
                          ...c,
                          gstPercent: Number(e.target.value),
                        }))
                      }
                    />
                    <div className="hint">
                      GST applies on gold + wastage + stones + making + other charges. Default 3%.
                    </div>
                  </div>
                ) : null}

                <label className="check-row">
                  <input
                    type="checkbox"
                    className="check-input"
                    checked={enableVariants}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setEnableVariants(checked);
                      if (!checked) {
                        setEditingVariantKey(null);
                        if (variants[0]) {
                          setVariantForm({
                            ...variants[0],
                            imagePreview:
                              variants[0].imagePreview || variants[0].existingImageUrl || "",
                          });
                          setDraftPreview(
                            variants[0].imagePreview || variants[0].existingImageUrl || "",
                          );
                        }
                        setVariants((current) => (current[0] ? [current[0]] : []));
                      }
                    }}
                  />
                  <span className="check-copy">
                    <span className="check-title">Enable colour × purity variants</span>
                    <span className="check-hint">
                      Off = single product · On = multiple metal/purity variants
                    </span>
                  </span>
                </label>

                {enableVariants ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                    <button
                      type="button"
                      className="btn primary"
                      onClick={saveVariantToList}
                      disabled={
                        (variantForm.stoneIncluded && !diamondQuote.ok) ||
                        (productForm.pricingMode === "manual" &&
                          !(Number(variantForm.manualPrice) > 0))
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
                ) : (
                  <div className="hint" style={{ marginTop: 8 }}>
                    This product will be saved as a single direct item (no variant list).
                  </div>
                )}

                {enableVariants && variantsForSave.length > 0 ? (
                  <div className="variant-list">
                    {variantsForSave.map((variant) => {
                      const purity = purities.find((p) => p.id === variant.purityId);
                      const price = calculateProductPrice(
                        variantPriceInput(variant, goldPricePerGram, productForm.pricingMode),
                      ).total;
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
                                    Number(variant.netGoldWeight) ||
                                      Math.max(
                                        0,
                                        variant.grossWeight - stoneGramsOnVariant(variant),
                                      ),
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
              {productForm.pricingMode === "manual" ? (
                <div className="summary-row">
                  <span className="l">Direct sell price</span>
                  <span className="v">{formatINR(preview.total)}</span>
                </div>
              ) : (
                <>
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
                <span className="v">{formatINR(preview.netGoldValue)}</span>
              </div>
              <div className="summary-row">
                <span className="l">Wastage</span>
                <span className="v">{formatINR(preview.wastageValue)}</span>
              </div>
              <div className="summary-row">
                <span className="l">Making charge</span>
                <span className="v">{formatINR(preview.makingCharge)}</span>
              </div>
              {variantForm.stoneIncluded
                ? quotedStones.map(({ stone, quote }) => (
                    <div className="summary-row" key={stone.key}>
                      <span className="l">{stone.stoneType || "Stone"}</span>
                      <span className="v">
                        {isDiamondStone(stone.stoneType)
                          ? `${(stone.weight || 0).toFixed(3)} ct${
                              quote.ok && "diamondValue" in quote
                                ? ` · ${formatINR(quote.diamondValue)}`
                                : ""
                            }`
                          : formatINR(stoneChargeForLine(stone))}
                      </span>
                    </div>
                  ))
                : null}
              <div className="summary-row">
                <span className="l">Stone charges</span>
                <span className="v">{formatINR(preview.stoneCharge)}</span>
              </div>
              {productForm.pricingMode === "auto" ? (
                <>
                  <div className="summary-row">
                    <span className="l">Other charges</span>
                    <span className="v">{formatINR(preview.otherCharges)}</span>
                  </div>
                  <div className="summary-row">
                    <span className="l">Subtotal</span>
                    <span className="v">{formatINR(preview.subtotal)}</span>
                  </div>
                  <div className="summary-row">
                    <span className="l">GST ({preview.gstPercent}%)</span>
                    <span className="v">{formatINR(preview.gstValue)}</span>
                  </div>
                </>
              ) : null}
                </>
              )}
              <div className="summary-total">
                <span className="l">Total payable</span>
                <span className="v">{formatINR(preview.total)}</span>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button
                  className="btn primary"
                  style={{ flex: 1, justifyContent: "center" }}
                  type="submit"
                  disabled={
                    busy ||
                    (enableVariants
                      ? variantsForSave.length === 0
                      : (!(Number(variantForm.netGoldWeight) > 0) &&
                          !(Number(variantForm.grossWeight) > 0)) ||
                        (productForm.pricingMode === "manual" &&
                          !(Number(variantForm.manualPrice) > 0)) ||
                        (variantForm.stoneIncluded && !diamondQuote.ok))
                  }
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
                Saving automatically pushes this product to Shopify (title, description, images, price, collections).
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
                    <tr
                      key={product.id}
                      className="clickable-row"
                      onClick={() => setViewingProductId(product.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setViewingProductId(product.id);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-label={`View ${product.name}`}
                    >
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
                        <div
                          className="row-actions"
                          style={{ justifyContent: "flex-end" }}
                          onClick={(e) => e.stopPropagation()}
                        >
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

          {viewingProduct ? (
            <div
              className="modal-backdrop"
              role="presentation"
              onClick={() => setViewingProductId(null)}
            >
              <div
                className="modal-card"
                role="dialog"
                aria-modal="true"
                aria-labelledby="product-view-title"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="modal-head">
                  <div>
                    <h3 id="product-view-title" className="modal-title">
                      {viewingProduct.name}
                    </h3>
                    <div className="hint" style={{ marginTop: 2 }}>
                      SKU {viewingProduct.sku} · {viewingProduct.gender} ·{" "}
                      {viewingProduct.status}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => setViewingProductId(null)}
                  >
                    Close
                  </button>
                </div>

                <div className="modal-body">
                  <div className="modal-media">
                    {viewingProduct.images[0]?.url || viewingProduct.imageUrl ? (
                      <img
                        src={viewingProduct.images[0]?.url || viewingProduct.imageUrl}
                        alt={viewingProduct.name}
                      />
                    ) : (
                      <div className="prod-thumb" style={{ width: 96, height: 96, fontSize: 28 }}>
                        {viewingProduct.initials}
                      </div>
                    )}
                    {viewingProduct.images.length > 1 ? (
                      <div className="modal-thumbs">
                        {viewingProduct.images.map((image) => (
                          <img key={image.url} src={image.url} alt="" />
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="modal-details">
                    <div className="summary-row">
                      <span className="l">Collections</span>
                      <span className="v">{viewingProduct.collection}</span>
                    </div>
                    <div className="summary-row">
                      <span className="l">From price</span>
                      <span className="v">{formatINR(viewingProduct.fromPrice)}</span>
                    </div>
                    <div className="summary-row">
                      <span className="l">Shopify</span>
                      <span className="v">
                        {viewingProduct.synced ? "Synced" : "Not synced"}
                      </span>
                    </div>
                    <div className="summary-row" style={{ alignItems: "flex-start" }}>
                      <span className="l">Description</span>
                      <span className="v" style={{ textAlign: "left", maxWidth: 320 }}>
                        {viewingProduct.description || "—"}
                      </span>
                    </div>
                    <div className="summary-row">
                      <span className="l">Width</span>
                      <span className="v">{viewingProduct.dimensionWidth || "—"}</span>
                    </div>
                    <div className="summary-row">
                      <span className="l">Height</span>
                      <span className="v">{viewingProduct.dimensionHeight || "—"}</span>
                    </div>
                    <div className="summary-row">
                      <span className="l">Sizes</span>
                      <span className="v">
                        {viewingProduct.availableSizes?.length
                          ? viewingProduct.availableSizes.join(", ")
                          : "—"}
                      </span>
                    </div>

                    <div className="panel-title" style={{ marginTop: 16, marginBottom: 8 }}>
                      Variants ({viewingProduct.variants.length})
                    </div>
                    <div className="variant-list">
                      {viewingProduct.variants.map((variant) => (
                        <div key={variant.id} className="variant-chip">
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 8,
                              alignItems: "center",
                            }}
                          >
                            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                              {variant.imageUrl ? (
                                <img src={variant.imageUrl} alt="" className="upload-thumb" />
                              ) : null}
                              <div>
                                <strong>{variant.label}</strong>
                                <div className="hint">
                                  Gross {formatGrams(variant.grossWeight)} · Wastage{" "}
                                  {variant.wastagePercent}% · Making{" "}
                                  {normalizeMakingChargeType(variant.makingChargeType) === "percent"
                                    ? `${variant.makingChargeValue}%`
                                    : normalizeMakingChargeType(variant.makingChargeType) === "per_gram"
                                      ? `${formatINR(variant.makingChargeValue)}/g`
                                      : formatINR(variant.makingChargeValue)}
                                </div>
                              </div>
                            </div>
                            <span className="mono">{formatINR(variant.price)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="modal-foot">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => {
                      const id = viewingProduct.id;
                      setViewingProductId(null);
                      startEdit(id);
                    }}
                  >
                    Edit product
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setViewingProductId(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
