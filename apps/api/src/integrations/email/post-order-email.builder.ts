import type { CommunicationLocale } from "./email-integration.port";
import { resolveOrderCommunicationLocale } from "./email-integration.port";

function money(v: { toString(): string } | string | number): string {
  const raw = typeof v === "object" && v && "toString" in v ? v.toString() : String(v);
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toFixed(2);
}

export type PostOrderBuilt = {
  communicationLocale: CommunicationLocale;
  subject: string;
  text: string;
  /** Must never carry binary PDF — link only for invoice. */
  pdfDownloadPath: string | null;
};

type OrderLite = {
  orderNumber: string;
  locale: string;
  userId: string | null;
  currencyCode: string;
  widerrufDeadlineAt?: Date | null;
  items?: Array<{ nameSnapshot: string; skuSnapshot: string; quantity: number }>;
};

function accessHint(order: OrderLite, guestAccessToken?: string): string {
  if (order.userId) {
    return `Account: /account/orders/${encodeURIComponent(order.orderNumber)}`;
  }
  if (guestAccessToken) {
    return `Tracking: /order-tracking?order=${encodeURIComponent(order.orderNumber)}&token=${guestAccessToken}`;
  }
  return `Order: ${order.orderNumber}`;
}

/** #17 shipment — snapshots only (10.10 §4). */
export function buildShipmentEmail(input: {
  order: OrderLite;
  shipment: {
    carrier: string;
    trackingNumber: string | null;
    trackingUrl: string | null;
  };
  guestAccessToken?: string;
}): PostOrderBuilt {
  const locale = resolveOrderCommunicationLocale(input.order.locale);
  const lines = (input.order.items ?? [])
    .map((i) => `- ${i.nameSnapshot} (${i.skuSnapshot}) × ${i.quantity}`)
    .join("\n");
  const subjects: Record<CommunicationLocale, string> = {
    de: "Ihre Bestellung wurde versendet",
    en: "Your order has shipped",
    ar: "تم شحن طلبك",
  };
  const text = [
    subjects[locale],
    `Order: ${input.order.orderNumber}`,
    `Carrier: ${input.shipment.carrier}`,
    input.shipment.trackingNumber
      ? `Tracking number: ${input.shipment.trackingNumber}`
      : null,
    input.shipment.trackingUrl ? `Tracking URL: ${input.shipment.trackingUrl}` : null,
    lines ? `Shipped items:\n${lines}` : null,
    accessHint(input.order, input.guestAccessToken),
    "Help / Widerruf: see store legal pages (Market DE).",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { communicationLocale: locale, subject: subjects[locale], text, pdfDownloadPath: null };
}

/** #17 invoice — PDF download link only, never attachment (10.10 / 10.11). */
export function buildInvoiceEmail(input: {
  order: OrderLite;
  invoice: {
    invoiceNumber: string;
    issuedAt: Date;
    grandTotalSnapshot: { toString(): string } | string | number;
    exemptionTextSnapshot: string | null;
    pdfObjectKey: string;
  };
}): PostOrderBuilt {
  const locale = resolveOrderCommunicationLocale(input.order.locale);
  const subjects: Record<CommunicationLocale, string> = {
    de: "Ihre Rechnung",
    en: "Your invoice",
    ar: "فاتورتك",
  };
  const pdfDownloadPath = `/v1/invoices/${encodeURIComponent(input.invoice.invoiceNumber)}/pdf`;
  const text = [
    subjects[locale],
    `Invoice: ${input.invoice.invoiceNumber}`,
    `Date: ${input.invoice.issuedAt.toISOString().slice(0, 10)}`,
    `Order: ${input.order.orderNumber}`,
    `Amount: ${money(input.invoice.grandTotalSnapshot)} ${input.order.currencyCode}`,
    input.invoice.exemptionTextSnapshot
      ? `Tax (DE): ${input.invoice.exemptionTextSnapshot}`
      : "Tax: Market DE rules apply.",
    `PDF download link only: ${pdfDownloadPath}`,
  ].join("\n\n");
  return { communicationLocale: locale, subject: subjects[locale], text, pdfDownloadPath };
}

/** #17 refund — after SUCCEEDED (10.10 §4). */
export function buildRefundEmail(input: {
  order: OrderLite;
  refund: {
    amount: { toString(): string } | string | number;
    currencyCode: string;
    refundTotal?: { toString(): string } | string | number | null;
  };
  orderGrandTotal: { toString(): string } | string | number;
}): PostOrderBuilt {
  const locale = resolveOrderCommunicationLocale(input.order.locale);
  const amt = money(input.refund.refundTotal ?? input.refund.amount);
  const full =
    Number(money(input.refund.amount)) >= Number(money(input.orderGrandTotal)) - 0.001;
  const subjects: Record<CommunicationLocale, string> = {
    de: "Ihre Erstattung",
    en: "Your refund",
    ar: "استردادك",
  };
  const kind =
    locale === "de"
      ? full
        ? "Vollständige Erstattung"
        : "Teilweise Erstattung"
      : locale === "ar"
        ? full
          ? "استرداد كامل"
          : "استرداد جزئي"
        : full
          ? "Full refund"
          : "Partial refund";
  const timing =
    locale === "de"
      ? "Die Gutschrift erscheint je nach Zahlungsanbieter in wenigen Werktagen."
      : locale === "ar"
        ? "يظهر الاسترداد عادة خلال أيام عمل حسب مزوّد الدفع."
        : "Funds typically appear within a few business days depending on your payment provider.";
  const text = [
    subjects[locale],
    `Order: ${input.order.orderNumber}`,
    `${kind}: ${amt} ${input.refund.currencyCode}`,
    timing,
    "Help: contact store support if needed.",
  ].join("\n\n");
  return { communicationLocale: locale, subject: subjects[locale], text, pdfDownloadPath: null };
}

/** #17 delivery — DELIVERED + deliveredAt (10.10 §4). */
export function buildDeliveryEmail(input: {
  order: OrderLite & { widerrufDeadlineAt: Date | null };
  deliveredAt: Date;
  guestAccessToken?: string;
}): PostOrderBuilt {
  const locale = resolveOrderCommunicationLocale(input.order.locale);
  const subjects: Record<CommunicationLocale, string> = {
    de: "Ihre Bestellung wurde zugestellt",
    en: "Your order was delivered",
    ar: "تم تسليم طلبك",
  };
  const text = [
    subjects[locale],
    `Order: ${input.order.orderNumber}`,
    `Delivered at: ${input.deliveredAt.toISOString()}`,
    input.order.widerrufDeadlineAt
      ? `Widerruf deadline: ${input.order.widerrufDeadlineAt.toISOString().slice(0, 10)}`
      : null,
    "Returns: use account/returns or order tracking when eligible.",
    accessHint(input.order, input.guestAccessToken),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { communicationLocale: locale, subject: subjects[locale], text, pdfDownloadPath: null };
}

/** #17 return-request — ReturnRequest snapshots (10.10 / 10.13). */
export function buildReturnRequestEmail(input: {
  order: OrderLite;
  returnRequest: {
    id: string;
    returnAddressSnapshotJson: unknown;
    returnInstructionsSnapshot: string;
    estimatedRefundTotal: { toString(): string } | string | number | null;
    returnLocale: string;
  };
  guestAccessToken?: string;
}): PostOrderBuilt {
  const locale = resolveOrderCommunicationLocale(
    input.returnRequest.returnLocale || input.order.locale,
  );
  const subjects: Record<CommunicationLocale, string> = {
    de: "Rückgabeanfrage eingegangen",
    en: "Return request received",
    ar: "تم استلام طلب الإرجاع",
  };
  const addr =
    typeof input.returnRequest.returnAddressSnapshotJson === "object" &&
    input.returnRequest.returnAddressSnapshotJson
      ? JSON.stringify(input.returnRequest.returnAddressSnapshotJson)
      : String(input.returnRequest.returnAddressSnapshotJson ?? "");
  const est = input.returnRequest.estimatedRefundTotal
    ? money(input.returnRequest.estimatedRefundTotal)
    : null;
  const text = [
    subjects[locale],
    `Order: ${input.order.orderNumber}`,
    `Return request: ${input.returnRequest.id}`,
    `Return address (snapshot):\n${addr}`,
    `Instructions:\n${input.returnRequest.returnInstructionsSnapshot}`,
    est
      ? `Estimated refund (non-binding): ${est} ${input.order.currencyCode}`
      : null,
    accessHint(input.order, input.guestAccessToken),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { communicationLocale: locale, subject: subjects[locale], text, pdfDownloadPath: null };
}
