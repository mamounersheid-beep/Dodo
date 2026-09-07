/** Shared contracts — source of truth for web/admin/api. No float money. */

export type MoneyString = string;

/**
 * UI / communication locales V1.
 * Sources: COMPLIANCE Tr3/Tr3b · 10.10 §0a/§0b · 11 §12.
 * Not Market/Jurisdiction · not a DB column · not per-email-type locale.
 */
export type SupportedLocale = "de" | "en" | "ar";

/**
 * Non-Order transactional email job payload locale field (Tr3b).
 * Resolved at schedule time: User.locale → explicit flow locale → en.
 * Applies to: email_verify · password_reset · email_change · Newsletter DOI.
 * Not Order.locale snapshot · not User.communicationLocale.
 */
export type NonOrderTransactionalEmailJobPayload = {
  communicationLocale: SupportedLocale;
};

/** #7 · 10.15 — CompanySettings.paymentsEnabled Json. Keys closed V1. */
export type PaymentsEnabledV1 = {
  stripe: boolean;
  paypal: boolean;
};

/**
 * #15 · 10.8 §4c · 10.2 deliveryTime block — Order.deliveryTimeDisclosureSnapshot Json.
 * Live API may add isPreview; PLACED snapshot does not.
 */
export type DeliveryTimeDisclosureSnapshot = {
  disclosureLevel: "composite" | "transit_only";
  labelShown: string;
  locale: SupportedLocale;
  processingDaysMin?: number;
  processingDaysMax?: number;
  transitDaysMin?: number;
  transitDaysMax?: number;
  lieferzeitDaysMin?: number;
  lieferzeitDaysMax?: number;
  shippingRateId?: string;
  shippingMethodCode?: string;
  sources: Record<string, unknown>;
};

/**
 * #13 · 10.8 §4d · 10.10 §1b B-Seller — Order.sellerIdentitySnapshotJson.
 * Captured once at PLACED from CompanySettings; immutable afterwards.
 * ≠ Invoice.sellerSnapshotJson · ≠ live CompanySettings at email send.
 */
export type OrderSellerIdentitySnapshot = {
  legalName: string;
  line1: string;
  postalCode: string;
  city: string;
  countryCode: string;
  supportEmail: string | null;
  supportPhone: string | null;
};

/** #3 · 10.13 §8c — ReturnRequest.returnAddressSnapshotJson (as shown to customer). */
export type ReturnAddressSnapshot = {
  returnAddressName: string;
  returnAddressLine1: string;
  returnAddressLine2?: string | null;
  postalCode: string;
  city: string;
  countryCode: string;
  returnAddressPhone?: string | null;
};

/** #14 · 10.16 — LegalPage.consentMigrationPolicy Json (not a Prisma enum). */
export type ConsentMigrationPolicyKind =
  | "NO_ACTION"
  | "INVALIDATE_CATEGORIES"
  | "INVALIDATE_ALL_NON_ESSENTIAL";

export type ConsentMigrationCategory = "preferences" | "analytics" | "marketing";

export type ConsentMigrationPolicy = {
  kind: ConsentMigrationPolicyKind;
  categories?: ConsentMigrationCategory[];
  determinedAt: string;
  determinedByActorId: string;
};

/** #8 · ERD / 10.2 */
export enum GpsrCatalogTier {
  standard = "standard",
  restricted = "restricted",
}

/** L5 · ERD / COMPLIANCE */
export enum GrundpreisRequirement {
  inherit = "inherit",
  require = "require",
  exempt = "exempt",
}

/** #8 · ERD / 10.2 */
export enum ManufacturerSource {
  store_default = "store_default",
  product_specific = "product_specific",
}

/** #9 · 10.13 §9d · ERD */
export enum ReturnShippingCostWiderrufPolicy {
  MERCHANT_PAYS = "MERCHANT_PAYS",
  CUSTOMER_PAYS_DIRECT_COST = "CUSTOMER_PAYS_DIRECT_COST",
  CUSTOMER_PAYS_STATED_ESTIMATE = "CUSTOMER_PAYS_STATED_ESTIMATE",
}

export enum OrderStatus {
  PLACED = "PLACED",
  CONFIRMED = "CONFIRMED",
  PROCESSING = "PROCESSING",
  SHIPPED = "SHIPPED",
  DELIVERED = "DELIVERED",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
  RETURN_REQUESTED = "RETURN_REQUESTED",
  RETURNED = "RETURNED",
  REFUNDED = "REFUNDED",
}

export enum PaymentStatus {
  PENDING = "PENDING",
  PAID = "PAID",
  FAILED = "FAILED",
  REFUNDED = "REFUNDED",
  PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED",
}

export enum RoleCode {
  CUSTOMER = "CUSTOMER",
  SUPPORT = "SUPPORT",
  ADMIN = "ADMIN",
  OWNER = "OWNER",
  SYSTEM = "SYSTEM",
}

export type CartRecalcLine = {
  variantId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: MoneyString;
  lineTotal: MoneyString;
};

/**
 * Slice 3g — cart Lieferzeit preview on successful POST /v1/cart/recalculate.
 * Omit the key when processing or selected-rate transit is incomplete/invalid.
 * Not DeliveryTimeDisclosureSnapshot (Order / G3).
 */
export type CartDeliveryTimePreview = {
  disclosureLevel: "composite";
  labelShown: string;
  processingDaysMin: number;
  processingDaysMax: number;
  transitDaysMin: number;
  transitDaysMax: number;
  deliveryTimeDaysMin: number;
  deliveryTimeDaysMax: number;
  isPreview: true;
};

/**
 * Unified cart recalculate contract.
 * 3b merchandise + 3c shipping + G1 grandTotal/KU are always present on success.
 * Coupon/bonus layers remain optional (omit when not applicable).
 * 3g deliveryTime is optional — omit when either source is incomplete (no fake-fill).
 */
export type CartRecalcResponse = {
  currencyCode: "EUR";
  lines: CartRecalcLine[];
  itemsSubtotal: MoneyString;
  /** 3c — present after shipping layer */
  shippingTotal?: MoneyString;
  /** 3d — omit when no applicable goods coupon */
  discountCoupon?: MoneyString;
  /** 3e — omit when no applicable Bonus discount */
  discountBonus?: MoneyString;
  /** G1 — always present */
  grandTotal: MoneyString;
  /** G1 — live CompanySettings.isKleinunternehmer */
  companyIsKleinunternehmer: boolean;
  /** G1 — invoiceExemptionText when KU=true; null when KU=false */
  exemptionText: string | null;
  /** 3e — Never use browser as source of truth for these figures. */
  bonusPointsAvailable?: number;
  bonusPointsToRedeem?: number;
  /** 3g — composite Werktage preview; omit when sources incomplete */
  deliveryTime?: CartDeliveryTimePreview;
};

export type BonusBalanceResponse = {
  displayName: "Bonus+";
  balance: number;
};

/** G2 issuance — POST /v1/orders/checkout-key success body only. */
export type CheckoutKeyIssueResponse = {
  checkoutKey: string;
};

/** RR-S — POST /v1/orders/reserve success body only (InventoryService.reserve projection). */
export type ReserveResponse = {
  reservationId: string;
  quantity: number;
  expiresAt: string;
  availableAfter: number;
};

/** RR-S — POST /v1/orders/release success body only. */
export type ReleaseResponse = {
  releasedCount: number;
};
