import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import {
  ADMIN_HTTP_IDEMPOTENCY_KEY_MAX,
  ADMIN_HTTP_IDEMPOTENCY_KEY_MIN,
  AdminHttpIdempotencyError,
  type AdminHttpIdempotencyOperation,
} from "./admin-http-idempotency.constants";

/** Header name — same HTTP name as placeOrder; separate durable store. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

const PRINTABLE_NO_WS = /^[\x21-\x7E]+$/;

/**
 * Validate Idempotency-Key for W3 Admin refund mutations (§4f).
 * Length [8, 128] · printable ASCII · no whitespace.
 */
export function requireAdminHttpIdempotencyKey(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new BadRequestException({
      error: AdminHttpIdempotencyError.KEY_REQUIRED,
      message: "Idempotency-Key required",
    });
  }
  const key = raw.trim();
  if (
    key.length < ADMIN_HTTP_IDEMPOTENCY_KEY_MIN ||
    key.length > ADMIN_HTTP_IDEMPOTENCY_KEY_MAX ||
    !PRINTABLE_NO_WS.test(key)
  ) {
    throw new BadRequestException({
      error: AdminHttpIdempotencyError.KEY_INVALID,
      message: "Idempotency-Key invalid",
    });
  }
  return key;
}

/**
 * SHA-256 hex of canonical fingerprint inputs (§4f).
 * Caller must already exclude currentPassword / Authorization / secrets.
 */
export function hashAdminHttpIdempotencyFingerprint(input: {
  operation: AdminHttpIdempotencyOperation;
  targetId: string;
  canonicalBody: Record<string, unknown>;
}): string {
  const payload = {
    operation: input.operation,
    targetId: input.targetId,
    body: canonicalize(input.canonicalBody),
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = canonicalize(obj[k]);
  }
  return out;
}
