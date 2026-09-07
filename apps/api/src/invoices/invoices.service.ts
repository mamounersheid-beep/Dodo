import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { OrderStatus, PaymentStatus, Prisma } from "@dodo/database";
import { RoleCode } from "@dodo/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthUser } from "../auth/auth.types";
import { InvoiceError } from "./invoice.errors";

const STAFF: RoleCode[] = [RoleCode.SUPPORT, RoleCode.ADMIN, RoleCode.OWNER];

const SELLER_IDENTITY_KEYS = [
  "legalName",
  "line1",
  "postalCode",
  "city",
  "countryCode",
  "supportEmail",
  "supportPhone",
] as const;

@Injectable()
export class InvoicesService {
  constructor(private readonly prisma: PrismaService) {}

  skeleton() {
    return { module: "invoices", ready: true, commerce: false };
  }

  /**
   * Invoice issuance persistence (10.11 §7b I-TID). Insert-only. No PDF / email / webhook.
   * Lock order: Order → CompanySettings.
   */
  async issueForOrder(orderId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
        const order = await tx.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            status: true,
            paymentStatus: true,
            grandTotal: true,
            invoiceExemptionTextSnapshot: true,
            sellerIdentitySnapshotJson: true,
            billingAddressJson: true,
          },
        });
        if (!order) {
          throw new NotFoundException({
            error: InvoiceError.ORDER_NOT_FOUND,
            message: "Order not found",
          });
        }
        if (order.status === OrderStatus.CANCELLED) {
          throw new ConflictException({
            error: InvoiceError.ORDER_CANCELLED,
            message: "Cancelled orders cannot be invoiced",
          });
        }
        if (
          order.status !== OrderStatus.CONFIRMED ||
          order.paymentStatus !== PaymentStatus.PAID
        ) {
          throw new ConflictException({
            error: InvoiceError.INVOICE_NOT_ELIGIBLE,
            message: "Invoice requires CONFIRMED and PAID",
          });
        }

        const existing = await tx.invoice.findFirst({
          where: { orderId: order.id },
          select: { id: true },
        });
        if (existing) {
          throw new ConflictException({
            error: InvoiceError.INVOICE_ALREADY_EXISTS,
            message: "Invoice already exists for this order",
          });
        }

        await tx.$queryRaw`SELECT "id" FROM "CompanySettings" WHERE "id" = 'default' FOR UPDATE`;
        const company = await tx.companySettings.findUnique({
          where: { id: "default" },
          select: {
            invoiceNextNumber: true,
            steuernummer: true,
            vatId: true,
            kleinunternehmerId: true,
          },
        });
        if (!company) {
          throw new ConflictException({
            error: InvoiceError.STORE_SETTINGS_MISSING,
            message: "CompanySettings not configured",
          });
        }

        const steuernummer = trimToNull(company.steuernummer);
        const vatId = trimToNull(company.vatId);
        const kleinunternehmerId = trimToNull(company.kleinunternehmerId);
        if (steuernummer === null && vatId === null && kleinunternehmerId === null) {
          throw new ConflictException({
            error: InvoiceError.TAX_ID_INCOMPLETE,
            message: "At least one issuer tax identifier is required",
          });
        }

        const issuedAt = new Date();
        const invoiceNumber = formatInvoiceNumber(company.invoiceNextNumber, issuedAt);
        await tx.companySettings.update({
          where: { id: "default" },
          data: { invoiceNextNumber: company.invoiceNextNumber + 1 },
        });

        const sellerSnapshotJson = {
          ...copySellerIdentity(order.sellerIdentitySnapshotJson),
          steuernummer,
          vatId,
          kleinunternehmerId,
        };

        return tx.invoice.create({
          data: {
            orderId: order.id,
            invoiceNumber,
            issuedAt,
            status: "issued",
            pdfObjectKey: null,
            grandTotalSnapshot: order.grandTotal,
            exemptionTextSnapshot: order.invoiceExemptionTextSnapshot,
            sellerSnapshotJson,
            buyerSnapshotJson: order.billingAddressJson as Prisma.InputJsonValue,
          },
        });
      },
      { timeout: 15_000, maxWait: 5_000 },
    );
  }

  /**
   * Invoice remains readable after user GDPR anonymize (GoBD / buyer snapshot).
   * Customer: own order only. Staff: any. Anonymized customers cannot auth — staff path covers acceptance.
   * Reads persisted Invoice JSON only — never live CompanySettings.
   */
  async getByNumber(invoiceNumber: string, user: AuthUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { invoiceNumber },
      include: {
        order: { select: { id: true, userId: true, orderNumber: true } },
      },
    });
    if (!invoice) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Invoice not found" });
    }

    const isStaff = user.roles.some((r) => STAFF.includes(r));
    if (!isStaff && invoice.order.userId !== user.id) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Invoice not found" });
    }

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      issuedAt: invoice.issuedAt,
      grandTotalSnapshot: invoice.grandTotalSnapshot.toString(),
      exemptionTextSnapshot: invoice.exemptionTextSnapshot,
      buyerSnapshotJson: invoice.buyerSnapshotJson,
      sellerSnapshotJson: invoice.sellerSnapshotJson,
      status: invoice.status,
      orderId: invoice.orderId,
      orderNumber: invoice.order.orderNumber,
      pdfObjectKey: invoice.pdfObjectKey,
    };
  }
}

function trimToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function formatInvoiceNumber(next: number, at: Date): string {
  const year = at.getUTCFullYear();
  return `RE-${year}-${String(next).padStart(6, "0")}`;
}

function copySellerIdentity(raw: Prisma.JsonValue): Record<(typeof SELLER_IDENTITY_KEYS)[number], string | null> {
  const rec =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    legalName: asString(rec.legalName),
    line1: asString(rec.line1),
    postalCode: asString(rec.postalCode),
    city: asString(rec.city),
    countryCode: asString(rec.countryCode),
    supportEmail: asStringOrNull(rec.supportEmail),
    supportPhone: asStringOrNull(rec.supportPhone),
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : null;
}
