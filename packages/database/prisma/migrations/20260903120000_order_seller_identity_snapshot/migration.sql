-- #13 Order Seller Identity Snapshot — Paper Closed 2026-09-03
-- Order.sellerIdentitySnapshotJson NOT NULL (V1 Orders created as PLACED)
-- Backfill existing rows from CompanySettings default, then enforce NOT NULL.
-- Note: jsonb_build_object skips SQL NULL values — use COALESCE so contact keys remain present.

ALTER TABLE "Order" ADD COLUMN "sellerIdentitySnapshotJson" JSONB;

UPDATE "Order" AS o
SET "sellerIdentitySnapshotJson" = jsonb_build_object(
  'legalName', c."legalName",
  'line1', c."line1",
  'postalCode', c."postalCode",
  'city', c."city",
  'countryCode', c."countryCode",
  'supportEmail', COALESCE(to_jsonb(c."supportEmail"), 'null'::jsonb),
  'supportPhone', COALESCE(to_jsonb(c."supportPhone"), 'null'::jsonb)
)
FROM "CompanySettings" AS c
WHERE c."id" = 'default'
  AND o."sellerIdentitySnapshotJson" IS NULL;

ALTER TABLE "Order" ALTER COLUMN "sellerIdentitySnapshotJson" SET NOT NULL;
