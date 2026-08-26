import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Resetting Shopify IDs in local database...");

  const collections = await prisma.collection.updateMany({
    data: { shopifyCollectionId: null }
  });
  console.log(`Reset ${collections.count} collections.`);

  const products = await prisma.product.updateMany({
    data: { shopifyProductId: null }
  });
  console.log(`Reset ${products.count} products.`);

  const variants = await prisma.productVariant.updateMany({
    data: { shopifyVariantId: null }
  });
  console.log(`Reset ${variants.count} variants.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
