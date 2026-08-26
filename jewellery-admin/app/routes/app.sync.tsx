import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  calculateProductPrice,
  type MakingChargeType,
} from "../lib/pricing";
import {
  addProductToShopifyCollection,
  syncCollectionToShopify,
  syncProductToShopify,
} from "../lib/shopify-catalog.server";

/**
 * Global sync: push every collection + product from this dashboard to Shopify.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, message: "Method not allowed." }, { status: 405 });
  }

  const { admin } = await authenticate.admin(request);

  try {
    const settings = await prisma.appSetting.findUnique({ where: { id: "default" } });
    const goldPricePerGram = settings?.goldPricePerGram ?? 6500;

    const collections = await prisma.collection.findMany({ orderBy: { name: "asc" } });
    let collectionsSynced = 0;
    for (const collection of collections) {
      const shopifyCollectionId = await syncCollectionToShopify(
        admin.graphql,
        collection.name,
        collection.shopifyCollectionId,
      );
      await prisma.collection.update({
        where: { id: collection.id },
        data: { shopifyCollectionId },
      });
      collectionsSynced += 1;
    }

    const products = await prisma.product.findMany({
      include: {
        variants: { include: { purity: true } },
        collection: true,
      },
      orderBy: { updatedAt: "asc" },
    });

    let productsSynced = 0;
    const errors: string[] = [];

    for (const product of products) {
      if (!product.variants.length) {
        errors.push(`${product.sku}: no variants`);
        continue;
      }

      try {
        const { shopifyProductId, variantIdMap } = await syncProductToShopify(
          admin.graphql,
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

        const shopifyCollectionId =
          product.collection?.shopifyCollectionId ??
          (product.collectionId
            ? (
                await prisma.collection.findUnique({
                  where: { id: product.collectionId },
                })
              )?.shopifyCollectionId
            : null) ??
          null;

        if (shopifyCollectionId) {
          await addProductToShopifyCollection(
            admin.graphql,
            shopifyCollectionId,
            shopifyProductId,
          );
        }

        productsSynced += 1;
      } catch (error) {
        errors.push(
          `${product.sku}: ${error instanceof Error ? error.message : "failed"}`,
        );
      }
    }

    const message = [
      `Synced ${collectionsSynced} collection(s) and ${productsSynced} product(s) to Shopify.`,
      errors.length ? `Issues: ${errors.slice(0, 3).join(" · ")}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    return Response.json({
      ok: errors.length === 0,
      message,
      collectionsSynced,
      productsSynced,
      errors,
    });
  } catch (error) {
    return Response.json({
      ok: false,
      message: error instanceof Error ? error.message : "Global sync failed.",
    });
  }
};
