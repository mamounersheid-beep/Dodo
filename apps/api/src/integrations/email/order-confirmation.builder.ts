import type { OrderSellerIdentitySnapshot } from "@dodo/shared-types";
import type { CommunicationLocale } from "./email-integration.port";
import { resolveOrderCommunicationLocale } from "./email-integration.port";

/** Minimal Order + items shape for Bestätigung — snapshots only (10.10 §1b). */
export type OrderConfirmationOrderSnapshot = {
  id: string;
  orderNumber: string;
  placedAt: Date;
  locale: string;
  userId: string | null;
  guestEmail: string | null;
  paymentStatus: string;
  currencyCode: string;
  taxMode: string;
  companyIsKleinunternehmer: boolean;
  invoiceExemptionTextSnapshot: string | null;
  /** #13 — immutable seller identity at PLACED; never live CompanySettings */
  sellerIdentitySnapshotJson: unknown;
  itemsSubtotal: { toString(): string } | string | number;
  shippingTotal: { toString(): string } | string | number;
  discountCoupon: { toString(): string } | string | number;
  discountBonus: { toString(): string } | string | number;
  grandTotal: { toString(): string } | string | number;
  shippingAddressJson: unknown;
  billingAddressJson: unknown;
  legalAgbVersionId: string | null;
  legalAgbHash: string | null;
  legalWiderrufVersionId: string | null;
  legalWiderrufHash: string | null;
  legalPrivacyVersionId: string | null;
  legalPrivacyHash: string | null;
  items: Array<{
    skuSnapshot: string;
    nameSnapshot: string;
    quantity: number;
    unitPriceSnapshot: { toString(): string } | string | number;
    lineTotalSnapshot: { toString(): string } | string | number;
  }>;
};

export type OrderConfirmationBuilt = {
  communicationLocale: CommunicationLocale;
  subject: string;
  text: string;
  accessPath: string;
  paymentStatus: string;
};

const SUBJECTS: Record<CommunicationLocale, string> = {
  de: "Bestellbestätigung",
  en: "Order confirmation",
  ar: "تأكيد الطلب",
};

const PENDING_LABEL: Record<CommunicationLocale, string> = {
  de: "Zahlung ausstehend (paymentStatus=PENDING) — noch nicht bezahlt",
  en: "Payment pending (paymentStatus=PENDING) — not paid",
  ar: "الدفع معلّق (paymentStatus=PENDING) — لم يُدفع بعد",
};

function money(v: { toString(): string } | string | number): string {
  const raw = typeof v === "object" && v && "toString" in v ? v.toString() : String(v);
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toFixed(2);
}

function formatAddress(json: unknown): string {
  if (json == null) return "(none)";
  if (typeof json === "string") return json;
  try {
    return JSON.stringify(json);
  } catch {
    return String(json);
  }
}

/** Parse Order.sellerIdentitySnapshotJson — required identity/address; nullable contacts. */
export function parseOrderSellerIdentitySnapshot(json: unknown): OrderSellerIdentitySnapshot {
  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("order-confirmation: sellerIdentitySnapshotJson missing or invalid");
  }
  const o = json as Record<string, unknown>;
  const req = (key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new Error(`order-confirmation: sellerIdentitySnapshotJson.${key} required`);
    }
    return v;
  };
  const optStr = (key: string): string | null => {
    const v = o[key];
    if (v == null) return null;
    if (typeof v !== "string") {
      throw new Error(`order-confirmation: sellerIdentitySnapshotJson.${key} must be string|null`);
    }
    return v;
  };
  return {
    legalName: req("legalName"),
    line1: req("line1"),
    postalCode: req("postalCode"),
    city: req("city"),
    countryCode: req("countryCode"),
    supportEmail: optStr("supportEmail"),
    supportPhone: optStr("supportPhone"),
  };
}

/**
 * Build Bestätigung body exclusively from Order / OrderItem snapshots.
 * Seller identity = Order.sellerIdentitySnapshotJson only (not live CompanySettings).
 * Must NOT read live Product/Variant prices or User.locale (Tr3).
 * Payment disclosure = fixed contractual PENDING / not-paid (10.10 §1b / §2a) —
 * never live Order.paymentStatus wording (PAID/refund).
 */
export function buildOrderConfirmationEmail(input: {
  order: OrderConfirmationOrderSnapshot;
  /** Raw guest token for tracking link — guest only (#16). */
  guestAccessToken?: string;
}): OrderConfirmationBuilt {
  const seller = parseOrderSellerIdentitySnapshot(input.order.sellerIdentitySnapshotJson);
  const locale = resolveOrderCommunicationLocale(input.order.locale);
  const isGuest = input.order.userId == null;
  const accessPath = isGuest
    ? `/order-tracking?orderNumber=${encodeURIComponent(input.order.orderNumber)}&token=${encodeURIComponent(input.guestAccessToken ?? "")}`
    : `/account/orders/${encodeURIComponent(input.order.orderNumber)}`;

  /** §2a — Bestätigung payment disclosure is always PENDING / not-paid. */
  const paymentDisclosureStatus = "PENDING";

  const lines: string[] = [
    `template=order_confirmation`,
    `communicationLocale=${locale}`,
    `orderNumber=${input.order.orderNumber}`,
    `placedAt=${input.order.placedAt.toISOString()}`,
    `paymentStatus=${paymentDisclosureStatus}`,
    PENDING_LABEL[locale],
    ``,
    `--- line items (OrderItem snapshots) ---`,
  ];

  for (const it of input.order.items) {
    lines.push(
      `- ${it.nameSnapshot} / SKU ${it.skuSnapshot} × ${it.quantity} @ ${money(it.unitPriceSnapshot)} = ${money(it.lineTotalSnapshot)} ${input.order.currencyCode}`,
    );
  }

  lines.push(
    ``,
    `--- totals (Order snapshots) ---`,
    `itemsSubtotal=${money(input.order.itemsSubtotal)}`,
    `discountCoupon=${money(input.order.discountCoupon)}`,
    `discountBonus=${money(input.order.discountBonus)} (preview)`,
    `shippingTotal=${money(input.order.shippingTotal)}`,
    `grandTotal=${money(input.order.grandTotal)} ${input.order.currencyCode}`,
    ``,
    `--- tax / Kleinunternehmer (Market DE) ---`,
    `taxMode=${input.order.taxMode}`,
    `companyIsKleinunternehmer=${input.order.companyIsKleinunternehmer}`,
  );

  if (input.order.companyIsKleinunternehmer || input.order.taxMode === "KLEINUNTERNEHMER") {
    const ku =
      input.order.invoiceExemptionTextSnapshot?.trim() ||
      "Gemäß §19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmer).";
    lines.push(`KU=${ku}`);
  }

  lines.push(
    ``,
    `--- addresses (Order snapshots) ---`,
    `shippingAddress=${formatAddress(input.order.shippingAddressJson)}`,
    `billingAddress=${formatAddress(input.order.billingAddressJson)}`,
    ``,
    `--- seller (Order.sellerIdentitySnapshotJson) ---`,
    `seller=${seller.legalName}`,
    `sellerAddress=${seller.line1}, ${seller.postalCode} ${seller.city}, ${seller.countryCode}`,
    `sellerContact=${seller.supportEmail ?? ""} ${seller.supportPhone ?? ""}`.trim(),
    ``,
    `--- legal (captured versions) ---`,
    `AGB versionId=${input.order.legalAgbVersionId ?? ""} hash=${input.order.legalAgbHash ?? ""} path=/legal/agb`,
    `Widerruf versionId=${input.order.legalWiderrufVersionId ?? ""} hash=${input.order.legalWiderrufHash ?? ""} path=/legal/widerruf`,
    `Datenschutz versionId=${input.order.legalPrivacyVersionId ?? ""} hash=${input.order.legalPrivacyHash ?? ""} path=/legal/datenschutz`,
    ``,
    `--- next step ---`,
    `accessPath=${accessPath}`,
  );

  return {
    communicationLocale: locale,
    subject: SUBJECTS[locale],
    text: lines.join("\n"),
    accessPath,
    paymentStatus: paymentDisclosureStatus,
  };
}
