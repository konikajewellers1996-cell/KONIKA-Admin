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
import { deleteProductFromShopify, syncSingleProductToShopify } from "../lib/shopify-catalog.server";
import {
  readFormFile,
  uploadImageToShopifyFiles,
} from "../lib/shopify-files.server";

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
  diamondSpecId?: string | null;
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
  try {
    const parsed = JSON.parse(imagesJson || "[]") as Array<{
      url?: string;
      shopifyFileId?: string | null;
    }>;
    if (Array.isArray(parsed) && parsed.length) {
      return parsed
        .filter((item) => item?.url)
        .map((item) => ({
          url: String(item.url),
          shopifyFileId: item.shopifyFileId ?? null,
        }));
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
  diamondSpecId: "",
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

  const [settings, collections, metals, purities, products, diamondSpecs] = await Promise.all([
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
        variants: { include: { metal: true, purity: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.diamondSpec.findMany({ orderBy: [{ caratFrom: "asc" }, { caratTo: "asc" }] }),
  ]);

  const goldPricePerGram = settings?.goldPricePerGram ?? 6500;

  const catalog = products.map((product) => {
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
      description: product.description,
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
        diamondSpecId: variant.diamondSpecId,
        wastagePercent: variant.wastagePercent,
        makingChargeType: variant.makingChargeType as MakingChargeType,
        makingChargeValue: variant.makingChargeValue,
        stoneRate: variant.stoneRate,
        status: variant.status as "Active" | "Draft",
        imageUrl: variant.imageUrl,
        shopifyFileId: variant.shopifyFileId,
        label: `${variant.metalColor} · ${variant.purity.label}`,
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

  return { goldPricePerGram, collections, metals, purities, catalog, diamondSpecs };
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

    if (intent !== "create" && intent !== "update") {
      return { ok: false, message: "Unknown action." };
    }

    const editingId = String(form.get("productId") || "") || null;
    if (intent === "update" && !editingId) {
      return { ok: false, message: "Missing product id for update." };
    }

    const sku = String(form.get("sku") || "").trim();
    const name = String(form.get("name") || "").trim();
    const description = String(form.get("description") || "").trim();
    const gender = String(form.get("gender") || "Unisex");
    const collectionIds = form.getAll("collectionIds").map(String);
    const status = String(form.get("status") || "Active");
    const variantsRaw = String(form.get("variantsJson") || "[]");

    if (!sku || !name) {
      return { ok: false, message: "SKU and product name are required." };
    }

    let drafts: VariantDraft[] = [];
    try {
      drafts = JSON.parse(variantsRaw) as VariantDraft[];
    } catch {
      return { ok: false, message: "Invalid variant data." };
    }

    if (!drafts.length) {
      return { ok: false, message: "Add at least one colour × purity variant." };
    }

    if (
      drafts.some(
        (draft) => !(Number(draft.grossWeight) > 0) || !draft.metalId || !draft.purityId,
      )
    ) {
      return {
        ok: false,
        message: "Each variant needs metal colour, purity, and gross weight (grams).",
      };
    }

    const existingImages = parseProductImages(
      String(form.get("existingImagesJson") || "[]"),
    );

    const productImages: Array<{ url: string; shopifyFileId: string | null }> = [
      ...existingImages,
    ];

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

    const variantCreateData = drafts.map((draft, index) => ({
      metalId: draft.metalId,
      purityId: draft.purityId,
      metalColor: draft.metalColor,
      grossWeight: Number(draft.grossWeight) || 0,
      stoneIncluded: Boolean(draft.stoneIncluded),
      stoneType: draft.stoneIncluded ? draft.stoneType : "None",
      stoneWeight: draft.stoneIncluded ? Number(draft.stoneWeight) || 0 : 0,
      diamondCategory:
        draft.stoneIncluded && draft.stoneType === "Diamond" ? draft.diamondCategory : "",
      diamondSpecId:
        draft.stoneIncluded && draft.stoneType === "Diamond" ? draft.diamondSpecId || null : null,
      wastagePercent: Number(draft.wastagePercent) || 0,
      makingChargeType: draft.makingChargeType,
      makingChargeValue: Number(draft.makingChargeValue) || 0,
      stoneRate: Number(draft.stoneRate) || 0,
      imageUrl: variantAssets[index]?.imageUrl || "",
      shopifyFileId: variantAssets[index]?.shopifyFileId || null,
      status: draft.status,
    }));

    let productId = editingId;

    if (intent === "update" && editingId) {
      const current = await prisma.product.findUnique({ where: { id: editingId } });
      if (!current) return { ok: false, message: "Product not found." };

      await prisma.productVariant.deleteMany({ where: { productId: editingId } });
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
          variants: { create: variantCreateData },
          collections: {
            set: collectionIds.map((id) => ({ id })),
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
            connect: collectionIds.map((id) => ({ id })),
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
  const { goldPricePerGram, collections, metals, purities, catalog, diamondSpecs } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [searchParams, setSearchParams] = useSearchParams();
  const busy = navigation.state !== "idle";
  const view = searchParams.get("view") === "catalog" ? "catalog" : "edit";
  const showForm = view === "edit";

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

  useEffect(() => {
    if (actionData && "clearEdit" in actionData && actionData.clearEdit && actionData.ok) {
      resetForm();
      setSearchParams({ view: "catalog" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

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
        stoneRate: variantForm.stoneRate,
        goldPricePerGram: adjustedGoldPrice,
      }),
    [variantForm, adjustedGoldPrice],
  );

  const variantsForSave = useMemo(() => {
    // While editing an existing list item, show the live form values in that row.
    if (editingVariantKey) {
      return variants.map((v) =>
        v.key === editingVariantKey
          ? {
              ...variantForm,
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
        key: emptyVariant().key,
        imagePreview: draftPreview || variantForm.imagePreview,
      });
    }
    return list;
  }, [variants, variantForm, draftPreview, editingVariantKey]);

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

  function resetForm() {
    setEditingId(null);
    setEditingVariantKey(null);
    setProductForm(emptyProductForm());
    setSelectedCollections([]);
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
    setSearchParams({ view: "edit" });
  };

  const startEdit = (productId: string) => {
    const product = catalog.find((p) => p.id === productId);
    if (!product) return;

    setEditingId(product.id);
    setEditingVariantKey(null);
    setProductForm({
      sku: product.sku,
      name: product.name,
      description: product.description,
      gender: product.gender,
      collectionIds: product.collectionIds,
      status: product.status,
    });
    const selectedColls = product.collectionIds.map((id) => {
      const coll = collections.find((c) => c.id === id);
      return { id, name: coll?.name ?? "Unknown" };
    }).filter((c) => c.id);
    setSelectedCollections(selectedColls);
    setCollectionSelectVal("");
    setProductImages(
      product.images.map((image, index) => ({
        key: `saved-${index}-${image.url.slice(-12)}`,
        url: image.url,
        shopifyFileId: image.shopifyFileId,
        preview: image.url,
      })),
    );
    setProductFileMap({});
    setVariantFileMap({});
    setDraftFile(null);
    if (productImageInputRef.current) productImageInputRef.current.value = "";

    setVariants(
      product.variants.map((variant) => ({
        key: variant.id,
        id: variant.id,
        metalId: variant.metalId,
        purityId: variant.purityId,
        metalColor: variant.metalColor,
        grossWeight: variant.grossWeight,
        stoneIncluded: variant.stoneIncluded,
        stoneType: variant.stoneType,
        stoneWeight: variant.stoneWeight,
        diamondCategory: variant.diamondCategory || "Round",
        diamondSpecId: variant.diamondSpecId,
        wastagePercent: variant.wastagePercent,
        makingChargeType: variant.makingChargeType,
        makingChargeValue: variant.makingChargeValue,
        stoneRate: variant.stoneRate,
        status: variant.status,
        imagePreview: variant.imageUrl || "",
        existingImageUrl: variant.imageUrl || "",
        existingFileId: variant.shopifyFileId,
      })),
    );
    setVariantForm(
      emptyVariant(
        product.variants[0]?.metalId || firstMetal?.id || "",
        product.variants[0]?.purityId || firstPurity?.id || "",
        product.variants[0]?.metalColor || firstMetal?.color || "",
      ),
    );
    setDraftPreview("");
    setSearchParams({ view: "edit" });
  };

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
                ...variantForm,
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
        ...variantForm,
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
      if (draftFile) nextVariantFiles[editingVariantKey] = draftFile;
      list = list.map((v) =>
        v.key === editingVariantKey
          ? {
              ...variantForm,
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
      if (canIncludeDraft) {
        const draftKey = emptyVariant().key;
        list.push({
          ...variantForm,
          key: draftKey,
          imagePreview: draftPreview || variantForm.imagePreview || "",
        });
        if (draftFile) nextVariantFiles[draftKey] = draftFile;
      }
    }

    if (!list.length) return;

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
          <div className="page-title">
            {showForm ? (editingId ? "Edit jewelry" : "Add jewelry") : "Jewelry catalog"}
          </div>
          <div className="page-sub">
            {showForm
              ? editingId
                ? "Update details, images, and variants — then Sync all to Shopify."
                : "Upload product & variant images, save locally, then Sync all to Shopify."
              : `${filteredCatalog.length} product${filteredCatalog.length === 1 ? "" : "s"} in catalog`}
          </div>
        </div>
        <div className="head-actions">
          {showForm ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                resetForm();
                setSearchParams({ view: "catalog" });
              }}
            >
              View catalog
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={startCreate}>
              Add jewelry
            </button>
          )}
        </div>
      </div>

      {actionData?.message ? (
        <div className={`flash ${actionData.ok ? "ok" : "err"}`}>{actionData.message}</div>
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
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <select
                      style={{ flex: 1 }}
                      value={collectionSelectVal}
                      onChange={(e) => setCollectionSelectVal(e.target.value)}
                    >
                      <option value="">Select a collection...</option>
                      {collections
                        .filter((c) => !selectedCollections.some((sc) => sc.id === c.id))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} {c.parent ? `(Sub of ${c.parent.name})` : ""}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      className="btn"
                      style={{ height: 42, padding: "0 16px" }}
                      onClick={() => {
                        if (!collectionSelectVal) return;
                        const coll = collections.find((c) => c.id === collectionSelectVal);
                        if (coll) {
                          setSelectedCollections((prev) => [...prev, { id: coll.id, name: coll.name }]);
                        }
                        setCollectionSelectVal("");
                      }}
                    >
                      + Add
                    </button>
                  </div>

                  {/* Render the chips list */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                    {selectedCollections.map((coll) => (
                      <div
                        key={coll.id}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "6px 12px",
                          borderRadius: 20,
                          fontSize: "0.9em",
                          backgroundColor: "#f0f0f0",
                          border: "1px solid #ddd",
                        }}
                      >
                        <span>{coll.name}</span>
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
                            setSelectedCollections((prev) => prev.filter((c) => c.id !== coll.id));
                          }}
                        >
                          &times;
                        </button>
                        {/* Hidden input to submit via standard form POST */}
                        <input type="hidden" name="collectionIds" value={coll.id} />
                      </div>
                    ))}
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
                      value={variantForm.grossWeight || ""}
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
                      <div className="field-row4">
                        <div className="field">
                          <label>Stone type</label>
                          <select
                            value={variantForm.stoneType}
                            onChange={(e) =>
                              setVariantForm((c) => ({
                                ...c,
                                stoneType: e.target.value,
                                diamondSpecId: "",
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
                          <label>Carat weight</label>
                          <input
                            type="number"
                            step="0.001"
                            min="0"
                            placeholder="0.000"
                            disabled={Boolean(variantForm.diamondSpecId)}
                            value={variantForm.stoneWeight || ""}
                            onChange={(e) =>
                              setVariantForm((c) => ({
                                ...c,
                                stoneWeight: Number(e.target.value),
                              }))
                            }
                          />
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
                        <div className="field">
                          <label>Stone price (₹)</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="0.00"
                            disabled={Boolean(variantForm.diamondSpecId)}
                            value={variantForm.stoneRate || ""}
                            onChange={(e) =>
                              setVariantForm((c) => ({
                                ...c,
                                stoneRate: Number(e.target.value),
                              }))
                            }
                          />
                        </div>
                      </div>
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
                                diamondSpecId: "",
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
                            value={variantForm.stoneWeight || ""}
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
                            value={variantForm.stoneRate || ""}
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

                    {variantForm.stoneType === "Diamond" ? (
                      <div className="field-row">
                        <div className="field">
                          <label>Inherit Diamond Specification</label>
                          <select
                            value={variantForm.diamondSpecId || ""}
                            onChange={(e) => {
                              const specId = e.target.value;
                              const spec = diamondSpecs.find((s) => s.id === specId);
                              if (spec) {
                                setVariantForm((c) => ({
                                  ...c,
                                  diamondSpecId: specId,
                                  diamondCategory: spec.cut || c.diamondCategory,
                                  stoneWeight: spec.caratFrom ?? spec.caratTo ?? c.stoneWeight,
                                  stoneRate: spec.price,
                                }));
                              } else {
                                setVariantForm((c) => ({
                                  ...c,
                                  diamondSpecId: "",
                                }));
                              }
                            }}
                          >
                            <option value="">Select inherited spec...</option>
                            {diamondSpecs.map((spec) => {
                              const rangeText =
                                spec.caratFrom !== null && spec.caratFrom !== undefined && spec.caratTo !== null && spec.caratTo !== undefined
                                  ? `${Number(spec.caratFrom).toFixed(3)} - ${Number(spec.caratTo).toFixed(3)} ct`
                                  : spec.caratFrom !== null && spec.caratFrom !== undefined
                                    ? `${Number(spec.caratFrom).toFixed(3)} ct`
                                    : spec.caratTo !== null && spec.caratTo !== undefined
                                      ? `${Number(spec.caratTo).toFixed(3)} ct`
                                      : "custom";

                              return (
                                <option key={spec.id} value={spec.id}>
                                  {spec.name || "Diamond"} · {spec.cut || "Shape not set"} · {rangeText} · {spec.color || "Color not set"} · {spec.clarity || "Clarity not set"} (₹{new Intl.NumberFormat("en-IN").format(spec.price)})
                                </option>
                              );
                            })}
                          </select>
                        </div>
                        <div className="field">
                          <label>Diamond category (Cut)</label>
                          <select
                            disabled={Boolean(variantForm.diamondSpecId)}
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
                                "Round",
                                "Princess",
                                "Oval",
                                "Cushion",
                                "Emerald",
                                "Marquise",
                                "Pear",
                                "Radiant",
                                "Heart",
                                "Asscher",
                                "Baguette",
                                "Trilliant",
                                ...diamondSpecs.map((s) => s.cut).filter((c): c is string => Boolean(c)),
                                ...(variantForm.diamondCategory ? [variantForm.diamondCategory] : []),
                              ])
                            ).map((cutName) => (
                              <option key={cutName} value={cutName}>
                                {cutName}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ) : null}
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
                  <button type="button" className="btn primary" onClick={saveVariantToList}>
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
                    <span className="l">Carat weight</span>
                    <span className="v">{(variantForm.stoneWeight || 0).toFixed(3)} ct</span>
                  </div>
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
          <div className="toolbar">
            <div className="search-wrap">
              <input
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
                        <div className="row-actions">
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
