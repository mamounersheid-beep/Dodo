/**
 * Slice 1 — placeOrder Preconditions Gate (read-only checks).
 * Paper: 10.8 §2a · CHECKOUT_SPEC · COMPLIANCE L1 A1+B1 · G-LC10 · S-DE · 10.15 #7
 */

/** G-LC10 — required PUBLISHED LegalPage slugs for Market DE */
export const REQUIRED_DE_LEGAL_SLUGS = [
  "impressum",
  "agb",
  "widerruf",
  "datenschutz",
] as const;

export type RequiredDeLegalSlug = (typeof REQUIRED_DE_LEGAL_SLUGS)[number];

export type PlaceOrderPreconditionsInput = {
  /** Shipping address country — V1 must be DE (S-DE) */
  shippingCountryCode: string;
};

export type PlaceOrderPreconditionsOk = {
  ok: true;
};

/** Stable error codes on ConflictException body.error */
export const PlaceOrderPreconditionError = {
  STORE_CHECKOUT_DISABLED: "STORE_CHECKOUT_DISABLED",
  L1_TAX_INCOMPLETE: "L1_TAX_INCOMPLETE",
  REQUIRED_LEGAL_PAGES_MISSING: "REQUIRED_LEGAL_PAGES_MISSING",
  SHIPPING_COUNTRY_NOT_DE: "SHIPPING_COUNTRY_NOT_DE",
  STORE_SETTINGS_MISSING: "STORE_SETTINGS_MISSING",
} as const;

export type PlaceOrderPreconditionErrorCode =
  (typeof PlaceOrderPreconditionError)[keyof typeof PlaceOrderPreconditionError];
