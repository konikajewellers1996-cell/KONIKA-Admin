-- Drop old diamond spec model and switch product variants to quality + snapshot rates.

ALTER TABLE "ProductVariant" DROP CONSTRAINT IF EXISTS "ProductVariant_diamondSpecId_fkey";

ALTER TABLE "ProductVariant" DROP COLUMN IF EXISTS "diamondSpecId";

DROP TABLE IF EXISTS "DiamondSpec";

ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "diamondQualityId" TEXT;
ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "diamondCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "pricePerCarat" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE "DiamondQuality" (
    "id" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "clarity" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiamondQuality_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiamondQuality_color_clarity_key" ON "DiamondQuality"("color", "clarity");

CREATE TABLE "DiamondPricingSlab" (
    "id" TEXT NOT NULL,
    "qualityId" TEXT NOT NULL,
    "centsFrom" DOUBLE PRECISION NOT NULL,
    "centsTo" DOUBLE PRECISION NOT NULL,
    "pricePerCarat" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiamondPricingSlab_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiamondPricingSlab_qualityId_status_idx" ON "DiamondPricingSlab"("qualityId", "status");

ALTER TABLE "DiamondPricingSlab" ADD CONSTRAINT "DiamondPricingSlab_qualityId_fkey" FOREIGN KEY ("qualityId") REFERENCES "DiamondQuality"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_diamondQualityId_fkey" FOREIGN KEY ("diamondQualityId") REFERENCES "DiamondQuality"("id") ON DELETE SET NULL ON UPDATE CASCADE;
