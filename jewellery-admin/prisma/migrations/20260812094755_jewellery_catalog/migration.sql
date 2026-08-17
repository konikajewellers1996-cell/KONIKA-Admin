-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "goldPricePerGram" REAL NOT NULL DEFAULT 6500,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "shopifyCollectionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MetalType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PurityLevel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "metalId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "karat" INTEGER NOT NULL DEFAULT 0,
    "purityValue" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PurityLevel_metalId_fkey" FOREIGN KEY ("metalId") REFERENCES "MetalType" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT NOT NULL DEFAULT '',
    "gender" TEXT NOT NULL DEFAULT 'Unisex',
    "collectionId" TEXT,
    "shopifyProductId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Product_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "metalId" TEXT NOT NULL,
    "purityId" TEXT NOT NULL,
    "metalColor" TEXT NOT NULL,
    "grossWeight" REAL NOT NULL,
    "stoneIncluded" BOOLEAN NOT NULL DEFAULT false,
    "stoneType" TEXT NOT NULL DEFAULT 'None',
    "stoneWeight" REAL NOT NULL DEFAULT 0,
    "diamondCategory" TEXT NOT NULL DEFAULT '',
    "wastagePercent" REAL NOT NULL DEFAULT 0,
    "makingChargeType" TEXT NOT NULL DEFAULT 'percent',
    "makingChargeValue" REAL NOT NULL DEFAULT 0,
    "stoneRate" REAL NOT NULL DEFAULT 0,
    "shopifyVariantId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductVariant_metalId_fkey" FOREIGN KEY ("metalId") REFERENCES "MetalType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProductVariant_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "PurityLevel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
