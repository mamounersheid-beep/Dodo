-- F5 Delivery Time Disclosure — Paper Closed 2026-09-04 (Owner Policy + Field Identity)
-- ShippingRate.estimatedTransitDaysMin/Max: INTEGER NOT NULL, no database default
-- Order.deliveryTimeDisclosureSnapshot: JSONB NULL, no backfill
-- CompanySettings.orderProcessingDaysMin/Max already exist (F3); set Owner V1 1/3
-- Identify the V1 rate by DE zone + method code `standard` (not by cuid)

ALTER TABLE "ShippingRate" ADD COLUMN "estimatedTransitDaysMin" INTEGER;
ALTER TABLE "ShippingRate" ADD COLUMN "estimatedTransitDaysMax" INTEGER;

DO $$
DECLARE
  de_standard_count INTEGER;
  total_rate_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO de_standard_count
  FROM "ShippingRate" r
  JOIN "ShippingZone" z ON z.id = r."zoneId"
  JOIN "ShippingMethod" m ON m.id = r."methodId"
  WHERE z."countryCode" = 'DE'
    AND m.code = 'standard';

  SELECT COUNT(*) INTO total_rate_count FROM "ShippingRate";

  IF de_standard_count <> 1 THEN
    RAISE EXCEPTION 'F5 STOP: expected exactly 1 DE/standard ShippingRate, found %', de_standard_count;
  END IF;

  IF total_rate_count <> 1 THEN
    RAISE EXCEPTION 'F5 STOP: unexpected extra ShippingRate rows (total=%); will not invent transit', total_rate_count;
  END IF;
END $$;

UPDATE "ShippingRate" AS r
SET
  "estimatedTransitDaysMin" = 2,
  "estimatedTransitDaysMax" = 4
FROM "ShippingZone" z, "ShippingMethod" m
WHERE r."zoneId" = z.id
  AND r."methodId" = m.id
  AND z."countryCode" = 'DE'
  AND m.code = 'standard';

DO $$
DECLARE
  null_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM "ShippingRate"
  WHERE "estimatedTransitDaysMin" IS NULL
     OR "estimatedTransitDaysMax" IS NULL;

  IF null_count <> 0 THEN
    RAISE EXCEPTION 'F5 STOP: remaining NULL transit values: %', null_count;
  END IF;
END $$;

ALTER TABLE "ShippingRate" ALTER COLUMN "estimatedTransitDaysMin" SET NOT NULL;
ALTER TABLE "ShippingRate" ALTER COLUMN "estimatedTransitDaysMax" SET NOT NULL;

ALTER TABLE "Order" ADD COLUMN "deliveryTimeDisclosureSnapshot" JSONB;

DO $$
DECLARE
  settings_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO settings_count
  FROM "CompanySettings"
  WHERE id = 'default';

  IF settings_count <> 1 THEN
    RAISE EXCEPTION 'F5 STOP: expected CompanySettings id=default, found %', settings_count;
  END IF;
END $$;

UPDATE "CompanySettings"
SET
  "orderProcessingDaysMin" = 1,
  "orderProcessingDaysMax" = 3
WHERE id = 'default';

DO $$
DECLARE
  min_v INTEGER;
  max_v INTEGER;
BEGIN
  SELECT "orderProcessingDaysMin", "orderProcessingDaysMax"
  INTO min_v, max_v
  FROM "CompanySettings"
  WHERE id = 'default';

  IF min_v IS DISTINCT FROM 1 OR max_v IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'F5 STOP: expected processing 1/3, found %/%', min_v, max_v;
  END IF;
END $$;
