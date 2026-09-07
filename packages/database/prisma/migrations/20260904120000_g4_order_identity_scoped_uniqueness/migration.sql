-- G4 schema license — Paper Closed 2026-09-04 (`10.8` §3c)
-- Order.bonusPointsToRedeem Int?  — NULL=absent, 0=explicit zero, n>0=raw request intent
-- Order.guestKey String?          — NULL registered; trimmed x-guest-key guest
-- Remove global unique on Order.idempotencyKey
-- Partial uniques (identity-scoped):
--   (userId, idempotencyKey) WHERE userId IS NOT NULL
--   (guestKey, idempotencyKey) WHERE guestKey IS NOT NULL

ALTER TABLE "Order" ADD COLUMN "guestKey" TEXT;
ALTER TABLE "Order" ADD COLUMN "bonusPointsToRedeem" INTEGER;

DROP INDEX "Order_idempotencyKey_key";

CREATE UNIQUE INDEX "Order_userId_idempotencyKey_key"
  ON "Order"("userId", "idempotencyKey")
  WHERE "userId" IS NOT NULL;

CREATE UNIQUE INDEX "Order_guestKey_idempotencyKey_key"
  ON "Order"("guestKey", "idempotencyKey")
  WHERE "guestKey" IS NOT NULL;
