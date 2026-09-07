import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { InvoiceError } from "./invoice.errors";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./pdf/invoice-pdf.service";

/**
 * Production boundary: after 10.9 PAID+CONFIRMED+sale commit → issue Invoice → PDF enqueue.
 * SoT: docs/10.11 §1 · §4a.
 * Never throws to the settlement caller — must not undo Payment/Order settlement.
 */
@Injectable()
export class InvoiceAfterSaleOrchestrator {
  private readonly logger = new Logger(InvoiceAfterSaleOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly invoicePdf: InvoicePdfService,
  ) {}

  /**
   * Call only after durable settlement commit (outside Prisma Tx).
   * Sequence: issueForOrder (if needed) → enqueueAfterIssuance.
   */
  async afterConfirmedSaleCommitted(orderId: string): Promise<void> {
    try {
      const invoiceId = await this.ensureInvoiceIssued(orderId);
      if (!invoiceId) return;
      await this.invoicePdf.enqueueAfterIssuance(invoiceId);
    } catch (e) {
      this.logger.warn(
        `afterConfirmedSaleCommitted failed orderId=${orderId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private async ensureInvoiceIssued(orderId: string): Promise<string | null> {
    const existing = await this.prisma.invoice.findFirst({
      where: { orderId },
      select: { id: true },
    });
    if (existing) return existing.id;

    try {
      const inv = await this.invoices.issueForOrder(orderId);
      return inv.id;
    } catch (e) {
      if (isInvoiceAlreadyExists(e)) {
        const again = await this.prisma.invoice.findFirst({
          where: { orderId },
          select: { id: true },
        });
        return again?.id ?? null;
      }
      this.logger.warn(
        `issueForOrder failed orderId=${orderId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  }
}

function isInvoiceAlreadyExists(e: unknown): boolean {
  if (!(e instanceof ConflictException)) return false;
  const body = e.getResponse();
  if (typeof body === "object" && body && "error" in body) {
    return (body as { error: string }).error === InvoiceError.INVOICE_ALREADY_EXISTS;
  }
  return false;
}
