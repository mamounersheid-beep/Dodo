/**
 * W3 §4f Persist — Admin HTTP Idempotency constants.
 * SoT: docs/10.9-payments-webhooks.md §4f Persist.
 * Separate from G4 / Order.idempotencyKey / provider keys.
 */

export const W3_ADMIN_REFUND_NAMESPACE = "w3.admin.refund" as const;

/** Retention: expiresAt = createdAt + 72h */
export const ADMIN_HTTP_IDEMPOTENCY_TTL_MS = 72 * 60 * 60 * 1000;

/** responseBodyJson max UTF-8 bytes */
export const ADMIN_HTTP_IDEMPOTENCY_RESPONSE_MAX_BYTES = 16 * 1024;

export const ADMIN_HTTP_IDEMPOTENCY_KEY_MIN = 8;
export const ADMIN_HTTP_IDEMPOTENCY_KEY_MAX = 128;

export type AdminHttpIdempotencyOperation =
  | "refund.create"
  | "refund.recover"
  | "refund.cancel"
  | "refund.retry";

export const AdminHttpIdempotencyError = {
  KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
  KEY_INVALID: "IDEMPOTENCY_KEY_INVALID",
  IN_PROGRESS: "IDEMPOTENCY_IN_PROGRESS",
  PAYLOAD_MISMATCH: "IDEMPOTENCY_PAYLOAD_MISMATCH",
  RESPONSE_TOO_LARGE: "IDEMPOTENCY_RESPONSE_TOO_LARGE",
} as const;
