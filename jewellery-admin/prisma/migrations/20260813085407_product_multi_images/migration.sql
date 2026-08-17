-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT NOT NULL DEFAULT '',
    "shopifyFileId" TEXT,
    "imagesJson" TEXT NOT NULL DEFAULT '[]',
    "gender" TEXT NOT NULL DEFAULT 'Unisex',
    "collectionId" TEXT,
    "shopifyProductId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Product_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Product" ("collectionId", "createdAt", "description", "gender", "id", "imageUrl", "name", "shopifyFileId", "shopifyProductId", "sku", "status", "updatedAt") SELECT "collectionId", "createdAt", "description", "gender", "id", "imageUrl", "name", "shopifyFileId", "shopifyProductId", "sku", "status", "updatedAt" FROM "Product";
DROP TABLE "Product";
ALTER TABLE "new_Product" RENAME TO "Product";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
