import { priceToShopifyString, calculateProductPrice, type MakingChargeType } from "./pricing";
import prisma from "../db.server";


type GraphqlClient = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

type SyncVariantInput = {
  id: string;
  skuSuffix: string;
  color: string;
  purityLabel: string;
  price: number;
  status: string;
  imageUrl?: string;
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
};

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
    collectionInput.descriptionHtml = description ? `<p>${escapeHtml(description)}</p>` : "";
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
  const colors = [...new Set(input.variants.map((v) => v.color))];
  const purities = [...new Set(input.variants.map((v) => v.purityLabel))];

  if (!colors.length || !purities.length) {
    throw new Error("Product needs at least one colour and purity variant");
  }

  let shopifyProductId = existingProductId ?? null;

  if (shopifyProductId) {
    await deleteProductFromShopify(graphql, shopifyProductId);
    shopifyProductId = null;
  }

  const product: Record<string, unknown> = {
    title: input.title,
    descriptionHtml: input.description
      ? `<p>${escapeHtml(input.description)}</p>`
      : `<p>${escapeHtml(input.title)}</p>`,
    vendor: "Konika Jewellery",
    productType: "Jewellery",
    status: input.status,
    tags: [input.gender, "jewellery-admin"].filter(Boolean),
    productOptions: [
      { name: "Colour", values: colors.map((name) => ({ name })) },
      { name: "Purity", values: purities.map((name) => ({ name })) },
    ],
  };

  const variables: Record<string, unknown> = { product };
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
    if (mediaItems.some((m) => m.originalSource === url)) continue;
    mediaItems.push({
      originalSource: url,
      alt: index === 0 ? input.title : `${input.title} ${index + 1}`,
      mediaContentType: "IMAGE",
    });
  }

  for (const variant of input.variants) {
    if (!variant.imageUrl) continue;
    if (mediaItems.some((m) => m.originalSource === variant.imageUrl)) continue;
    mediaItems.push({
      originalSource: variant.imageUrl,
      alt: `${input.title} ${variant.color} ${variant.purityLabel}`,
      mediaContentType: "IMAGE",
    });
  }

  const createData = await gql<{
    productCreate: {
      product: { id: string } | null;
      userErrors: Array<{ message: string; field?: string[] }>;
    };
  }>(
    graphql,
    `#graphql
    mutation productCreate($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product { id }
        userErrors { field message }
      }
    }`,
    variables,
    "Product create",
  );

  assertNoUserErrors(createData.productCreate.userErrors, "Product create");
  shopifyProductId = createData.productCreate.product?.id ?? null;
  if (!shopifyProductId) {
    throw new Error("Product create: no product id returned from Shopify");
  }

  if (mediaItems.length) {
    const mediaData = await gql<{
      productCreateMedia: {
        media: Array<{ id?: string; status?: string }> | null;
        mediaUserErrors: Array<{ message: string }>;
      };
    }>(
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
    assertNoUserErrors(mediaData.productCreateMedia.mediaUserErrors, "Product media");
  }

  const variantPayload = input.variants.map((variant) => ({
    price: priceToShopifyString(variant.price),
    optionValues: [
      { optionName: "Colour", name: variant.color },
      { optionName: "Purity", name: variant.purityLabel },
    ],
    inventoryItem: {
      sku: `${input.sku}-${variant.skuSuffix}`.slice(0, 100),
    },
    ...(variant.imageUrl ? { mediaSrc: [variant.imageUrl] } : {}),
  }));

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

  assertNoUserErrors(
    variantsData.productVariantsBulkCreate.userErrors,
    "Variant create",
  );

  const createdVariants =
    variantsData.productVariantsBulkCreate.productVariants ?? [];

  const variantIdMap: Record<string, string> = {};
  for (const local of input.variants) {
    const match = createdVariants.find((remote) => {
      const color = remote.selectedOptions.find((o) => o.name === "Colour")?.value;
      const purity = remote.selectedOptions.find((o) => o.name === "Purity")?.value;
      return color === local.color && purity === local.purityLabel;
    });
    if (match) variantIdMap[local.id] = match.id;
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

export async function syncAllProductPricesToShopify(graphql: GraphqlClient, goldPricePerGram: number) {
  const products = await prisma.product.findMany({
    include: {
      variants: { include: { purity: true } },
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
      }));

    if (variantsPayload.length > 0) {
      try {
        await updateShopifyVariantPrices(graphql, product.shopifyProductId, variantsPayload);
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

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      variants: { include: { purity: true } },
      collections: true,
    },
  });

  if (!product) {
    throw new Error("Product not found");
  }

  if (!product.variants.length) {
    throw new Error("Product has no variants");
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
          if (urls.length) return urls;
        } catch {
          // ignore
        }
        return product.imageUrl ? [product.imageUrl] : [];
      })(),
      variants: product.variants.map((variant) => ({
        id: variant.id,
        skuSuffix: `${variant.metalColor.replace(/\s+/g, "")}-${variant.purity.label}`,
        color: variant.metalColor,
        purityLabel: variant.purity.label,
        imageUrl: variant.imageUrl || undefined,
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
        status: variant.status,
      })),
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


