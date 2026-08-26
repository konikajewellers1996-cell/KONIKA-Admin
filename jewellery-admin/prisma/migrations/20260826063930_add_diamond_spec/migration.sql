-- CreateTable
CREATE TABLE "DiamondSpec" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cut" TEXT NOT NULL,
    "carat" REAL NOT NULL,
    "color" TEXT NOT NULL,
    "clarity" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ProductVariant" (
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
    "diamondSpecId" TEXT,
    "wastagePercent" REAL NOT NULL DEFAULT 0,
    "makingChargeType" TEXT NOT NULL DEFAULT 'percent',
    "makingChargeValue" REAL NOT NULL DEFAULT 0,
    "stoneRate" REAL NOT NULL DEFAULT 0,
    "imageUrl" TEXT NOT NULL DEFAULT '',
    "shopifyFileId" TEXT,
    "shopifyVariantId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductVariant_metalId_fkey" FOREIGN KEY ("metalId") REFERENCES "MetalType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProductVariant_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "PurityLevel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProductVariant_diamondSpecId_fkey" FOREIGN KEY ("diamondSpecId") REFERENCES "DiamondSpec" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ProductVariant" ("createdAt", "diamondCategory", "grossWeight", "id", "imageUrl", "makingChargeType", "makingChargeValue", "metalColor", "metalId", "productId", "purityId", "shopifyFileId", "shopifyVariantId", "status", "stoneIncluded", "stoneRate", "stoneType", "stoneWeight", "updatedAt", "wastagePercent") SELECT "createdAt", "diamondCategory", "grossWeight", "id", "imageUrl", "makingChargeType", "makingChargeValue", "metalColor", "metalId", "productId", "purityId", "shopifyFileId", "shopifyVariantId", "status", "stoneIncluded", "stoneRate", "stoneType", "stoneWeight", "updatedAt", "wastagePercent" FROM "ProductVariant";
DROP TABLE "ProductVariant";
ALTER TABLE "new_ProductVariant" RENAME TO "ProductVariant";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
