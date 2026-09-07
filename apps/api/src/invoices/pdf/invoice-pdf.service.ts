import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { PostOrderEmailHooks } from "../../integrations/email/post-order-email.hooks";
import {
  INVOICE_PDF_QUEUE,
  type EnqueueInvoicePdfResult,
  type InvoicePdfQueuePort,
} from "./invoice-pdf.port";

export type EnsureInvoicePdfResult =
  | { status: "enqueued" }
  | { status: "already_queued" }
  | { status: "already_ready"; emailHook: string }
  | { status: "skipped_missing" }
  | { status: "skipped_not_issued" };

/**
 * Idempotent ensure path (10.11 §4a).
 * Enqueues generate when issued + pdfObjectKey NULL.
 * When already READY, re-invokes afterInvoicePdfReady for crash-before-email recovery.
 * Does not generate synchronously. Does not mutate financial fields.
 */
@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(INVOICE_PDF_QUEUE) private readonly queue: InvoicePdfQueuePort,
    private readonly postOrderEmail: PostOrderEmailHooks,
  ) {}

  async ensureInvoicePdf(invoiceId: string): Promise<EnsureInvoicePdfResult> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, status: true, pdfObjectKey: true },
    });
    if (!invoice) return { status: "skipped_missing" };
    if (invoice.status !== "issued" && invoice.status !== "cancelled_by_credit_note") {
      return { status: "skipped_not_issued" };
    }

    if (invoice.pdfObjectKey) {
      const emailHook = await this.postOrderEmail.afterInvoicePdfReady(invoiceId);
      return { status: "already_ready", emailHook: String(emailHook) };
    }

    const result: EnqueueInvoicePdfResult = await this.queue.enqueueGenerate(invoiceId);
    if (result === "already_ready") {
      const emailHook = await this.postOrderEmail.afterInvoicePdfReady(invoiceId);
      return { status: "already_ready", emailHook: String(emailHook) };
    }
    if (result === "already_queued") return { status: "already_queued" };
    return { status: "enqueued" };
  }

  /** Fire-and-forget helper after issueForOrder commit — never throws into issuance. */
  async enqueueAfterIssuance(invoiceId: string): Promise<void> {
    try {
      await this.ensureInvoicePdf(invoiceId);
    } catch (e) {
      this.logger.warn(
        `enqueueAfterIssuance failed invoiceId=${invoiceId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  async requireIssued(invoiceId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Invoice not found" });
    }
  }
}
