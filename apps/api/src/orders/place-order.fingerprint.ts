import type { PlaceOrderAddressDto, PlaceOrderDto } from "./dto/place-order.dto";

const ADDRESS_KEYS = [
  "name",
  "line1",
  "line2",
  "postalCode",
  "city",
  "countryCode",
  "phone",
] as const;

/** B1 — trim only; empty after trim = absent (same as no coupon). */
export function normalizeCouponCode(code: string | null | undefined): string | null {
  const trimmed = code?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function addressMember(
  addr: PlaceOrderAddressDto | Record<string, unknown> | null | undefined,
  key: (typeof ADDRESS_KEYS)[number],
): unknown {
  if (!addr || typeof addr !== "object") return undefined;
  const value = (addr as Record<string, unknown>)[key];
  return value === undefined ? undefined : value;
}

function addressesEqual(
  stored: unknown,
  requested: PlaceOrderAddressDto,
): boolean {
  const left =
    stored && typeof stored === "object" ? (stored as Record<string, unknown>) : null;
  for (const key of ADDRESS_KEYS) {
    if (addressMember(left, key) !== addressMember(requested, key)) return false;
  }
  return true;
}

export type FingerprintRequest = {
  shippingAddressJson: PlaceOrderAddressDto;
  billingAddressJson: PlaceOrderAddressDto;
  paymentMethodCode: string;
  couponCode?: string;
  bonusPointsToRedeem?: number;
  guestEmail?: string;
  isGuest: boolean;
};

export type StoredFingerprint = {
  shippingAddressJson: unknown;
  billingAddressJson: unknown;
  paymentMethodCodeSnapshot: string | null;
  couponCodeSnapshot: string | null;
  bonusPointsToRedeem: number | null;
  guestEmail: string | null;
};

/**
 * G4 §3b commercial fingerprint — exact member equality after B1/D1 only.
 * bonusPointsToRedeem: absent (null) !== 0. guestEmail compared only for guests.
 */
export function fingerprintsMatch(
  stored: StoredFingerprint,
  request: FingerprintRequest,
): boolean {
  if (!addressesEqual(stored.shippingAddressJson, request.shippingAddressJson)) {
    return false;
  }
  if (!addressesEqual(stored.billingAddressJson, request.billingAddressJson)) {
    return false;
  }
  if (stored.paymentMethodCodeSnapshot !== request.paymentMethodCode) {
    return false;
  }
  if (normalizeCouponCode(stored.couponCodeSnapshot) !== normalizeCouponCode(request.couponCode)) {
    return false;
  }
  const requestedBonus =
    request.bonusPointsToRedeem === undefined ? null : request.bonusPointsToRedeem;
  if (stored.bonusPointsToRedeem !== requestedBonus) {
    return false;
  }
  if (request.isGuest) {
    const requestedEmail = request.guestEmail ?? null;
    if (stored.guestEmail !== requestedEmail) return false;
  }
  return true;
}

export function fingerprintFromDto(
  dto: PlaceOrderDto,
  isGuest: boolean,
): FingerprintRequest {
  return {
    shippingAddressJson: dto.shippingAddressJson,
    billingAddressJson: dto.billingAddressJson,
    paymentMethodCode: dto.paymentMethodCode,
    couponCode: dto.couponCode,
    bonusPointsToRedeem: dto.bonusPointsToRedeem,
    guestEmail: dto.guestEmail,
    isGuest,
  };
}
