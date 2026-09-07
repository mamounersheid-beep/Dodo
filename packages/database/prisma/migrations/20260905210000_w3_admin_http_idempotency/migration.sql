-- W3 Admin HTTP Idempotency Durable Storage — Paper Closed 2026-09-05
-- SoT: docs/10.9-payments-webhooks.md §4f Persist
-- Table AdminHttpIdempotency only — no Refund / providerRefundId / G4 changes

CREATE TYPE "AdminHttpIdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

CREATE TABLE "AdminHttpIdempotency" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "status" "AdminHttpIdempotencyStatus" NOT NULL,
    "httpStatus" INTEGER,
    "responseBodyJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminHttpIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminHttpIdempotency_actorId_namespace_key_key"
  ON "AdminHttpIdempotency"("actorId", "namespace", "key");

CREATE INDEX "AdminHttpIdempotency_expiresAt_idx"
  ON "AdminHttpIdempotency"("expiresAt");
