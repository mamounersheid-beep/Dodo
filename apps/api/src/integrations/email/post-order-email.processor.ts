import { OrderStatus, RefundStatus } from "@dodo/database";
import { env } from "../../config/env";
import type { PrismaService } from "../../prisma/prisma.service";
import type {
  EmailJobPayload,
  EnqueueDeliveryEmailInput,
  EnqueueInvoiceEmailInput,
  EnqueueRefundEmailInput,
  EnqueueReturnRequestEmailInput,
  EnqueueShipmentEmailInput,
} from "./email-integration.port";
import { resolveOrderCommunicationLocale } from "./email-integration.port";
import {
  buildDeliveryEmail,
  buildInvoiceEmail,
  buildRefundEmail,
  buildReturnRequestEmail,
  buildShipmentEmail,
} from "./post-order-email.builder";
import type { RedisOrderEmailDeliveryStore } from "./order-email-delivery.store";
import type { SmtpTransport } from "./smtp-transport.port";

export type PostOrderProcessResult = "sent" | "skipped";

/**
 * #17 post-order email processor (10.10 §4).
 * Marks delivered only after SMTP success. Never mutates domain entities.
 * Invoice path: PDF download link only — SmtpMailMessage has no attachments.
 */
export async function processPostOrderEmailJob(
  payload: EmailJobPayload,
  deps: {
    prisma: PrismaService;
    transport: SmtpTransport;
    delivery: RedisOrderEmailDeliveryStore;
  },
): Promise<PostOrderProcessResult> {
  if (await deps.delivery.wasDelivered(payload.idempotencyKey)) {
    return "skipped";
  }

  let subject: string;
  let text: string;
  let locale: string;
  let orderId: string;
  let metaExtra: Record<string, string> = {};

  if (payload.template === "shipment") {
    const p = payload as EnqueueShipmentEmailInput;
    const shipment = await deps.prisma.shipment.findUnique({ where: { id: p.shipmentId } });
    if (!shipment) throw new Error(`shipment email: shipment not found ${p.shipmentId}`);
    const order = await deps.prisma.order.findUnique({
      where: { id: shipment.orderId },
      include: { items: true },
    });
    if (!order) throw new Error(`shipment email: order not found ${shipment.orderId}`);
    const built = buildShipmentEmail({
      order,
      shipment,
      guestAccessToken: p.guestAccessToken,
    });
    subject = built.subject;
    text = built.text;
    locale = built.communicationLocale;
    orderId = order.id;
  } else if (payload.template === "invoice") {
    const p = payload as EnqueueInvoiceEmailInput;
    const invoice = await deps.prisma.invoice.findUnique({ where: { id: p.invoiceId } });
    if (!invoice) throw new Error(`invoice email: invoice not found ${p.invoiceId}`);
    if (!invoice.pdfObjectKey) {
      throw new Error(`invoice email: pdfObjectKey missing — refuse send ${p.invoiceId}`);
    }
    const order = await deps.prisma.order.findUnique({ where: { id: invoice.orderId } });
    if (!order) throw new Error(`invoice email: order not found ${invoice.orderId}`);
    const built = buildInvoiceEmail({
      order,
      invoice: {
        invoiceNumber: invoice.invoiceNumber,
        issuedAt: invoice.issuedAt,
        grandTotalSnapshot: invoice.grandTotalSnapshot,
        exemptionTextSnapshot: invoice.exemptionTextSnapshot,
        pdfObjectKey: invoice.pdfObjectKey,
      },
    });
    if (!built.pdfDownloadPath) {
      throw new Error("invoice email: pdf download path required");
    }
    // Link-only: SmtpMailMessage has no attachments; reject claims that PDF is attached.
    if (/\b(pdf\s+)?attach(ed|ment)\b/i.test(built.text) || /\battached\s+pdf\b/i.test(built.text)) {
      throw new Error("invoice email: attachment wording forbidden");
    }
    subject = built.subject;
    text = built.text;
    locale = built.communicationLocale;
    orderId = order.id;
    metaExtra = { invoiceId: invoice.id, pdfObjectKey: invoice.pdfObjectKey };
  } else if (payload.template === "refund") {
    const p = payload as EnqueueRefundEmailInput;
    const refund = await deps.prisma.refund.findUnique({ where: { id: p.refundId } });
    if (!refund) throw new Error(`refund email: refund not found ${p.refundId}`);
    if (refund.status !== RefundStatus.SUCCEEDED) {
      throw new Error(`refund email: status ${refund.status} — only SUCCEEDED`);
    }
    const order = await deps.prisma.order.findUnique({ where: { id: refund.orderId } });
    if (!order) throw new Error(`refund email: order not found ${refund.orderId}`);
    const built = buildRefundEmail({
      order,
      refund,
      orderGrandTotal: order.grandTotal,
    });
    subject = built.subject;
    text = built.text;
    locale = built.communicationLocale;
    orderId = order.id;
    metaExtra = { refundId: refund.id };
  } else if (payload.template === "delivery") {
    const p = payload as EnqueueDeliveryEmailInput;
    const order = await deps.prisma.order.findUnique({ where: { id: p.orderId } });
    if (!order) throw new Error(`delivery email: order not found ${p.orderId}`);
    if (order.status !== OrderStatus.DELIVERED) {
      throw new Error(`delivery email: order status ${order.status}`);
    }
    const shipment = await deps.prisma.shipment.findFirst({
      where: { orderId: order.id, deliveredAt: { not: null } },
      orderBy: { deliveredAt: "desc" },
    });
    const deliveredAt = shipment?.deliveredAt;
    if (!deliveredAt) throw new Error(`delivery email: deliveredAt missing for ${order.id}`);
    const built = buildDeliveryEmail({
      order: { ...order, widerrufDeadlineAt: order.widerrufDeadlineAt },
      deliveredAt,
      guestAccessToken: p.guestAccessToken,
    });
    subject = built.subject;
    text = built.text;
    locale = built.communicationLocale;
    orderId = order.id;
  } else if (payload.template === "return_request") {
    const p = payload as EnqueueReturnRequestEmailInput;
    const rr = await deps.prisma.returnRequest.findUnique({
      where: { id: p.returnRequestId },
    });
    if (!rr) throw new Error(`return-request email: not found ${p.returnRequestId}`);
    const order = await deps.prisma.order.findUnique({ where: { id: rr.orderId } });
    if (!order) throw new Error(`return-request email: order not found ${rr.orderId}`);
    const built = buildReturnRequestEmail({
      order,
      returnRequest: rr,
      guestAccessToken: p.guestAccessToken,
    });
    subject = built.subject;
    text = built.text;
    locale = built.communicationLocale;
    orderId = order.id;
    metaExtra = { returnRequestId: rr.id };
  } else {
    throw new Error(`post-order email: unexpected template`);
  }

  if (locale !== resolveOrderCommunicationLocale(locale)) {
    throw new Error("post-order email: locale resolve mismatch");
  }

  // SmtpMailMessage has no attachments field — invoice is link-only by construction.
  await deps.transport.sendMail({
    from: env.EMAIL_FROM,
    to: payload.to,
    subject,
    text,
    meta: {
      template: payload.template,
      idempotencyKey: payload.idempotencyKey,
      communicationLocale: locale,
      orderId,
      ...metaExtra,
    },
  });

  await deps.delivery.markDelivered(payload.idempotencyKey);
  return "sent";
}
