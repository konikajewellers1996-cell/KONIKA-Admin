ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "stonesJson" TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS "GemstoneType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '',
    "defaultRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GemstoneType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GemstoneType_name_key" ON "GemstoneType"("name");
