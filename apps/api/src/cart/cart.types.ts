/**
 * Cart Slice 3a — persistence + sellability/stock gates.
 * Slice 3b — merchandise recalculate via CartService.recalculate → CartRecalcResponse.
 * Guest transport: header `x-guest-key` (minted on first cart access if absent).
 */

export const GUEST_KEY_HEADER = "x-guest-key";

export const CartError = {
  STOCK_LIMIT_EXCEEDED: "STOCK_LIMIT_EXCEEDED",
  INVALID_QUANTITY: "INVALID_QUANTITY",
  GUEST_KEY_REQUIRED: "GUEST_KEY_REQUIRED",
  ITEM_NOT_FOUND: "ITEM_NOT_FOUND",
  SHIPPING_COUNTRY_REQUIRED: "SHIPPING_COUNTRY_REQUIRED",
  SHIPPING_COUNTRY_NOT_SUPPORTED: "SHIPPING_COUNTRY_NOT_SUPPORTED",
  SHIPPING_RATE_UNAVAILABLE: "SHIPPING_RATE_UNAVAILABLE",
  FREE_SHIPPING_THRESHOLD_MISSING: "FREE_SHIPPING_THRESHOLD_MISSING",
  /** Slice 3d B2 — umbrella for invalid coupon applicability/validity */
  INVALID_COUPON: "INVALID_COUPON",
  /** #7 — couponsEnabled=false + non-empty coupon attempt */
  STORE_COUPONS_DISABLED: "STORE_COUPONS_DISABLED",
  /** Slice 3e D6 — bonusPlusEnabled=false + bonusPointsToRedeem intent (registered user) */
  STORE_BONUS_DISABLED: "STORE_BONUS_DISABLED",
} as const;

export type CartErrorCode = (typeof CartError)[keyof typeof CartError];

/** 3a cart state — not CartRecalcResponse (no shipping/coupon/bonus totals). */
export type CartStateResponse = {
  id: string;
  currencyCode: "EUR";
  identity:
    | { type: "user"; userId: string }
    | { type: "guest"; guestKey: string };
  items: CartStateItem[];
};

/**
 * Slice 3f F4 — merge response: CartStateResponse plus the single F2 notice field.
 * CartStateResponse itself is unchanged; the flag exists only on this contract.
 */
export type CartMergeResponse = CartStateResponse & {
  quantitiesReducedByAvailability: boolean;
};

export type CartStateItem = {
  variantId: string;
  quantity: number;
  sku: string;
  name: string;
  /** Display unit price from Variant — not a cart totals engine. */
  unitPrice: string;
};
