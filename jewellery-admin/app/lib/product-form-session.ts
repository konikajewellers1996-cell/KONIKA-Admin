const STORAGE_KEY = "konika-admin-product-form-session";

export type ProductFormSessionPayload = {
  editingId: string | null;
  productForm: unknown;
  variantForm: unknown;
  variants: unknown;
  enableVariants: boolean;
  selectedCollections: Array<{ id: string; name: string }>;
  productImages: Array<{
    key: string;
    url: string;
    shopifyFileId: string | null;
    preview: string;
  }>;
  editingVariantKey: string | null;
  draftPreview: string;
};

function canUseStorage() {
  return typeof window !== "undefined" && typeof sessionStorage !== "undefined";
}

function stripBlobUrl(url: string) {
  return url.startsWith("blob:") ? "" : url;
}

export function saveProductFormSession(payload: ProductFormSessionPayload) {
  if (!canUseStorage()) return;
  try {
    const safe: ProductFormSessionPayload = {
      ...payload,
      draftPreview: stripBlobUrl(payload.draftPreview || ""),
      productImages: (payload.productImages || []).map((image) => ({
        ...image,
        preview: stripBlobUrl(image.preview || image.url || ""),
        url: image.url || "",
      })),
      variantForm: payload.variantForm
        ? {
            ...(payload.variantForm as object),
            imagePreview: stripBlobUrl(
              String((payload.variantForm as { imagePreview?: string }).imagePreview || ""),
            ),
          }
        : payload.variantForm,
      variants: Array.isArray(payload.variants)
        ? payload.variants.map((variant) => ({
            ...(variant as object),
            imagePreview: stripBlobUrl(
              String((variant as { imagePreview?: string }).imagePreview || ""),
            ),
          }))
        : payload.variants,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch {
    // ignore quota / private mode
  }
}

export function loadProductFormSession(): ProductFormSessionPayload | null {
  if (!canUseStorage()) return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ProductFormSessionPayload;
  } catch {
    return null;
  }
}

export function clearProductFormSession() {
  if (!canUseStorage()) return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function productFormSessionIsEmpty(payload: ProductFormSessionPayload | null) {
  if (!payload) return true;
  const form = (payload.productForm || {}) as { name?: string; sku?: string };
  const variants = Array.isArray(payload.variants) ? payload.variants : [];
  const variantForm = (payload.variantForm || {}) as { grossWeight?: number; netGoldWeight?: number };
  return (
    !String(form.name || "").trim() &&
    !String(form.sku || "").trim() &&
    variants.length === 0 &&
    !(Number(variantForm.grossWeight) > 0) &&
    !(Number(variantForm.netGoldWeight) > 0)
  );
}
