import { Injectable, Logger, Optional, Inject } from "@nestjs/common";
import { OrderStatus, RefundStatus } from "@dodo/database";
import { PrismaService } from "../../prisma/prisma.service";
import {
  EMAIL_INTEGRATION,
  type EmailIntegrationPort,
  resolveOrderCommunicationLocale,
} from "./email-integration.port";

export type PostOrderEnqueueResult =
  | "enqueued"
  | "skipped_missing"
  | "skipped_not_ready"
  | "skipped_no_recipient"
  | "enqueue_failed";

/**
 * Domain → #17 email integration boundary (10.10 §4).
 * Owns readiness gates only — does not create Shipment / Invoice PDF / Return / DELIVERED.
 * Call after owning domain transaction commits.
 */
@Injectable()
export class PostOrderEmailHooks {
  private readonly logger = new Logger(PostOrderEmailHooks.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(EMAIL_INTEGRATION) private readonly email?: EmailIntegrationPort,
  ) {}

  /** Live producer: Refund SUCCEEDED (W3 / markRefundSucceeded). */
  async afterRefundSucceeded(refundId: string): Promise<PostOrderEnqueueResult> {
    if (!this.email) return "skipped_not_ready";
    try {
      const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
      if (!refund) return "skipped_missing";
      if (refund.status !== RefundStatus.SUCCEEDED) return "skipped_not_ready";
      const order = await this.prisma.order.findUnique({ where: { id: refund.orderId } });
      if (!order) return "skipped_missing";
      const to = await this.resolveRecipient(order);
      if (!to) return "skipped_no_recipient";
      await this.email.enqueueRefundEmail({
        refundId: refund.id,
        orderId: order.id,
        to,
        communicationLocale: resolveOrderCommunicationLocale(order.locale),
      });
      return "enqueued";
    } catch (e) {
      this.logger.warn(
        `refund email enqueue failed refundId=${refundId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return "enqueue_failed";
    }
  }

  /**
   * Integration boundary for Invoice PDF-ready.
   * Refuses when pdfObjectKey is null — does not generate PDF.
   */
  async afterInvoicePdfReady(invoiceId: string): Promise<PostOrderEnqueueResult> {
    if (!this.email) return "skipped_not_ready";
    try {
      const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) return "skipped_missing";
      if (!invoice.pdfObjectKey) return "skipped_not_ready";
      const order = await this.prisma.order.findUnique({ where: { id: invoice.orderId } });
      if (!order) return "skipped_missing";
      const to = await this.resolveRecipient(order);
      if (!to) return "skipped_no_recipient";
      await this.email.enqueueInvoiceEmail({
        invoiceId: invoice.id,
        orderId: order.id,
        to,
        communicationLocale: resolveOrderCommunicationLocale(order.locale),
      });
      return "enqueued";
    } catch (e) {
      this.logger.warn(
        `invoice email enqueue failed invoiceId=${invoiceId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return "enqueue_failed";
    }
  }

  /** Integration boundary — requires shippedAt; does not create shipments. */
  async afterShipmentShipped(
    shipmentId: string,
    guestAccessToken?: string,
  ): Promise<PostOrderEnqueueResult> {
    if (!this.email) return "skipped_not_ready";
    try {
      const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
      if (!shipment) return "skipped_missing";
      if (!shipment.shippedAt) return "skipped_not_ready";
      const order = await this.prisma.order.findUnique({ where: { id: shipment.orderId } });
      if (!order) return "skipped_missing";
      const to = await this.resolveRecipient(order);
      if (!to) return "skipped_no_recipient";
      await this.email.enqueueShipmentEmail({
        shipmentId: shipment.id,
        orderId: order.id,
        to,
        communicationLocale: resolveOrderCommunicationLocale(order.locale),
        guestAccessToken,
      });
      return "enqueued";
    } catch (e) {
      this.logger.warn(
        `shipment email enqueue failed shipmentId=${shipmentId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return "enqueue_failed";
    }
  }

  /** Integration boundary — Order DELIVERED + shipment.deliveredAt. */
  async afterOrderDelivered(
    orderId: string,
    guestAccessToken?: string,
  ): Promise<PostOrderEnqueueResult> {
    if (!this.email) return "skipped_not_ready";
    try {
      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return "skipped_missing";
      if (order.status !== OrderStatus.DELIVERED) return "skipped_not_ready";
      const shipped = await this.prisma.shipment.findFirst({
        where: { orderId, deliveredAt: { not: null } },
      });
      if (!shipped?.deliveredAt) return "skipped_not_ready";
      const to = await this.resolveRecipient(order);
      if (!to) return "skipped_no_recipient";
      await this.email.enqueueDeliveryEmail({
        orderId: order.id,
        to,
        communicationLocale: resolveOrderCommunicationLocale(order.locale),
        guestAccessToken,
      });
      return "enqueued";
    } catch (e) {
      this.logger.warn(
        `delivery email enqueue failed orderId=${orderId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return "enqueue_failed";
    }
  }

  /** Integration boundary — after ReturnRequest create commit. */
  async afterReturnRequestCreated(
    returnRequestId: string,
    guestAccessToken?: string,
  ): Promise<PostOrderEnqueueResult> {
    if (!this.email) return "skipped_not_ready";
    try {
      const rr = await this.prisma.returnRequest.findUnique({
        where: { id: returnRequestId },
      });
      if (!rr) return "skipped_missing";
      const order = await this.prisma.order.findUnique({ where: { id: rr.orderId } });
      if (!order) return "skipped_missing";
      const to =
        (await this.resolveRecipient(order)) ??
        (rr.guestEmail?.trim() ? rr.guestEmail.trim() : null);
      if (!to) return "skipped_no_recipient";
      await this.email.enqueueReturnRequestEmail({
        returnRequestId: rr.id,
        orderId: order.id,
        to,
        communicationLocale: resolveOrderCommunicationLocale(
          rr.returnLocale || order.locale,
        ),
        guestAccessToken,
      });
      return "enqueued";
    } catch (e) {
      this.logger.warn(
        `return-request email enqueue failed id=${returnRequestId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return "enqueue_failed";
    }
  }

  private async resolveRecipient(order: {
    userId: string | null;
    guestEmail: string | null;
  }): Promise<string | null> {
    if (order.userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: order.userId },
        select: { email: true },
      });
      return user?.email?.trim() || null;
    }
    return order.guestEmail?.trim() || null;
  }
}
