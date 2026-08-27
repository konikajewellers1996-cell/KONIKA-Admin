import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`[Collection Webhook] Received ${topic} webhook for ${shop}`);

  const normalizedTopic = topic.toUpperCase().replace(/\//g, "_");
  const shopifyCollectionId = `gid://shopify/Collection/${payload.id}`;

  if (normalizedTopic === "COLLECTIONS_CREATE" || normalizedTopic === "COLLECTIONS_UPDATE") {
    const title = String(payload.title || "").trim();
    if (!title) return new Response();

    // Check if it exists by shopifyCollectionId
    const existingById = await prisma.collection.findFirst({
      where: { shopifyCollectionId },
    });

    if (existingById) {
      if (existingById.name !== title) {
        await prisma.collection.update({
          where: { id: existingById.id },
          data: { name: title },
        });
        console.log(`[Collection Webhook] Updated local collection name to "${title}" for ID ${existingById.id}`);
      }
    } else {
      // Check if it exists by name
      const existingByName = await prisma.collection.findFirst({
        where: { name: title },
      });

      if (existingByName) {
        await prisma.collection.update({
          where: { id: existingByName.id },
          data: { shopifyCollectionId },
        });
        console.log(`[Collection Webhook] Linked existing local collection "${title}" to Shopify ID ${shopifyCollectionId}`);
      } else {
        // Create new collection
        const newCol = await prisma.collection.create({
          data: {
            name: title,
            shopifyCollectionId,
          },
        });
        console.log(`[Collection Webhook] Created new local collection "${title}" (ID: ${newCol.id})`);
      }
    }
  } else if (normalizedTopic === "COLLECTIONS_DELETE") {
    // Delete the local collection
    await prisma.collection.deleteMany({
      where: { shopifyCollectionId },
    });
    console.log(`[Collection Webhook] Deleted local collection(s) with Shopify ID ${shopifyCollectionId}`);
  }

  return new Response();
};
