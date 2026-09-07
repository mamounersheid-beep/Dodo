import { TaxMode, type PrismaClient } from "@dodo/database";
import {
  buildInvoicePdfBuffer,
  formatInvoiceMoney,
  resolveDocumentLocale,
  type InvoicePdfContent,
} from "./invoice-pdf.builder";
import { invoicePdfObjectKey } from "./invoice-pdf.keys";
import { resolveLeistungsdatumAsOfIssuedAt } from "./invoice-pdf.leistungsdatum";
import type { InvoicePdfObjectStorage } from "./invoice-pdf.port";

export type InvoicePdfProcessResult =
  | { status: "ready"; pdfObjectKey: string; claimed: boolean }
  | { status: "skipped_missing" }
  | { status: "skipped_not_issued" };

export type AfterInvoicePdfReadyFn = (invoiceId: string) => Promise<unknown>;

type PrismaLike = Pick<PrismaClient, "invoice" | "order" | "shipment">;

/**
 * Generate → private put → conditional pdfObjectKey claim → afterInvoicePdfReady.
 * Never mutates Invoice financial/snapshot fields. Never voids issuance.
 */
export async function processInvoicePdfJob(
  invoiceId: string,
  deps: {
    prisma: PrismaLike;
    storage: InvoicePdfObjectStorage;
    afterInvoicePdfReady: AfterInvoicePdfReadyFn;
  },
): Promise<InvoicePdfProcessResult> {
  const invoice = await deps.prisma.invoice.findUnique({
    where: { id: invoiceId },
  });
  if (!invoice) return { status: "skipped_missing" };

  if (invoice.status !== "issued" && invoice.status !== "cancelled_by_credit_note") {
    return { status: "skipped_not_issued" };
  }

  // Already PDF READY — do not regenerate / overwrite key; still invoke #17 boundary (at-least-once).
  if (invoice.pdfObjectKey) {
    await safeAfterReady(deps.afterInvoicePdfReady, invoiceId);
    return { status: "ready", pdfObjectKey: invoice.pdfObjectKey, claimed: false };
  }

  const order = await deps.prisma.order.findUnique({
    where: { id: invoice.orderId },
    include: { items: true },
  });
  if (!order) return { status: "skipped_missing" };

  const shipments = await deps.prisma.shipment.findMany({
    where: { orderId: order.id },
    select: { shippedAt: true },
  });

  const content = assembleInvoicePdfContent(invoice, order, shipments);
  const bytes = await buildInvoicePdfBuffer(content);
  const objectKey = invoicePdfObjectKey(invoice.id);

  await deps.storage.putPdfObject(objectKey, bytes);

  // Conditional claim — only NULL → key
  const claimed = await claimPdfObjectKey(deps.prisma, invoice.id, objectKey);

  if (claimed) {
    await safeAfterReady(deps.afterInvoicePdfReady, invoiceId);
    return { status: "ready", pdfObjectKey: objectKey, claimed: true };
  }

  // Loser of race or orphan-retry after another writer claimed: never overwrite winner key.
  const latest = await deps.prisma.invoice.findUnique({
    where: { id: invoice.id },
    select: { pdfObjectKey: true },
  });
  const key = latest?.pdfObjectKey ?? objectKey;
  if (latest?.pdfObjectKey) {
    await safeAfterReady(deps.afterInvoicePdfReady, invoiceId);
  }
  return { status: "ready", pdfObjectKey: key, claimed: false };
}

async function claimPdfObjectKey(
  prisma: PrismaLike,
  invoiceId: string,
  objectKey: string,
): Promise<boolean> {
  const result = await prisma.invoice.updateMany({
    where: { id: invoiceId, pdfObjectKey: null },
    data: { pdfObjectKey: objectKey },
  });
  return result.count === 1;
}

async function safeAfterReady(
  fn: AfterInvoicePdfReadyFn,
  invoiceId: string,
): Promise<void> {
  try {
    await fn(invoiceId);
  } catch {
    // Enqueue / hook failure must never clear pdfObjectKey or mutate Invoice.
  }
}

export function assembleInvoicePdfContent(
  invoice: {
    invoiceNumber: string;
    issuedAt: Date;
    sellerSnapshotJson: unknown;
    buyerSnapshotJson: unknown;
    exemptionTextSnapshot: string | null;
    grandTotalSnapshot: { toString(): string };
  },
  order: {
    orderNumber: string;
    locale: string;
    currencyCode: string;
    taxMode: TaxMode;
    companyIsKleinunternehmer: boolean;
    placedAt: Date;
    confirmedAt: Date | null;
    deliveredAt: Date | null;
    itemsSubtotal: { toString(): string };
    shippingTotal: { toString(): string };
    discountCoupon: { toString(): string };
    discountBonus: { toString(): string };
    bonusDiscountAmount: { toString(): string };
    couponCodeSnapshot: string | null;
    items: Array<{
      nameSnapshot: string;
      skuSnapshot: string;
      quantity: number;
      unitPriceSnapshot: { toString(): string };
      lineTotalSnapshot: { toString(): string };
      taxRateSnapshot: { toString(): string } | null;
    }>;
  },
  shipments: Array<{ shippedAt: Date | null }>,
): InvoicePdfContent {
  const seller = asRecord(invoice.sellerSnapshotJson);
  const buyer = asRecord(invoice.buyerSnapshotJson);
  const isKu =
    order.companyIsKleinunternehmer === true || order.taxMode === TaxMode.KLEINUNTERNEHMER;

  const leistungsdatum = resolveLeistungsdatumAsOfIssuedAt({
    issuedAt: invoice.issuedAt,
    placedAt: order.placedAt,
    confirmedAt: order.confirmedAt,
    orderDeliveredAt: order.deliveredAt,
    shipmentShippedAts: shipments.map((s) => s.shippedAt),
  });

  const discountBonus =
    Number(order.discountBonus.toString()) > 0
      ? formatInvoiceMoney(order.discountBonus)
      : formatInvoiceMoney(order.bonusDiscountAmount);

  return {
    documentLocale: resolveDocumentLocale(order.locale),
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt,
    leistungsdatum,
    orderNumber: order.orderNumber,
    currencyCode: order.currencyCode,
    isKleinunternehmer: isKu,
    exemptionText: invoice.exemptionTextSnapshot,
    seller: {
      legalName: str(seller.legalName),
      line1: str(seller.line1),
      postalCode: str(seller.postalCode),
      city: str(seller.city),
      countryCode: str(seller.countryCode),
      supportEmail: strOrNull(seller.supportEmail),
      supportPhone: strOrNull(seller.supportPhone),
      steuernummer: strOrNull(seller.steuernummer),
      vatId: strOrNull(seller.vatId),
      kleinunternehmerId: strOrNull(seller.kleinunternehmerId),
    },
    buyer: {
      name: str(buyer.name),
      line1: str(buyer.line1),
      line2: strOrNull(buyer.line2),
      postalCode: str(buyer.postalCode),
      city: str(buyer.city),
      countryCode: str(buyer.countryCode),
      phone: strOrNull(buyer.phone),
    },
    lines: order.items.map((it) => ({
      name: it.nameSnapshot,
      sku: it.skuSnapshot,
      quantity: it.quantity,
      unitPrice: formatInvoiceMoney(it.unitPriceSnapshot),
      lineTotal: formatInvoiceMoney(it.lineTotalSnapshot),
      taxRate:
        it.taxRateSnapshot == null ? null : formatInvoiceMoney(it.taxRateSnapshot),
    })),
    itemsSubtotal: formatInvoiceMoney(order.itemsSubtotal),
    shippingTotal: formatInvoiceMoney(order.shippingTotal),
    discountCoupon: formatInvoiceMoney(order.discountCoupon),
    discountBonus,
    couponCode: order.couponCodeSnapshot,
    grandTotal: formatInvoiceMoney(invoice.grandTotalSnapshot),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : null;
}
