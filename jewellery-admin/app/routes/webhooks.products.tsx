import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { htmlToPlainText, normalizeImageUrl } from "../lib/text";

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

    // 3. Get images details (dedupe identical CDN variants)
    const firstImage = payload.images?.[0];
    const imageUrl = firstImage?.src || "";
    const shopifyFileId = firstImage?.admin_graphql_api_id || null;

    const imagesList: Array<{ url: string; shopifyFileId: string | null }> = [];
    const seenImageUrls = new Set<string>();
    for (const img of payload.images || []) {
      const url = String(img?.src || "").trim();
      if (!url) continue;
      const key = normalizeImageUrl(url);
      if (seenImageUrls.has(key)) continue;
      seenImageUrls.add(key);
      imagesList.push({
        url,
        shopifyFileId: img.admin_graphql_api_id || null,
      });
    }
    const imagesJson = JSON.stringify(imagesList);

    // 4. Extract candidate SKUs
    const payloadVariants = payload.variants || [];
    const variantSkus = payloadVariants
      .map((v: any) => (typeof v.sku === "string" ? v.sku.trim() : ""))
      .filter(Boolean);
    const candidateSkus: string[] = Array.from(
      new Set<string>(
        variantSkus
          .map((s: string) => s.split("-")[0].trim())
          .filter((s: string): s is string => Boolean(s)),
      ),
    );
    if (!candidateSkus.length && payload.handle) {
      candidateSkus.push(String(payload.handle));
    }
    const sku = candidateSkus[0] || payload.handle || "JW-TEMP";

    // 5. De-duplicate & locate existing product
    const matchingProducts = await prisma.product.findMany({
      where: {
        OR: [
          { shopifyProductId },
          ...(candidateSkus.length ? [{ sku: { in: candidateSkus } }] : []),
        ],
      },
      include: { variants: true },
    });

    let product: any = null;
    if (matchingProducts.length > 1) {
      // Sort by variants with positive grossWeight first, then variant count
      matchingProducts.sort((a: any, b: any) => {
        const aWeight = (a.variants || []).reduce((sum: number, v: any) => sum + (v.grossWeight || 0), 0);
        const bWeight = (b.variants || []).reduce((sum: number, v: any) => sum + (v.grossWeight || 0), 0);
        if (bWeight !== aWeight) return bWeight - aWeight;
        return (b.variants?.length || 0) - (a.variants?.length || 0);
      });
      product = matchingProducts[0];
      const duplicateIds = matchingProducts.slice(1).map((p) => p.id);
      await prisma.product.deleteMany({
        where: { id: { in: duplicateIds } },
      });
      console.log(`[Product Webhook] Deduplicated and removed ${duplicateIds.length} duplicate products:`, duplicateIds);
    } else if (matchingProducts.length === 1) {
      product = matchingProducts[0];
    } else if (payload.title) {
      // Fallback search by title
      product = await prisma.product.findFirst({
        where: { name: { equals: payload.title, mode: "insensitive" } },
      });
    }

    const productData = {
      sku: product?.sku || sku,
      name: payload.title || "Unnamed Product",
      description: htmlToPlainText(payload.body_html || product?.description || ""),
      imageUrl: imageUrl || product?.imageUrl || "",
      shopifyFileId: shopifyFileId || product?.shopifyFileId || null,
      imagesJson: imagesList.length ? imagesJson : (product?.imagesJson || "[]"),
      gender,
      status: payload.status === "active" ? "Active" : "Draft",
    };

    if (product) {
      product = await prisma.product.update({
        where: { id: product.id },
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

    // 6. Sync variants preserving local jewellery calculations
    const syncedVariantIds: string[] = [];

    for (const v of payloadVariants) {
      const shopifyVariantId = `gid://shopify/ProductVariant/${v.id}`;
      const grossWeight = typeof v.grams === "number" ? v.grams : (parseFloat(v.weight) || 0);

      // Find metal by matching color (option1)
      const colorVal = v.option1 && v.option1 !== "Default Title" ? v.option1 : "";
      let metal = null;
      if (colorVal) {
        metal = await prisma.metalType.findFirst({
          where: { color: { equals: colorVal, mode: "insensitive" } },
        });
        if (!metal) {
          metal = await prisma.metalType.findFirst({
            where: { name: { equals: colorVal, mode: "insensitive" } },
          });
        }
      }
      if (!metal) {
        metal = await prisma.metalType.findFirst({ where: { status: "Active" } }) || await prisma.metalType.findFirst();
      }

      // Find purity by label (option2 or option1)
      const purityLabel = v.option2 && v.option2 !== "Default Title" ? v.option2 : (colorVal ? "" : (v.option1 !== "Default Title" ? v.option1 : ""));
      let purity = null;
      if (metal && purityLabel) {
        purity = await prisma.purityLevel.findFirst({
          where: {
            metalId: metal.id,
            label: { equals: purityLabel, mode: "insensitive" },
          },
        });
      }
      if (!purity && purityLabel) {
        purity = await prisma.purityLevel.findFirst({
          where: { label: { equals: purityLabel, mode: "insensitive" } },
        });
      }
      if (!purity && metal) {
        purity = await prisma.purityLevel.findFirst({
          where: { metalId: metal.id },
        });
      }
      if (!purity) {
        purity = await prisma.purityLevel.findFirst();
      }

      if (!metal || !purity) {
        console.warn(`[Product Webhook] Skip variant ${shopifyVariantId} because metal or purity could not be resolved.`);
        continue;
      }

      // Check if variant already exists
      let existingVariant = await prisma.productVariant.findFirst({
        where: { shopifyVariantId },
      });

      if (!existingVariant && product) {
        existingVariant = await prisma.productVariant.findFirst({
          where: {
            productId: product.id,
            metalId: metal.id,
            purityId: purity.id,
          },
        });
      }

      if (!existingVariant && product && payloadVariants.length === 1) {
        existingVariant = await prisma.productVariant.findFirst({
          where: { productId: product.id },
        });
      }

      if (existingVariant) {
        // IMPORTANT: Never overwrite positive grossWeight with 0 from webhook!
        const updatedWeight = grossWeight > 0 ? grossWeight : existingVariant.grossWeight;
        const updated = await prisma.productVariant.update({
          where: { id: existingVariant.id },
          data: {
            shopifyVariantId,
            metalId: metal.id,
            purityId: purity.id,
            metalColor: metal.color || metal.name,
            grossWeight: updatedWeight,
          },
        });
        syncedVariantIds.push(updated.id);
      } else {
        const created = await prisma.productVariant.create({
          data: {
            productId: product.id,
            metalId: metal.id,
            purityId: purity.id,
            metalColor: metal.color || metal.name,
            grossWeight: grossWeight > 0 ? grossWeight : 0,
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

    // Delete variants that are no longer present on Shopify only if at least one variant was successfully synced
    if (syncedVariantIds.length > 0) {
      await prisma.productVariant.deleteMany({
        where: {
          productId: product.id,
          id: { notIn: syncedVariantIds },
        },
      });
    }

    console.log(`[Product Webhook] Synced product "${product.name}" (ID: ${product.id}) with ${syncedVariantIds.length} variants.`);
  }

  return new Response();
};

