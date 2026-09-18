ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "discountsJson" TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS "DiscountRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL DEFAULT '',
    "isCoupon" BOOLEAN NOT NULL DEFAULT false,
    "targets" TEXT NOT NULL DEFAULT '["making"]',
    "valueType" TEXT NOT NULL DEFAULT 'percent',
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "collectionIds" TEXT NOT NULL DEFAULT '[]',
    "productIds" TEXT NOT NULL DEFAULT '[]',
    "applyAll" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountRule_pkey" PRIMARY KEY ("id")
);
