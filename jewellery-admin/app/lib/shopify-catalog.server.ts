import { priceToShopifyString, calculateProductPrice, type MakingChargeType } from "./pricing";
import { htmlToPlainText, normalizeImageUrl } from "./text";
import { syncProductJewelleryMetafields } from "./shopify-metafields.server";
import { parseSizeWeights, unionSizes } from "./size-weights";
import { parseStonesJson } from "./stones";
import {
  mergedDiscountLines,
  parseDiscountLines,
  parseDiscountTargets,
  parseStringIdList,
  type CatalogDiscountRule,
} from "./discounts";
import prisma from "../db.server";


async function catalogDiscountRules(): Promise<CatalogDiscountRule[]> {
  const rules = await prisma.discountRule.findMany({ where: { status: "Active" } });
  return rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    code: rule.code,
    isCoupon: rule.isCoupon,
    targets: parseDiscountTargets(rule.targets),
    valueType: rule.valueType === "flat" ? "flat" : "percent",
    value: rule.value,
    collectionIds: parseStringIdList(rule.collectionIds),
    productIds: parseStringIdList(rule.productIds),
    applyAll: rule.applyAll,
    status: rule.status,
  }));
}

type GraphqlClient = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

type SyncVariantInput = {
  id: string;
  skuSuffix: string;
  sku?: string;
  color: string;
  purityLabel: string;
  price: number;
  grossWeight?: number;
  netGoldWeight?: number;
  shopifyVariantId?: string | null;
  status: string;
  imageUrl?: string;
  size?: string;
  sizeWeights?: Array<{
    size: string;
    netGoldWeight: number;
    grossWeight: number;
    price: number;
  }>;
};

type SyncProductInput = {
  title: string;
  description: string;
  sku: string;
  gender: string;
  status: "ACTIVE" | "DRAFT";
  imageUrl?: string;
  imageUrls?: string[];
  variants: SyncVariantInput[];
  sizes?: string[];
};

function optionIsSize(name: string) {
  return /size/i.test(name.trim());
}

function priceForMetal(args: {
  variant: {
    grossWeight: number;
    netGoldWeight: number | null;
    stoneWeight: number;
    stoneIncluded: boolean;
    stoneType: string | null;
    wastagePercent: number;
    makingChargeType: string;
    makingChargeValue: number;
    stoneRate: number;
    stonesJson: string | null;
    otherCharges: number;
    gstPercent: number;
    manualPrice: number | null;
    wastageType: string;
    purity?: { purityValue: number; label: string } | null;
    metalColor: string;
    id: string;
    shopifyVariantId: string | null;
    imageUrl: string | null;
    status: string;
    sku?: string | null;
    sizeWeightsJson?: string | null;
  };
  product: {
    id: string;
    sku: string;
    isRing: boolean;
    pricingMode: string;
    discountsJson: string | null;
    collections: Array<{ id: string }>;
  };
  goldPricePerGram: number;
  rules: CatalogDiscountRule[];
  netGoldWeight: number;
  grossWeight: number;
}) {
  return calculateProductPrice({
    grossWeight: args.grossWeight,
    netGoldWeight: args.netGoldWeight,
    stoneWeight: args.variant.stoneWeight,
    stoneIncluded: args.variant.stoneIncluded,
    stoneType: args.variant.stoneType || undefined,
    wastagePercent: args.variant.wastagePercent,
    makingChargeType: args.variant.makingChargeType as MakingChargeType,
    makingChargeValue: args.variant.makingChargeValue,
    stoneRate: args.variant.stoneRate,
    goldPricePerGram: args.variant.purity
      ? (args.goldPricePerGram / 0.916) * args.variant.purity.purityValue
      : args.goldPricePerGram,
    stones: parseStonesJson(args.variant.stonesJson, {
      stoneIncluded: args.variant.stoneIncluded,
      stoneType: args.variant.stoneType || undefined,
      stoneWeight: args.variant.stoneWeight,
      stoneRate: args.variant.stoneRate,
    }),
    otherCharges: args.variant.otherCharges,
    gstPercent: args.variant.gstPercent,
    pricingMode: args.product.pricingMode,
    manualPrice: args.variant.manualPrice ?? undefined,
    wastageType: args.variant.wastageType,
    discounts: mergedDiscountLines(
      parseDiscountLines(args.product.discountsJson),
      args.rules,
      args.product.id,
      args.product.collections.map((item) => item.id),
    ),
  }).total;
}

type WorkVariant = SyncVariantInput & { originId: string };

function expandShopifyVariants(input: SyncProductInput): {
  rows: WorkVariant[];
  sizes: string[];
} {
  const rows: WorkVariant[] = [];
  for (const variant of input.variants) {
    const weights = (variant.sizeWeights || []).filter((row) => String(row.size || "").trim());
    if (!weights.length) {
      rows.push({
        ...variant,
        originId: variant.id,
        skuSuffix: (variant.sku || variant.skuSuffix || "").replace(/\s+/g, ""),
      });
      continue;
    }
    for (const row of weights) {
      const size = String(row.size).trim();
      const baseSku = (variant.sku || variant.skuSuffix || input.sku || "").replace(/\s+/g, "");
      rows.push({
        ...variant,
        originId: variant.id,
        size,
        grossWeight: row.grossWeight,
        netGoldWeight: row.netGoldWeight,
        price: row.price,
        skuSuffix: `${baseSku}-SZ${size}`.replace(/\s+/g, ""),
      });
    }
  }
  if (rows.length > 100) {
    rows.splice(100);
  }
  return {
    rows,
    sizes: [...new Set(rows.map((row) => String(row.size || "").trim()).filter(Boolean))],
  };
}

async function gql<T = Record<string, unknown>>(
  graphql: GraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
  context = "Shopify API",
): Promise<T> {
  const response = await graphql(query, variables ? { variables } : undefined);
  const json = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    throw new Error(`${context}: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  if (!json.data) {
    throw new Error(`${context}: empty response from Shopify`);
  }

  return json.data;
}

function assertNoUserErrors(
  errors: Array<{ message: string; field?: string[] }> | undefined,
  context: string,
) {
  if (errors?.length) {
    throw new Error(
      `${context}: ${errors
        .map((e) => `${e.field?.join(".") ?? "error"} — ${e.message}`)
        .join("; ")}`,
    );
  }
}

function optionIsColor(name: string) {
  return /^(colour|color)$/i.test(name.trim());
}

function optionIsPurity(name: string) {
  return /^purity$/i.test(name.trim());
}

function isStandaloneDefaultVariant(
  variants: Array<{ title: string; selectedOptions: Array<{ name: string; value: string }> }>,
) {
  if (variants.length !== 1) return false;
  const options = variants[0].selectedOptions || [];
  if (!options.length) return true;
  return options.some(
    (o) =>
      /^title$/i.test(o.name) && /^default title$/i.test(o.value),
  );
}

async function ensureShopifyProductOptions(
  graphql: GraphqlClient,
  productId: string,
  desired: Array<{ name: string; values: string[] }>,
  remoteOptions: Array<{
    id: string;
    name: string;
    optionValues: Array<{ id: string; name: string }>;
  }>,
) {
  if (!desired.length) {
    return { colorName: "Colour", purityName: "Purity", sizeName: "Size" };
  }

  const existingColor = remoteOptions.find((o) => optionIsColor(o.name));
  const existingPurity = remoteOptions.find((o) => optionIsPurity(o.name));
  const existingSize = remoteOptions.find((o) => optionIsSize(o.name));
  const colorName = existingColor?.name || "Colour";
  const purityName = existingPurity?.name || "Purity";
  const sizeName = existingSize?.name || "Size";

  const toCreate: Array<{ name: string; values: Array<{ name: string }> }> = [];
  for (const option of desired) {
    const isColor = optionIsColor(option.name);
    const isPurity = optionIsPurity(option.name);
    const isSize = optionIsSize(option.name);
    const existing = isColor
      ? existingColor
      : isPurity
        ? existingPurity
        : isSize
          ? existingSize
          : remoteOptions.find((o) => o.name === option.name);
    if (!existing) {
      toCreate.push({
        name: isColor ? colorName : isPurity ? purityName : isSize ? sizeName : option.name,
        values: option.values.map((name) => ({ name })),
      });
    }
  }

  if (toCreate.length) {
    const data = await gql<{
      productOptionsCreate: {
        userErrors: Array<{ message: string; field?: string[] }>;
      };
    }>(
      graphql,
      `#graphql
      mutation productOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!, $variantStrategy: ProductOptionCreateVariantStrategy) {
        productOptionsCreate(productId: $productId, options: $options, variantStrategy: $variantStrategy) {
          userErrors { field message }
        }
      }`,
      {
        productId,
        options: toCreate,
        variantStrategy: "LEAVE_AS_IS",
      },
      "Product options create",
    );
    assertNoUserErrors(data.productOptionsCreate.userErrors, "Product options create");
  }

  const refreshed = await gql<{
    product: {
      options: Array<{
        id: string;
        name: string;
        optionValues: Array<{ id: string; name: string }>;
      }>;
    } | null;
  }>(
    graphql,
    `#graphql
    query productOptions($id: ID!) {
      product(id: $id) {
        options {
          id
          name
          optionValues { id name }
        }
      }
    }`,
    { id: productId },
    "Product options",
  );

  const latest = refreshed.product?.options || [];
  for (const option of desired) {
    const isColor = optionIsColor(option.name);
    const isPurity = optionIsPurity(option.name);
    const isSize = optionIsSize(option.name);
    const remote = latest.find((o) =>
      isColor
        ? optionIsColor(o.name)
        : isPurity
          ? optionIsPurity(o.name)
          : isSize
            ? optionIsSize(o.name)
            : o.name === option.name,
    );
    if (!remote) continue;
    const existingNames = new Set(remote.optionValues.map((v) => v.name));
    const optionValuesToAdd = option.values
      .filter((value) => !existingNames.has(value))
      .map((name) => ({ name }));
    if (!optionValuesToAdd.length) continue;

    const updateRes = await gql<{
      productOptionUpdate: {
        userErrors: Array<{ message: string; field?: string[] }>;
      };
    }>(
      graphql,
      `#graphql
      mutation productOptionUpdate($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!]) {
        productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd) {
          userErrors { field message }
        }
      }`,
      {
        productId,
        option: { id: remote.id },
        optionValuesToAdd,
      },
      "Product option values",
    );
    assertNoUserErrors(updateRes.productOptionUpdate.userErrors, "Product option values");
  }

  const resolvedColor = latest.find((o) => optionIsColor(o.name))?.name || colorName;
  const resolvedPurity = latest.find((o) => optionIsPurity(o.name))?.name || purityName;
  const resolvedSize = latest.find((o) => optionIsSize(o.name))?.name || sizeName;
  return { colorName: resolvedColor, purityName: resolvedPurity, sizeName: resolvedSize };
}

export async function syncCollectionToShopify(
  graphql: GraphqlClient,
  name: string,
  existingId?: string | null,
  description?: string,
  imageUrl?: string,
) {
  const collectionInput: Record<string, any> = {
    title: name,
  };

  if (description !== undefined) {
    collectionInput.descriptionHtml = description
      ? `<p>${escapeHtml(htmlToPlainText(description))}</p>`
      : "";
  }

  if (imageUrl !== undefined) {
    collectionInput.image = imageUrl ? { src: imageUrl } : null;
  }

  if (existingId) {
    collectionInput.id = existingId;
    const data = await gql<{
      collectionUpdate: {
        collection: { id: string } | null;
        userErrors: Array<{ message: string; field?: string[] }>;
      };
    }>(
      graphql,
      `#graphql
      mutation collectionUpdate($input: CollectionInput!) {
        collectionUpdate(input: $input) {
          collection { id title }
          userErrors { field message }
        }
      }`,
      { input: collectionInput },
      "Collection update",
    );
    assertNoUserErrors(data.collectionUpdate.userErrors, "Collection update");
    if (!data.collectionUpdate.collection?.id) {
      throw new Error("Collection update: no collection returned");
    }
    return data.collectionUpdate.collection.id;
  }

  const data = await gql<{
    collectionCreate: {
      collection: { id: string } | null;
      userErrors: Array<{ message: string; field?: string[] }>;
    };
  }>(
    graphql,
    `#graphql
    mutation collectionCreate($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id title }
        userErrors { field message }
      }
    }`,
    { input: collectionInput },
    "Collection create",
  );

  assertNoUserErrors(data.collectionCreate.userErrors, "Collection create");
  if (!data.collectionCreate.collection?.id) {
    throw new Error("Collection create: no collection returned");
  }
  return data.collectionCreate.collection.id;
}

export async function deleteCollectionFromShopify(
  graphql: GraphqlClient,
  shopifyCollectionId: string,
) {
  const data = await gql<{
    collectionDelete: {
      deletedCollectionId: string | null;
      userErrors: Array<{ message: string; field?: string[] }>;
    };
  }>(
    graphql,
    `#graphql
    mutation collectionDelete($input: CollectionDeleteInput!) {
      collectionDelete(input: $input) {
        deletedCollectionId
        userErrors { field message }
      }
    }`,
    { input: { id: shopifyCollectionId } },
    "Collection delete",
  );
  assertNoUserErrors(data.collectionDelete.userErrors, "Collection delete");
}

export async function addProductToShopifyCollection(
  graphql: GraphqlClient,
  shopifyCollectionId: string,
  shopifyProductId: string,
) {
  const data = await gql<{
    collectionAddProducts: {
      userErrors: Array<{ message: string; field?: string[] }>;
    };
  }>(
    graphql,
    `#graphql
    mutation collectionAddProducts($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        userErrors { field message }
      }
    }`,
    {
      id: shopifyCollectionId,
      productIds: [shopifyProductId],
    },
    "Add to collection",
  );
  assertNoUserErrors(data.collectionAddProducts.userErrors, "Add to collection");
}

async function publishProductToOnlineStore(
  graphql: GraphqlClient,
  productId: string,
) {
  try {
    const pubs = await gql<{
      publications: { nodes: Array<{ id: string; name: string }> };
    }>(
      graphql,
      `#graphql
      query publications {
        publications(first: 10) {
          nodes { id name }
        }
      }`,
      undefined,
      "Publications",
    );

    const online =
      pubs.publications.nodes.find((p) =>
        /online store/i.test(p.name),
      ) ?? pubs.publications.nodes[0];

    if (!online) return;

    const data = await gql<{
      publishablePublish: {
        userErrors: Array<{ message: string; field?: string[] }>;
      };
    }>(
      graphql,
      `#graphql
      mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          userErrors { field message }
        }
      }`,
      {
        id: productId,
        input: [{ publicationId: online.id }],
      },
      "Publish product",
    );
    assertNoUserErrors(data.publishablePublish.userErrors, "Publish product");
  } catch {
    // Publishing is best-effort; product still exists in Admin.
  }
}

export async function syncProductToShopify(
  graphql: GraphqlClient,
  input: SyncProductInput,
  existingProductId?: string | null,
) {
  const { rows: shopifyRows, sizes } = expandShopifyVariants(input);
  const colors = [...new Set(shopifyRows.map((v) => v.color).filter(Boolean))];
  const purities = [...new Set(shopifyRows.map((v) => v.purityLabel).filter(Boolean))];

  // Determine options structure
  const productOptions: Array<{ name: string; values: Array<{ name: string }> }> = [];
  if (colors.length > 0 && purities.length > 0) {
    productOptions.push({ name: "Colour", values: colors.map((name) => ({ name })) });
    productOptions.push({ name: "Purity", values: purities.map((name) => ({ name })) });
  } else if (colors.length > 0) {
    productOptions.push({ name: "Colour", values: colors.map((name) => ({ name })) });
  } else if (purities.length > 0) {
    productOptions.push({ name: "Purity", values: purities.map((name) => ({ name })) });
  }
  if (sizes.length) {
    productOptions.push({ name: "Size", values: sizes.map((name) => ({ name })) });
  }

  // Check if existingProductId exists on Shopify
  let remoteProduct: {
    id: string;
    media: Array<{ id: string; url: string }>;
    options: Array<{
      id: string;
      name: string;
      optionValues: Array<{ id: string; name: string }>;
    }>;
    variants?: {
      nodes: Array<{
        id: string;
        title: string;
        sku: string;
        selectedOptions: Array<{ name: string; value: string }>;
      }>;
    };
  } | null = null;

  if (existingProductId) {
    try {
      const checkRes = await gql<{
        product: {
          id: string;
          options: Array<{
            id: string;
            name: string;
            optionValues: Array<{ id: string; name: string }>;
          }>;
          media: {
            nodes: Array<{
              id: string;
              preview?: { image?: { url?: string | null } | null } | null;
            }>;
          };
          variants: {
            nodes: Array<{
              id: string;
              title: string;
              sku: string;
              selectedOptions: Array<{ name: string; value: string }>;
            }>;
          };
        } | null;
      }>(
        graphql,
        `#graphql
        query checkProduct($id: ID!) {
          product(id: $id) {
            id
            options {
              id
              name
              optionValues { id name }
            }
            media(first: 50) {
              nodes {
                id
                preview {
                  image {
                    url
                  }
                }
              }
            }
            variants(first: 100) {
              nodes {
                id
                title
                sku
                selectedOptions { name value }
              }
            }
          }
        }`,
        { id: existingProductId },
        "Check existing product",
      );
      if (checkRes.product?.id) {
        remoteProduct = {
          id: checkRes.product.id,
          options: checkRes.product.options || [],
          variants: checkRes.product.variants,
          media: (checkRes.product.media?.nodes || [])
            .map((node) => ({
              id: node.id,
              url: node.preview?.image?.url || "",
            }))
            .filter((item) => item.id && item.url),
        };
      }
    } catch {
      remoteProduct = null;
    }
  }

  let shopifyProductId = remoteProduct?.id ?? null;
  const variantIdMap: Record<string, string> = {};

  const productPayload: Record<string, unknown> = {
    title: input.title,
    descriptionHtml: toShopifyDescriptionHtml(input.description, input.title),
    vendor: "Konika Jewellery",
    productType: "Jewellery",
    status: input.status,
    tags: [input.gender, "jewellery-admin"].filter(Boolean),
  };

  const mediaItems: Array<{
    originalSource: string;
    alt: string;
    mediaContentType: "IMAGE";
  }> = [];

  const productImageUrls = [
    ...(input.imageUrls?.length
      ? input.imageUrls
      : input.imageUrl
        ? [input.imageUrl]
        : []),
  ].filter(Boolean);

  for (const [index, url] of productImageUrls.entries()) {
    if (
      mediaItems.some(
        (m) => normalizeImageUrl(m.originalSource) === normalizeImageUrl(url),
      )
    ) {
      continue;
    }
    mediaItems.push({
      originalSource: url,
      alt: index === 0 ? input.title : `${input.title} ${index + 1}`,
      mediaContentType: "IMAGE",
    });
  }

  for (const variant of shopifyRows) {
    if (!variant.imageUrl) continue;
    if (
      mediaItems.some(
        (m) =>
          normalizeImageUrl(m.originalSource) ===
          normalizeImageUrl(variant.imageUrl!),
      )
    ) {
      continue;
    }
    mediaItems.push({
      originalSource: variant.imageUrl,
      alt: `${input.title} ${variant.color || ""} ${variant.purityLabel || ""}`.trim(),
      mediaContentType: "IMAGE",
    });
  }

  if (shopifyProductId && remoteProduct) {
    // 1. UPDATE EXISTING SHOPIFY PRODUCT
    const updateRes = await gql<{
      productUpdate: {
        product: { id: string } | null;
        userErrors: Array<{ message: string; field?: string[] }>;
      };
    }>(
      graphql,
      `#graphql
      mutation productUpdate($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product { id }
          userErrors { field message }
        }
      }`,
      { product: { id: shopifyProductId, ...productPayload } },
      "Product update",
    );
    assertNoUserErrors(updateRes.productUpdate.userErrors, "Product update");

    // Reconcile media: keep one copy of each desired image, delete duplicates/extras, create missing
    if (mediaItems.length) {
      const desiredKeys = mediaItems.map((item) =>
        normalizeImageUrl(item.originalSource),
      );
      const desiredKeySet = new Set(desiredKeys);
      const keepIds = new Set<string>();
      const matchedDesired = new Set<string>();

      for (const media of remoteProduct.media) {
        const key = normalizeImageUrl(media.url);
        if (desiredKeySet.has(key) && !matchedDesired.has(key)) {
          keepIds.add(media.id);
          matchedDesired.add(key);
        }
      }

      const deleteIds = remoteProduct.media
        .filter((media) => !keepIds.has(media.id))
        .map((media) => media.id);

      if (deleteIds.length) {
        try {
          await gql(
            graphql,
            `#graphql
            mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
              productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
                deletedMediaIds
                mediaUserErrors { field message }
              }
            }`,
            { productId: shopifyProductId, mediaIds: deleteIds },
            "Product media delete",
          );
        } catch (err) {
          console.error("[Shopify Sync] Failed to delete duplicate media:", err);
        }
      }

      const mediaItemsToCreate = mediaItems.filter(
        (item) => !matchedDesired.has(normalizeImageUrl(item.originalSource)),
      );

      if (mediaItemsToCreate.length) {
        try {
          await gql(
            graphql,
            `#graphql
            mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
              productCreateMedia(productId: $productId, media: $media) {
                media { ... on MediaImage { id status } }
                mediaUserErrors { field message }
              }
            }`,
            { productId: shopifyProductId, media: mediaItemsToCreate },
            "Product media",
          );
        } catch (err) {
          console.error("[Shopify Sync] Failed to create media:", err);
        }
      }
    }

    let colorOptionName = "Colour";
    let purityOptionName = "Purity";
    let sizeOptionName = "Size";
    if (productOptions.length) {
      const resolved = await ensureShopifyProductOptions(
        graphql,
        shopifyProductId,
        productOptions.map((option) => ({
          name: option.name,
          values: option.values.map((value) => value.name),
        })),
        remoteProduct.options || [],
      );
      colorOptionName = resolved.colorName;
      purityOptionName = resolved.purityName;
      sizeOptionName = resolved.sizeName;
    }

    const remoteVariants = remoteProduct.variants?.nodes || [];
    const standaloneDefault = isStandaloneDefaultVariant(remoteVariants);

    if (shopifyRows.length === 0) {
      if (remoteVariants.length > 0) {
        try {
          await gql(
            graphql,
            `#graphql
            mutation updateDefaultVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                userErrors { field message }
              }
            }`,
            {
              productId: shopifyProductId,
              variants: [
                {
                  id: remoteVariants[0].id,
                  inventoryItem: { sku: input.sku.slice(0, 100) },
                },
              ],
            },
            "Default variant update",
          );
        } catch {
          // ignore
        }
      }
    } else {
      const matchedRemoteIds = new Set<string>();
      const variantsToUpdate: Array<Record<string, unknown>> = [];
      const variantsToCreate: Array<Record<string, unknown>> = [];

      for (const local of shopifyRows) {
        let matched = remoteVariants.find(
          (rv) =>
            rv.id === local.shopifyVariantId ||
            (local.shopifyVariantId && rv.id.endsWith(local.shopifyVariantId.split("/").pop() || "")),
        );

        if (!matched && productOptions.length > 0) {
          matched = remoteVariants.find((rv) => {
            if (matchedRemoteIds.has(rv.id)) return false;
            const cVal = rv.selectedOptions?.find((o) => optionIsColor(o.name))?.value;
            const pVal = rv.selectedOptions?.find((o) => optionIsPurity(o.name))?.value;
            const sVal = rv.selectedOptions?.find((o) => optionIsSize(o.name))?.value;
            if (sizes.length && sVal !== local.size) return false;
            if (colors.length > 0 && purities.length > 0) {
              return cVal === local.color && pVal === local.purityLabel;
            }
            if (colors.length > 0) return cVal === local.color;
            if (purities.length > 0) return pVal === local.purityLabel;
            return Boolean(sizes.length && sVal === local.size);
          });
        }

        if (
          !matched &&
          standaloneDefault &&
          !matchedRemoteIds.has(remoteVariants[0].id)
        ) {
          matched = remoteVariants[0];
        }

        if (!matched && remoteVariants.length === 1 && shopifyRows.length === 1) {
          matched = remoteVariants[0];
        }

        const optionValues: Array<{ optionName: string; name: string }> = [];
        if (colors.length > 0 && purities.length > 0) {
          optionValues.push({ optionName: colorOptionName, name: local.color });
          optionValues.push({ optionName: purityOptionName, name: local.purityLabel });
        } else if (colors.length > 0) {
          optionValues.push({ optionName: colorOptionName, name: local.color });
        } else if (purities.length > 0) {
          optionValues.push({ optionName: purityOptionName, name: local.purityLabel });
        }
        if (sizes.length && local.size) {
          optionValues.push({ optionName: sizeOptionName, name: local.size });
        }

        const invSku = (local.skuSuffix || input.sku || "").slice(0, 100);

        if (matched) {
          matchedRemoteIds.add(matched.id);
          if (!variantIdMap[local.originId]) variantIdMap[local.originId] = matched.id;
          variantsToUpdate.push({
            id: matched.id,
            price: priceToShopifyString(local.price),
            ...(optionValues.length ? { optionValues } : {}),
            inventoryItem: {
              sku: invSku,
              ...(Number(local.grossWeight) > 0
                ? { measurement: { weight: { unit: "GRAMS", value: Number(local.grossWeight) } } }
                : {}),
            },
            ...(local.imageUrl ? { mediaSrc: [local.imageUrl] } : {}),
          });
        } else {
          variantsToCreate.push({
            price: priceToShopifyString(local.price),
            ...(optionValues.length ? { optionValues } : {}),
            inventoryItem: {
              sku: invSku,
              ...(Number(local.grossWeight) > 0
                ? { measurement: { weight: { unit: "GRAMS", value: Number(local.grossWeight) } } }
                : {}),
            },
            ...(local.imageUrl ? { mediaSrc: [local.imageUrl] } : {}),
          });
        }
      }

      if (variantsToUpdate.length > 0) {
        const updateVarRes = await gql<{
          productVariantsBulkUpdate: {
            productVariants: Array<{ id: string }> | null;
            userErrors: Array<{ message: string; field?: string[] }>;
          };
        }>(
          graphql,
          `#graphql
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants { id }
              userErrors { field message }
            }
          }`,
          { productId: shopifyProductId, variants: variantsToUpdate },
          "Variant update",
        );
        assertNoUserErrors(updateVarRes.productVariantsBulkUpdate.userErrors, "Variant update");
      }

      if (variantsToCreate.length > 0) {
        const createVarRes = await gql<{
          productVariantsBulkCreate: {
            productVariants: Array<{
              id: string;
              selectedOptions: Array<{ name: string; value: string }>;
            }> | null;
            userErrors: Array<{ message: string; field?: string[] }>;
          };
        }>(
          graphql,
          `#graphql
          mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkCreate(productId: $productId, variants: $variants) {
              productVariants {
                id
                selectedOptions { name value }
              }
              userErrors { field message }
            }
          }`,
          { productId: shopifyProductId, variants: variantsToCreate },
          "Variant create",
        );
        assertNoUserErrors(createVarRes.productVariantsBulkCreate.userErrors, "Variant create");

        const newlyCreated = createVarRes.productVariantsBulkCreate.productVariants || [];
        for (const local of shopifyRows) {
          if (!variantIdMap[local.originId]) {
            const found = newlyCreated.find((nc) => {
              const cVal = nc.selectedOptions?.find((o) => optionIsColor(o.name))?.value;
              const pVal = nc.selectedOptions?.find((o) => optionIsPurity(o.name))?.value;
              const sVal = nc.selectedOptions?.find((o) => optionIsSize(o.name))?.value;
              if (sizes.length && sVal !== local.size) return false;
              if (colors.length > 0 && purities.length > 0) {
                return cVal === local.color && pVal === local.purityLabel;
              }
              return true;
            });
            if (found) variantIdMap[local.originId] = found.id;
          }
        }
      }
    }
  } else {
    // 2. CREATE NEW PRODUCT ON SHOPIFY
    const productCreateInput: Record<string, unknown> = {
      ...productPayload,
      ...(productOptions.length ? { productOptions } : {}),
    };

    const createData = await gql<{
      productCreate: {
        product: {
          id: string;
          variants: { nodes: Array<{ id: string }> };
        } | null;
        userErrors: Array<{ message: string; field?: string[] }>;
      };
    }>(
      graphql,
      `#graphql
      mutation productCreate($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            variants(first: 10) { nodes { id } }
          }
          userErrors { field message }
        }
      }`,
      { product: productCreateInput },
      "Product create",
    );

    assertNoUserErrors(createData.productCreate.userErrors, "Product create");
    shopifyProductId = createData.productCreate.product?.id ?? null;
    if (!shopifyProductId) {
      throw new Error("Product create: no product id returned from Shopify");
    }

    if (mediaItems.length) {
      try {
        await gql(
          graphql,
          `#graphql
          mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
            productCreateMedia(productId: $productId, media: $media) {
              media { ... on MediaImage { id status } }
              mediaUserErrors { field message }
            }
          }`,
          { productId: shopifyProductId, media: mediaItems },
          "Product media",
        );
      } catch {
        // best effort
      }
    }

    if (shopifyRows.length === 0) {
      const defaultVariants = createData.productCreate.product?.variants?.nodes || [];
      if (defaultVariants.length > 0) {
        try {
          await gql(
            graphql,
            `#graphql
            mutation updateDefaultVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                userErrors { field message }
              }
            }`,
            {
              productId: shopifyProductId,
              variants: [
                {
                  id: defaultVariants[0].id,
                  inventoryItem: { sku: input.sku.slice(0, 100) },
                },
              ],
            },
            "Default variant update",
          );
        } catch {
          // ignore
        }
      }
    } else if (productOptions.length === 0) {
      const defaultVariants = createData.productCreate.product?.variants?.nodes || [];
      if (defaultVariants.length > 0) {
        const firstVar = shopifyRows[0];
        variantIdMap[firstVar.originId] = defaultVariants[0].id;
        await gql(
          graphql,
          `#graphql
          mutation updateDefaultVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              userErrors { field message }
            }
          }`,
          {
            productId: shopifyProductId,
            variants: [
              {
                id: defaultVariants[0].id,
                price: priceToShopifyString(firstVar.price),
                inventoryItem: {
                  sku: (firstVar.skuSuffix || input.sku).slice(0, 100),
                  ...(Number(firstVar.grossWeight) > 0
                    ? { measurement: { weight: { unit: "GRAMS", value: Number(firstVar.grossWeight) } } }
                    : {}),
                },
                ...(firstVar.imageUrl ? { mediaSrc: [firstVar.imageUrl] } : {}),
              },
            ],
          },
          "Default variant update",
        );
      }
    } else {
      const variantPayload = shopifyRows.map((variant) => {
        const optionValues: Array<{ optionName: string; name: string }> = [];
        if (colors.length > 0 && purities.length > 0) {
          optionValues.push({ optionName: "Colour", name: variant.color });
          optionValues.push({ optionName: "Purity", name: variant.purityLabel });
        } else if (colors.length > 0) {
          optionValues.push({ optionName: "Colour", name: variant.color });
        } else if (purities.length > 0) {
          optionValues.push({ optionName: "Purity", name: variant.purityLabel });
        }
        if (sizes.length && variant.size) {
          optionValues.push({ optionName: "Size", name: variant.size });
        }

        return {
          price: priceToShopifyString(variant.price),
          optionValues,
          inventoryItem: {
            sku: (variant.skuSuffix || input.sku).slice(0, 100),
            ...(Number(variant.grossWeight) > 0
              ? { measurement: { weight: { unit: "GRAMS", value: Number(variant.grossWeight) } } }
              : {}),
          },
          ...(variant.imageUrl ? { mediaSrc: [variant.imageUrl] } : {}),
        };
      });

      const variantsData = await gql<{
        productVariantsBulkCreate: {
          productVariants: Array<{
            id: string;
            selectedOptions: Array<{ name: string; value: string }>;
          }> | null;
          userErrors: Array<{ message: string; field?: string[] }>;
        };
      }>(
        graphql,
        `#graphql
        mutation productVariantsBulkCreate(
          $productId: ID!
          $strategy: ProductVariantsBulkCreateStrategy
          $variants: [ProductVariantsBulkInput!]!
        ) {
          productVariantsBulkCreate(productId: $productId, strategy: $strategy, variants: $variants) {
            productVariants {
              id
              selectedOptions { name value }
            }
            userErrors { field message }
          }
        }`,
        {
          productId: shopifyProductId,
          strategy: "REMOVE_STANDALONE_VARIANT",
          variants: variantPayload,
        },
        "Variant create",
      );

      assertNoUserErrors(variantsData.productVariantsBulkCreate.userErrors, "Variant create");

      const createdVariants = variantsData.productVariantsBulkCreate.productVariants ?? [];
      for (const local of shopifyRows) {
        if (variantIdMap[local.originId]) continue;
        const match = createdVariants.find((remote) => {
          const color = remote.selectedOptions.find((o) => optionIsColor(o.name))?.value;
          const purity = remote.selectedOptions.find((o) => optionIsPurity(o.name))?.value;
          const size = remote.selectedOptions.find((o) => optionIsSize(o.name))?.value;
          if (sizes.length && size !== local.size) return false;
          if (colors.length > 0 && purities.length > 0) {
            return color === local.color && purity === local.purityLabel;
          }
          if (colors.length > 0) return color === local.color;
          if (purities.length > 0) return purity === local.purityLabel;
          return true;
        });
        if (match) variantIdMap[local.originId] = match.id;
      }
    }
  }

  if (input.status === "ACTIVE") {
    await publishProductToOnlineStore(graphql, shopifyProductId);
  }

  return { shopifyProductId, variantIdMap };
}

export async function deleteProductFromShopify(
  graphql: GraphqlClient,
  shopifyProductId: string,
) {
  const data = await gql<{
    productDelete: {
      deletedProductId: string | null;
      userErrors: Array<{ message: string; field?: string[] }>;
    };
  }>(
    graphql,
    `#graphql
    mutation productDelete($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { field message }
      }
    }`,
    { input: { id: shopifyProductId } },
    "Product delete",
  );
  assertNoUserErrors(data.productDelete.userErrors, "Product delete");
}

export async function updateShopifyVariantPrices(
  graphql: GraphqlClient,
  shopifyProductId: string,
  variants: Array<{ shopifyVariantId: string; price: number }>,
) {
  const payload = variants
    .filter((v) => v.shopifyVariantId)
    .map((v) => ({
      id: v.shopifyVariantId,
      price: priceToShopifyString(v.price),
    }));

  if (!payload.length) return;

  const data = await gql<{
    productVariantsBulkUpdate: {
      productVariants: Array<{ id: string }> | null;
      userErrors: Array<{ message: string; field?: string[] }>;
    };
  }>(
    graphql,
    `#graphql
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price }
        userErrors { field message }
      }
    }`,
    {
      productId: shopifyProductId,
      variants: payload,
    },
    "Price update",
  );
  assertNoUserErrors(
    data.productVariantsBulkUpdate.userErrors,
    "Price update",
  );
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toShopifyDescriptionHtml(description: string, fallbackTitle: string) {
  const plain = htmlToPlainText(description) || htmlToPlainText(fallbackTitle) || fallbackTitle;
  return `<p>${escapeHtml(plain)}</p>`;
}

export async function syncAllProductPricesToShopify(graphql: GraphqlClient, goldPricePerGram: number) {
  const products = await prisma.product.findMany({
    include: {
      variants: { include: { purity: true, diamondQuality: true } },
    },
  });

  console.log(`[Shopify Price Sync] Syncing prices for ${products.length} products using gold rate ${goldPricePerGram}...`);

  for (const product of products) {
    if (!product.shopifyProductId) continue;

    const variantsPayload = product.variants
      .filter((v) => v.shopifyVariantId)
      .map((variant) => ({
        shopifyVariantId: variant.shopifyVariantId!,
        price: calculateProductPrice({
          grossWeight: variant.grossWeight,
          netGoldWeight: variant.netGoldWeight,
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
          stones: parseStonesJson(variant.stonesJson, variant),
          otherCharges: variant.otherCharges,
          gstPercent: variant.gstPercent,
          pricingMode: product.pricingMode,
          manualPrice: variant.manualPrice,
          wastageType: variant.wastageType,
        }).total,
      }));

    if (variantsPayload.length > 0) {
      try {
        await updateShopifyVariantPrices(graphql, product.shopifyProductId, variantsPayload);
        await syncProductJewelleryMetafields(
          graphql,
          product.shopifyProductId,
          product.variants,
          goldPricePerGram,
          undefined,
          {
            width: product.dimensionWidth,
            height: product.dimensionHeight,
            sizes: (() => {
              try {
                const parsed = JSON.parse(product.availableSizes || "[]");
                return Array.isArray(parsed) ? parsed.map(String) : [];
              } catch {
                return [];
              }
            })(),
            pricingMode: product.pricingMode,
          },
        );
      } catch (error: any) {
        console.error(`[Shopify Price Sync] Failed to update prices for product ${product.sku}: ${error.message}`);
      }
    }
  }
}

export async function fetchCollectionsFromShopify(graphql: GraphqlClient) {
  let hasNextPage = true;
  let after: string | null = null;
  const allCollections: Array<{ id: string; title: string; description: string; imageUrl: string }> = [];

  while (hasNextPage) {
    const res: any = await gql<any>(
      graphql,
      `#graphql
      query getCollections($first: Int!, $after: String) {
        collections(first: $first, after: $after) {
          nodes {
            id
            title
            descriptionHtml
            image {
              url
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { first: 250, after },
      "Fetch collections"
    );

    const nodes = res?.collections?.nodes;
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (node && typeof node.id === "string" && typeof node.title === "string") {
          allCollections.push({
            id: node.id,
            title: node.title,
            description: node.descriptionHtml || "",
            imageUrl: node.image?.url || "",
          });
        }
      }
    }

    hasNextPage = res?.collections?.pageInfo?.hasNextPage ?? false;
    after = res?.collections?.pageInfo?.endCursor ?? null;
  }

  return allCollections;
}

export async function syncSingleProductToShopify(
  productId: string,
  graphql: GraphqlClient,
) {
  const settings = await prisma.appSetting.findUnique({ where: { id: "default" } });
  const goldPricePerGram = settings?.goldPricePerGram ?? 6500;
  const rules = await catalogDiscountRules();

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      variants: { include: { purity: true, diamondQuality: true } },
      collections: true,
    },
  });

  if (!product) {
    throw new Error("Product not found");
  }

  if (!product.variants.length) {
    const defaultMetal = await prisma.metalType.findFirst({ where: { status: "Active" } });
    const defaultPurity = defaultMetal
      ? await prisma.purityLevel.findFirst({ where: { metalId: defaultMetal.id } })
      : await prisma.purityLevel.findFirst();
    if (defaultMetal && defaultPurity) {
      const createdVariant = await prisma.productVariant.create({
        data: {
          productId: product.id,
          metalId: defaultMetal.id,
          purityId: defaultPurity.id,
          metalColor: defaultMetal.color,
          grossWeight: 0,
          stoneIncluded: false,
          stoneType: "None",
          stoneWeight: 0,
          wastagePercent: 5,
          makingChargeType: "percent",
          makingChargeValue: 10,
          stoneRate: 0,
          status: "Active",
        },
        include: { purity: true, diamondQuality: true },
      });
      product.variants = [createdVariant];
    }
  }

  const { shopifyProductId, variantIdMap } = await syncProductToShopify(
    graphql,
    {
      title: product.name,
      description: product.description,
      sku: product.sku,
      gender: product.gender,
      status: product.status === "Active" ? "ACTIVE" : "DRAFT",
      imageUrl: product.imageUrl || undefined,
      imageUrls: (() => {
        try {
          const parsed = JSON.parse(product.imagesJson || "[]") as Array<{
            url?: string;
          }>;
          const urls = Array.isArray(parsed)
            ? parsed.map((item) => item?.url).filter((url): url is string => Boolean(url))
            : [];
          const seen = new Set<string>();
          const unique = urls.filter((url) => {
            const key = normalizeImageUrl(url);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          if (unique.length) return unique;
        } catch {
          // ignore
        }
        return product.imageUrl ? [product.imageUrl] : [];
      })(),
      variants: product.variants.map((variant) => {
        const sizeWeights = product.isRing
          ? parseSizeWeights(variant.sizeWeightsJson).map((row) => ({
              size: row.size,
              netGoldWeight: row.netGoldWeight,
              grossWeight: row.grossWeight,
              price: priceForMetal({
                variant,
                product,
                goldPricePerGram,
                rules,
                netGoldWeight: row.netGoldWeight,
                grossWeight: row.grossWeight,
              }),
            }))
          : [];
        return {
          id: variant.id,
          shopifyVariantId: variant.shopifyVariantId,
          sku: variant.sku || product.sku,
          skuSuffix: variant.sku || product.sku,
          color: variant.metalColor,
          purityLabel: variant.purity?.label || "22K",
          imageUrl: variant.imageUrl || undefined,
          grossWeight: variant.grossWeight,
          netGoldWeight: variant.netGoldWeight ?? undefined,
          sizeWeights,
          price: priceForMetal({
            variant,
            product,
            goldPricePerGram,
            rules,
            netGoldWeight: variant.netGoldWeight ?? 0,
            grossWeight: variant.grossWeight,
          }),
          status: variant.status,
        };
      }),
      sizes: product.isRing
        ? unionSizes(
            product.variants.map((variant) => ({
              sizeWeights: parseSizeWeights(variant.sizeWeightsJson),
            })),
          )
        : [],
    },
    product.shopifyProductId,
  );

  await prisma.product.update({
    where: { id: product.id },
    data: { shopifyProductId },
  });

  await Promise.all(
    Object.entries(variantIdMap).map(([localId, shopifyVariantId]) =>
      prisma.productVariant.update({
        where: { id: localId },
        data: { shopifyVariantId },
      }),
    ),
  );

  // Refresh local variant Shopify IDs for metafield owners
  const variantsForMeta = product.variants.map((variant) => ({
    ...variant,
    shopifyVariantId: variantIdMap[variant.id] || variant.shopifyVariantId,
  }));

  try {
    await syncProductJewelleryMetafields(
      graphql,
      shopifyProductId,
      variantsForMeta,
      goldPricePerGram,
      variantIdMap,
      {
        width: product.dimensionWidth,
        height: product.dimensionHeight,
        sizes: (() => {
          try {
            const parsed = JSON.parse(product.availableSizes || "[]");
            return Array.isArray(parsed) ? parsed.map(String) : [];
          } catch {
            return [];
          }
        })(),
        pricingMode: product.pricingMode,
      },
    );
  } catch (err) {
    console.error("[Shopify Sync] Metafield sync failed:", err);
  }

  if (product.collections.length > 0) {
    for (const coll of product.collections) {
      if (coll.shopifyCollectionId) {
        await addProductToShopifyCollection(
          graphql,
          coll.shopifyCollectionId,
          shopifyProductId,
        );
      }
    }
  }

  return { shopifyProductId, variantIdMap };
}


