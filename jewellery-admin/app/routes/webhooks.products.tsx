import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`[Product Webhook] Received ${topic} webhook for ${shop}`);

  const normalizedTopic = topic.toUpperCase().replace(/\//g, "_");
  const shopifyProductId = `gid://shopify/Product/${payload.id}`;

  if (normalizedTopic === "PRODUCTS_DELETE") {
    await prisma.product.deleteMany({
      where: { shopifyProductId },
    });
    console.log(`[Product Webhook] Deleted local product and variants for Shopify ID ${shopifyProductId}`);
    return new Response();
  }

  if (normalizedTopic === "PRODUCTS_CREATE" || normalizedTopic === "PRODUCTS_UPDATE") {
    // 1. Determine local collectionIds by querying Shopify GraphQL if admin client is available
    let collectionIds: string[] = [];
    if (admin) {
      try {
        const query = `#graphql
          query getProductCollections($id: ID!) {
            product(id: $id) {
              collections(first: 50) {
                nodes {
                  id
                  title
                }
              }
            }
          }
        `;
        const response = await admin.graphql(query, { variables: { id: shopifyProductId } });
        const responseJson: any = await response.json();
        const collections = responseJson.data?.product?.collections?.nodes || [];
        for (const coll of collections) {
          const localColl = await prisma.collection.findFirst({
            where: { shopifyCollectionId: coll.id },
          });
          if (localColl) {
            collectionIds.push(localColl.id);
          }
        }
      } catch (err) {
        console.error("[Product Webhook] Failed to fetch product collections:", err);
      }
    }

    // 2. Parse tags for gender
    let gender = "Unisex";
    const tagsStr = typeof payload.tags === "string" ? payload.tags : "";
    const tags = tagsStr.split(",").map((t: string) => t.trim().toLowerCase());
    if (tags.includes("women")) {
      gender = "Women";
    } else if (tags.includes("men")) {
      gender = "Men";
    } else if (tags.includes("unisex")) {
      gender = "Unisex";
    }

    // 3. Get images details
    const firstImage = payload.images?.[0];
    const imageUrl = firstImage?.src || "";
    const shopifyFileId = firstImage?.admin_graphql_api_id || null;

    const imagesList = (payload.images || []).map((img: any) => ({
      url: img.src,
      shopifyFileId: img.admin_graphql_api_id || null,
    }));
    const imagesJson = JSON.stringify(imagesList);

    // 4. Extract master SKU
    const firstVariantSku = payload.variants?.[0]?.sku || "";
    const sku = firstVariantSku.split("-")[0] || payload.handle || "JW-TEMP";

    // 5. Create or update product
    let product = await prisma.product.findFirst({
      where: { shopifyProductId },
    });

    const productData = {
      sku,
      name: payload.title || "Unnamed Product",
      description: payload.body_html || "",
      imageUrl,
      shopifyFileId,
      imagesJson,
      gender,
      status: payload.status === "active" ? "Active" : "Draft",
    };

    if (product) {
      product = await prisma.product.update({
        where: { id: product.id },
        data: {
          ...productData,
          collections: {
            set: collectionIds.map((id) => ({ id })),
          },
        },
      });
    } else {
      // Check if matches existing by SKU
      const existingBySku = await prisma.product.findFirst({
        where: { sku },
      });

      if (existingBySku) {
        product = await prisma.product.update({
          where: { id: existingBySku.id },
          data: {
            shopifyProductId,
            ...productData,
            collections: {
              set: collectionIds.map((id) => ({ id })),
            },
          },
        });
      } else {
        product = await prisma.product.create({
          data: {
            shopifyProductId,
            ...productData,
            collections: {
              connect: collectionIds.map((id) => ({ id })),
            },
          },
        });
      }
    }

    // 6. Sync variants
    const payloadVariants = payload.variants || [];
    const syncedVariantIds: string[] = [];

    for (const v of payloadVariants) {
      const shopifyVariantId = `gid://shopify/ProductVariant/${v.id}`;
      const grossWeight = typeof v.grams === "number" ? v.grams : (parseFloat(v.weight) || 0);

      // Find metal by matching color (option1)
      const colorVal = v.option1 || "";
      let metal = await prisma.metalType.findFirst({
        where: { color: { equals: colorVal, mode: "insensitive" } },
      });
      if (!metal) {
        metal = await prisma.metalType.findFirst({
          where: { name: { equals: colorVal, mode: "insensitive" } },
        });
      }
      if (!metal) {
        metal = await prisma.metalType.findFirst();
      }

      // Find purity by label (option2)
      const purityLabel = v.option2 || "";
      let purity = null;
      if (metal) {
        purity = await prisma.purityLevel.findFirst({
          where: {
            metalId: metal.id,
            label: { equals: purityLabel, mode: "insensitive" },
          },
        });
      }
      if (!purity) {
        purity = await prisma.purityLevel.findFirst({
          where: { label: { equals: purityLabel, mode: "insensitive" } },
        });
      }
      if (!purity) {
        purity = await prisma.purityLevel.findFirst();
      }

      if (!metal || !purity) {
        console.warn(`[Product Webhook] Skip variant ${shopifyVariantId} because metal or purity could not be resolved.`);
        continue;
      }

      const existingVariant = await prisma.productVariant.findFirst({
        where: { shopifyVariantId },
      });

      if (existingVariant) {
        const updated = await prisma.productVariant.update({
          where: { id: existingVariant.id },
          data: {
            metalId: metal.id,
            purityId: purity.id,
            metalColor: metal.color,
            grossWeight,
          },
        });
        syncedVariantIds.push(updated.id);
      } else {
        const created = await prisma.productVariant.create({
          data: {
            productId: product.id,
            metalId: metal.id,
            purityId: purity.id,
            metalColor: metal.color,
            grossWeight,
            stoneIncluded: false,
            stoneType: "None",
            stoneWeight: 0,
            wastagePercent: 5,
            makingChargeType: "percent",
            makingChargeValue: 10,
            stoneRate: 0,
            shopifyVariantId,
            status: "Active",
          },
        });
        syncedVariantIds.push(created.id);
      }
    }

    // Delete variants that are no longer present on Shopify
    await prisma.productVariant.deleteMany({
      where: {
        productId: product.id,
        id: { notIn: syncedVariantIds },
      },
    });

    console.log(`[Product Webhook] Synced product "${product.name}" (ID: ${product.id}) with ${syncedVariantIds.length} variants.`);
  }

  return new Response();
};
