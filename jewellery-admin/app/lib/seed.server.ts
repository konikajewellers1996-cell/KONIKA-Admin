import prisma from "../db.server";
import { ALL_COLLECTIONS_NAME } from "./collections";

export { ALL_COLLECTIONS_NAME };

export async function ensureAllCollectionsCollection() {
  const existing = await prisma.collection.findFirst({
    where: {
      OR: [
        { name: ALL_COLLECTIONS_NAME },
        { name: "ALL Collection" },
        { name: "All Products" },
        { name: "All Product" },
      ],
    },
  });

  const allCollection = existing
    ? existing.name !== ALL_COLLECTIONS_NAME
      ? await prisma.collection.update({
          where: { id: existing.id },
          data: { name: ALL_COLLECTIONS_NAME },
        })
      : existing
    : await prisma.collection.create({
        data: {
          name: ALL_COLLECTIONS_NAME,
          description: "Every product is automatically added to this collection.",
        },
      });

  // Keep every product linked to ALL Collections
  const missing = await prisma.product.findMany({
    where: {
      collections: { none: { id: allCollection.id } },
    },
    select: { id: true },
  });
  if (missing.length) {
    await prisma.collection.update({
      where: { id: allCollection.id },
      data: {
        products: {
          connect: missing.map((p) => ({ id: p.id })),
        },
      },
    });
  }

  return allCollection;
}

export async function ensureAppSeed() {
  await prisma.appSetting.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default", goldPricePerGram: 6500 },
  });

  await ensureAllCollectionsCollection();

  const defaultGemstones = [
    { name: "Ruby", color: "Red", defaultRate: 0 },
    { name: "Emerald", color: "Green", defaultRate: 0 },
    { name: "Sapphire", color: "Blue", defaultRate: 0 },
    { name: "Pearl", color: "White", defaultRate: 0 },
  ];
  for (const gem of defaultGemstones) {
    await prisma.gemstoneType.upsert({
      where: { name: gem.name },
      update: {},
      create: { ...gem, status: "Active" },
    });
  }

  const metalCount = await prisma.metalType.count();
  if (metalCount > 0) return;

  const yellow = await prisma.metalType.create({
    data: { name: "Gold", color: "Yellow Gold", status: "Active" },
  });
  const rose = await prisma.metalType.create({
    data: { name: "Gold", color: "Rose Gold", status: "Active" },
  });
  const white = await prisma.metalType.create({
    data: { name: "Gold", color: "White Gold", status: "Active" },
  });

  const purityRows = [
    { metalId: yellow.id, label: "14K", karat: 14, purityValue: 0.585 },
    { metalId: yellow.id, label: "18K", karat: 18, purityValue: 0.75 },
    { metalId: yellow.id, label: "22K", karat: 22, purityValue: 0.916 },
    { metalId: rose.id, label: "14K", karat: 14, purityValue: 0.585 },
    { metalId: rose.id, label: "18K", karat: 18, purityValue: 0.75 },
    { metalId: rose.id, label: "22K", karat: 22, purityValue: 0.916 },
    { metalId: white.id, label: "14K", karat: 14, purityValue: 0.585 },
    { metalId: white.id, label: "18K", karat: 18, purityValue: 0.75 },
    { metalId: white.id, label: "22K", karat: 22, purityValue: 0.916 },
  ];

  await prisma.purityLevel.createMany({ data: purityRows });

  const existingCollections = await prisma.collection.count({
    where: { name: { not: ALL_COLLECTIONS_NAME } },
  });
  if (existingCollections === 0) {
    await prisma.collection.createMany({
      data: [
        { name: "Bridal" },
        { name: "Wedding" },
        { name: "Everyday" },
        { name: "Festive" },
      ],
    });
  }
}
