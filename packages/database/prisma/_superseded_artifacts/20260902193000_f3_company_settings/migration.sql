-- F3 CompanySettings only (Slice 1 Phase-1)
-- Contractual defaults via DEFAULT; Owner-required columns nullable (no invented values).

DO $$ BEGIN
  CREATE TYPE "GpsrCatalogTier" AS ENUM ('standard', 'restricted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "GrundpreisRequirement" AS ENUM ('inherit', 'require', 'exempt');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ManufacturerSource" AS ENUM ('store_default', 'product_specific');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ReturnShippingCostWiderrufPolicy" AS ENUM (
    'MERCHANT_PAYS',
    'CUSTOMER_PAYS_DIRECT_COST',
    'CUSTOMER_PAYS_STATED_ESTIMATE'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "CompanySettings"
  ADD COLUMN IF NOT EXISTS "returnAddressName" TEXT,
  ADD COLUMN IF NOT EXISTS "returnAddressLine1" TEXT,
  ADD COLUMN IF NOT EXISTS "returnAddressLine2" TEXT,
  ADD COLUMN IF NOT EXISTS "returnPostalCode" TEXT,
  ADD COLUMN IF NOT EXISTS "returnCity" TEXT,
  ADD COLUMN IF NOT EXISTS "returnCountryCode" CHAR(2),
  ADD COLUMN IF NOT EXISTS "returnAddressPhone" TEXT,
  ADD COLUMN IF NOT EXISTS "returnInstructionsMarkdown" TEXT,
  ADD COLUMN IF NOT EXISTS "returnShipWithinDays" INTEGER,
  ADD COLUMN IF NOT EXISTS "returnShippingCostWiderrufPolicy" "ReturnShippingCostWiderrufPolicy",
  ADD COLUMN IF NOT EXISTS "orderProcessingDaysMin" INTEGER,
  ADD COLUMN IF NOT EXISTS "orderProcessingDaysMax" INTEGER,
  ADD COLUMN IF NOT EXISTS "defaultManufacturerDisplayName" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultManufacturerAddressLine1" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultManufacturerAddressLine2" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultManufacturerPostalCode" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultManufacturerCity" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultManufacturerCountryCode" CHAR(2),
  ADD COLUMN IF NOT EXISTS "defaultManufacturerEstablishedInUnion" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "defaultManufacturerEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultEuResponsiblePersonDisplayName" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultEuResponsiblePersonAddressLine1" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultEuResponsiblePersonAddressLine2" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultEuResponsiblePersonPostalCode" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultEuResponsiblePersonCity" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultEuResponsiblePersonCountryCode" CHAR(2),
  ADD COLUMN IF NOT EXISTS "defaultEuResponsiblePersonEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "maintenanceMode" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "maintenanceNoticeMarkdown" TEXT,
  ADD COLUMN IF NOT EXISTS "maintenanceNoticeLocale" TEXT NOT NULL DEFAULT 'de',
  ADD COLUMN IF NOT EXISTS "checkoutEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "paymentsEnabled" JSONB NOT NULL DEFAULT '{"stripe":true,"paypal":true}',
  ADD COLUMN IF NOT EXISTS "couponsEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "bonusPlusEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "operationalFlagsUpdatedAt" TIMESTAMP(3);

-- Safe init for operationalFlagsUpdatedAt (Execute procedure — not contractual @default(now()))
UPDATE "CompanySettings"
SET "operationalFlagsUpdatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'default' AND "operationalFlagsUpdatedAt" IS NULL;
