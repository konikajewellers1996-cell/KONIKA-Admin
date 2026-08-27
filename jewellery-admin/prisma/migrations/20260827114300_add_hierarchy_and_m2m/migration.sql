-- CreateTable
CREATE TABLE "_ProductToCollection" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_ProductToCollection_AB_unique" ON "_ProductToCollection"("A", "B");
CREATE INDEX "_ProductToCollection_B_index" ON "_ProductToCollection"("B");

-- AddForeignKey
ALTER TABLE "_ProductToCollection" ADD CONSTRAINT "_ProductToCollection_A_fkey" FOREIGN KEY ("A") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_ProductToCollection" ADD CONSTRAINT "_ProductToCollection_B_fkey" FOREIGN KEY ("B") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Copy existing one-to-many relationships into the join table
INSERT INTO "_ProductToCollection" ("A", "B")
SELECT "collectionId", "id" FROM "Product"
WHERE "collectionId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "Product" DROP CONSTRAINT "Product_collectionId_fkey";

-- DropColumn
ALTER TABLE "Product" DROP COLUMN "collectionId";

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN "parentId" TEXT;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
