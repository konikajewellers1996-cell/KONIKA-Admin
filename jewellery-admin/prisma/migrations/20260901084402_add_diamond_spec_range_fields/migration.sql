/*
  Warnings:

  - You are about to drop the column `carat` on the `DiamondSpec` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "DiamondSpec" DROP COLUMN "carat",
ADD COLUMN     "caratFrom" DOUBLE PRECISION,
ADD COLUMN     "caratTo" DOUBLE PRECISION,
ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "cut" DROP NOT NULL,
ALTER COLUMN "color" DROP NOT NULL,
ALTER COLUMN "clarity" DROP NOT NULL;

-- AlterTable
ALTER TABLE "_ProductToCollection" ADD CONSTRAINT "_ProductToCollection_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "_ProductToCollection_AB_unique";
