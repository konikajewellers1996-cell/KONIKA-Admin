import prisma from "../db.server";

export async function ensureAppSeed() {
  await prisma.appSetting.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default", goldPricePerGram: 6500 },
  });

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

  const existingCollections = await prisma.collection.count();
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
