import { BadRequestException } from "@nestjs/common";

/** PO-I — header name is HTTP case-insensitive; Nest lowercases incoming headers. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * Mandatory Idempotency-Key on POST /v1/orders.
 * Missing / blank after trim → 400. No server-generated key (PO-I-R6).
 */
export function requireIdempotencyKeyHeader(raw: string | undefined): string {
  const key = raw?.trim() ?? "";
  if (!key) {
    throw new BadRequestException({
      error: "VALIDATION_ERROR",
      message: "Idempotency-Key required",
    });
  }
  return key;
}
