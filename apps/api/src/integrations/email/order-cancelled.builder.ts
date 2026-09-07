import type { OrderSellerIdentitySnapshot } from "@dodo/shared-types";
import type { CommunicationLocale } from "./email-integration.port";
import { resolveOrderCommunicationLocale } from "./email-integration.port";
import { parseOrderSellerIdentitySnapshot } from "./order-confirmation.builder";

/** Minimal Order + items for unpaid cancel email — snapshots only (10.10 §4a). */
export type OrderCancelledOrderSnapshot = {
  id: string;
  orderNumber: string;
  placedAt: Date;
  locale: string;
  userId: string | null;
  guestEmail: string | null;
  paymentStatus: string;
  currencyCode: string;
  sellerIdentitySnapshotJson: unknown;
  grandTotal: { toString(): string } | string | number;
  items: Array<{
    skuSnapshot: string;
    nameSnapshot: string;
    quantity: number;
  }>;
};

export type OrderCancelledBuilt = {
  communicationLocale: CommunicationLocale;
  subject: string;
  text: string;
  /** Registered only — never a guest #16 token link. */
  accessPath: string | null;
};

const SUBJECTS: Record<CommunicationLocale, string> = {
  de: "Bestellung storniert",
  en: "Order cancelled",
  ar: "تم إلغاء الطلب",
};

const BODY_UNPAID: Record<CommunicationLocale, string[]> = {
  de: [
    "Ihre Bestellung wurde storniert, weil das Zahlungsfenster abgelaufen ist (unbezahlt).",
    "Es ist keine weitere Zahlung für diese Bestellung fällig.",
    "Es wurde keine erfolgreiche Zahlung erfasst und keine Erstattung ausgelöst.",
  ],
  en: [
    "Your order was cancelled because the unpaid payment window expired.",
    "No further payment is due for this order.",
    "No successful payment was recorded and no refund was issued.",
  ],
  ar: [
    "أُلغي طلبك لأن نافذة الدفع غير المدفوع انتهت.",
    "لا يستحق أي دفع إضافي لهذا الطلب.",
    "لم يُسجَّل دفع ناجح ولم يُصدر استرداد.",
  ],
};

function money(v: { toString(): string } | string | number): string {
  const raw = typeof v === "object" && v && "toString" in v ? v.toString() : String(v);
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toFixed(2);
}

/**
 * Build order-cancelled body from Order / OrderItem / seller snapshots only.
 * Unpaid #4 disclosure only — never PAID / refund / guest #16 link (10.10 §4a).
 */
export function buildOrderCancelledEmail(input: {
  order: OrderCancelledOrderSnapshot;
}): OrderCancelledBuilt {
  const seller: OrderSellerIdentitySnapshot = parseOrderSellerIdentitySnapshot(
    input.order.sellerIdentitySnapshotJson,
  );
  const locale = resolveOrderCommunicationLocale(input.order.locale);
  const isGuest = input.order.userId == null;
  const accessPath = isGuest
    ? null
    : `/account/orders/${encodeURIComponent(input.order.orderNumber)}`;

  const paymentLabel =
    input.order.paymentStatus === "FAILED"
      ? "FAILED (unpaid — no charge completed)"
      : "PENDING (unpaid — no charge completed)";

  const lines: string[] = [
    `template=order_cancelled`,
    `communicationLocale=${locale}`,
    `orderNumber=${input.order.orderNumber}`,
    `placedAt=${input.order.placedAt.toISOString()}`,
    `paymentStatus=${paymentLabel}`,
    ...BODY_UNPAID[locale],
    ``,
    `--- line items (OrderItem snapshots) ---`,
  ];

  for (const it of input.order.items) {
    lines.push(`- ${it.nameSnapshot} / SKU ${it.skuSnapshot} × ${it.quantity}`);
  }

  lines.push(
    ``,
    `grandTotalSnapshot=${money(input.order.grandTotal)} ${input.order.currencyCode}`,
    ``,
    `--- seller (Order.sellerIdentitySnapshotJson) ---`,
    `seller=${seller.legalName}`,
    `sellerAddress=${seller.line1}, ${seller.postalCode} ${seller.city}, ${seller.countryCode}`,
    `sellerContact=${seller.supportEmail ?? ""} ${seller.supportPhone ?? ""}`.trim(),
    ``,
    `--- help ---`,
    `helpPath=/help`,
    `contactPath=/help/contact`,
  );

  if (accessPath) {
    lines.push(`accessPath=${accessPath}`);
  } else {
    lines.push(`accessPath=(none — guest #16 revoked on CANCELLED; no guest token link)`);
  }

  return {
    communicationLocale: locale,
    subject: SUBJECTS[locale],
    text: lines.join("\n"),
    accessPath,
  };
}
