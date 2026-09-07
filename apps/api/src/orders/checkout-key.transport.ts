import { BadRequestException } from "@nestjs/common";

/** G2-B Transport — inbound consuming header only. */
export const CHECKOUT_KEY_HEADER = "x-checkout-key";

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Validate x-checkout-key at Orders transport boundary before Inventory.
 * Missing / blank / whitespace / malformed (not unpadded base64url 32 bytes) → 400.
 * Does not prove the key was issued (G2-C / G2-D-R9).
 */
export function requireCheckoutKeyHeader(raw: string | undefined): string {
  const key = raw?.trim() ?? "";
  if (!key) {
    throw new BadRequestException({
      error: "VALIDATION_ERROR",
      message: "x-checkout-key required",
    });
  }
  if (key.includes("=") || key.includes("+") || key.includes("/") || !BASE64URL_RE.test(key)) {
    throw new BadRequestException({
      error: "VALIDATION_ERROR",
      message: "x-checkout-key malformed",
    });
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(key, "base64url");
  } catch {
    throw new BadRequestException({
      error: "VALIDATION_ERROR",
      message: "x-checkout-key malformed",
    });
  }
  if (decoded.length !== 32) {
    throw new BadRequestException({
      error: "VALIDATION_ERROR",
      message: "x-checkout-key malformed",
    });
  }
  return key;
}
