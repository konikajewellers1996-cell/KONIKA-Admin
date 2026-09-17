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
        collection.description,
        collection.imageUrl,
      );
      await prisma.collection.update({
        where: { id: collection.id },
        data: { shopifyCollectionId },
      });
      collectionsSynced += 1;
    }

    const rawProducts = await prisma.product.findMany({
      include: {
        variants: { include: { purity: true } },
        collections: true,
      },
      orderBy: { updatedAt: "asc" },
    });

    // De-duplicate products by SKU
    const seenSkus = new Map<string, (typeof rawProducts)[0]>();
    for (const p of rawProducts) {
      const key = p.sku.trim().toUpperCase();
      if (!seenSkus.has(key)) {
        seenSkus.set(key, p);
      } else {
        const existing = seenSkus.get(key)!;
        const curWeight = p.variants.reduce((sum, v) => sum + v.grossWeight, 0);
        const existingWeight = existing.variants.reduce((sum, v) => sum + v.grossWeight, 0);
        if (
          curWeight > existingWeight ||
          (curWeight === existingWeight && p.variants.length > existing.variants.length) ||
          (!existing.shopifyProductId && p.shopifyProductId)
        ) {
          seenSkus.set(key, p);
        }
      }
    }
    const products = Array.from(seenSkus.values());

    let productsSynced = 0;
    const errors: string[] = [];

    const defaultMetal =
      (await prisma.metalType.findFirst({ where: { status: "Active" } })) ||
      (await prisma.metalType.findFirst());
    const defaultPurity = defaultMetal
      ? await prisma.purityLevel.findFirst({ where: { metalId: defaultMetal.id } })
      : await prisma.purityLevel.findFirst();

    for (const product of products) {
      // If product has no variants, auto-create a default variant
      if (!product.variants.length && defaultMetal && defaultPurity) {
        try {
          const createdV = await prisma.productVariant.create({
            data: {
              productId: product.id,
              metalId: defaultMetal.id,
              purityId: defaultPurity.id,
              metalColor: defaultMetal.color || defaultMetal.name,
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
            include: { purity: true },
          });
          product.variants = [createdV];
        } catch {
          // ignore
        }
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
              shopifyVariantId: variant.shopifyVariantId,
              skuSuffix: `${variant.metalColor.replace(/\s+/g, "")}-${variant.purity?.label || "22K"}`,
              color: variant.metalColor,
              purityLabel: variant.purity?.label || "22K",
              imageUrl: variant.imageUrl || undefined,
              grossWeight: variant.grossWeight,
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
                admin.graphql,
                coll.shopifyCollectionId,
                shopifyProductId,
              );
            }
          }
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
