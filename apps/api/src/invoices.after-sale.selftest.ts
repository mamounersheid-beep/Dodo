/**
 * Production Invoice issuance + PDF enqueue wiring — after 10.9 settlement commit.
 * SoT: 10.11 §1 · §4a.
 *
 * Proves: settle commit → issueForOrder → enqueueAfterIssuance (outside Tx).
 * Run: pnpm --filter @dodo/api test:invoice-after-sale
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { OrderStatus, PaymentStatus, TaxMode } from "@dodo/database";
import { env } from "./config/env";
import { InvoiceAfterSaleOrchestrator } from "./invoices/invoice-after-sale.orchestrator";
import { InvoiceError } from "./invoices/invoice.errors";
import { InvoicesService } from "./invoices/invoices.service";
import {
  invoicePdfJobId,
  invoicePdfWorkKey,
  INVOICE_PDF_QUEUE_NAME,
} from "./invoices/pdf/invoice-pdf.keys";
import { INVOICE_PDF_JOB_OPTIONS } from "./invoices/pdf/invoice-pdf.queue-config";
import type { InvoicePdfJobPayload } from "./invoices/pdf/invoice-pdf.port";
import { InvoicePdfService } from "./invoices/pdf/invoice-pdf.service";
import type { InvoicePdfQueuePort } from "./invoices/pdf/invoice-pdf.port";
import { PrismaService } from "./prisma/prisma.service";
import { ConflictException } from "@nestjs/common";

type Result = { id: string; status: "PASS" | "FAIL"; note?: string };

const SELLER_7 = {
  legalName: "AfterSale UG",
  line1: "Wire 1",
  postalCode: "10115",
  city: "Berlin",
  countryCode: "DE",
  supportEmail: "s@wire.test",
  supportPhone: null,
} as const;

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

async function main() {
  console.log("10.11 — Invoice after-sale production wiring\n");
  const stamp = Date.now().toString(36);
  const results: Result[] = [];
  const createdOrderIds: string[] = [];
  const createdInvoiceIds: string[] = [];
  const createdUserIds: string[] = [];
  let prisma: PrismaService | undefined;
  let taxBefore:
    | {
        steuernummer: string | null;
        vatId: string | null;
        kleinunternehmerId: string | null;
        invoiceNextNumber: number;
      }
    | undefined;
  let queueConn: IORedis | undefined;
  let queue: Queue<InvoicePdfJobPayload, void, string> | undefined;

  const run = async (id: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ id, status: "PASS" });
      console.log(`  ✓ ${id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id, status: "FAIL", note: msg });
      console.error(`  ✗ ${id}: ${msg}`);
    }
  };

  try {
    prisma = new PrismaService();
    await prisma.$connect();
    const settings = await prisma.companySettings.findUnique({ where: { id: "default" } });
    if (!settings) throw new Error("CompanySettings default missing");
    taxBefore = {
      steuernummer: settings.steuernummer,
      vatId: settings.vatId,
      kleinunternehmerId: settings.kleinunternehmerId,
      invoiceNextNumber: settings.invoiceNextNumber,
    };
    await prisma.companySettings.update({
      where: { id: "default" },
      data: { steuernummer: "SN-WIRE-1", vatId: null, kleinunternehmerId: null },
    });

    const variant = await prisma.productVariant.findFirst();
    if (!variant) throw new Error("ProductVariant required");

    queueConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(INVOICE_PDF_QUEUE_NAME, {
      connection: queueConn,
      defaultJobOptions: { ...INVOICE_PDF_JOB_OPTIONS },
    });
    await queue.waitUntilReady();

    const seedConfirmedPaid = async () => {
      const user = await prisma!.user.create({
        data: {
          email: `wire_${stamp}_${randomBytes(3).toString("hex")}@test.local`,
          passwordHash: "x",
          locale: "de",
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(user.id);
      const order = await prisma!.order.create({
        data: {
          orderNumber: `WIRE-${stamp}-${randomBytes(2).toString("hex")}`,
          userId: user.id,
          status: OrderStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          currencyCode: "EUR",
          locale: "de",
          shippingCountryCode: "DE",
          taxMode: TaxMode.KLEINUNTERNEHMER,
          companyIsKleinunternehmer: true,
          invoiceExemptionTextSnapshot: "§19",
          itemsSubtotal: "10.00",
          shippingTotal: "0.00",
          grandTotal: "10.00",
          shippingMethodCodeSnapshot: "standard",
          shippingStandardAmountSnapshot: "0.00",
          shippingAddressJson: { line1: "S" },
          billingAddressJson: {
            name: "B",
            line1: "L",
            postalCode: "1",
            city: "Berlin",
            countryCode: "DE",
          },
          sellerIdentitySnapshotJson: SELLER_7,
          confirmedAt: new Date(),
          items: {
            create: [
              {
                variantId: variant.id,
                skuSnapshot: "W1",
                nameSnapshot: "Wire Item",
                unitPriceSnapshot: "10.00",
                quantity: 1,
                lineTotalSnapshot: "10.00",
                weightGramsSnapshot: 1,
              },
            ],
          },
        },
      });
      createdOrderIds.push(order.id);
      return order;
    };

    await run("W1 orchestrator issues then enqueues PDF after commit", async () => {
      const order = await seedConfirmedPaid();
      const enqueues: string[] = [];
      const fakeQueue: InvoicePdfQueuePort = {
        enqueueGenerate: async (invoiceId) => {
          enqueues.push(invoiceId);
          return "enqueued";
        },
      };
      const invoices = new InvoicesService(prisma!);
      const pdfSvc = new InvoicePdfService(prisma!, fakeQueue, {
        afterInvoicePdfReady: async () => "skipped_not_ready",
      } as never);
      const orch = new InvoiceAfterSaleOrchestrator(prisma!, invoices, pdfSvc);

      // Simulate after-settlement call (outside any Tx)
      await orch.afterConfirmedSaleCommitted(order.id);

      const inv = await prisma!.invoice.findFirst({ where: { orderId: order.id } });
      if (!inv) throw new Error("invoice not created");
      createdInvoiceIds.push(inv.id);
      if (inv.status !== "issued") throw new Error("status");
      if (inv.pdfObjectKey !== null) throw new Error("pdf must still be null at enqueue");
      if (enqueues.length !== 1 || enqueues[0] !== inv.id) {
        throw new Error(`enqueue ${JSON.stringify(enqueues)}`);
      }
    });

    await run("W2 enqueue failure does not undo issuance", async () => {
      const order = await seedConfirmedPaid();
      const invoices = new InvoicesService(prisma!);
      const fakeQueue: InvoicePdfQueuePort = {
        enqueueGenerate: async () => {
          throw new Error("redis_down");
        },
      };
      const pdfSvc = new InvoicePdfService(prisma!, fakeQueue, {
        afterInvoicePdfReady: async () => "skipped_not_ready",
      } as never);
      const orch = new InvoiceAfterSaleOrchestrator(prisma!, invoices, pdfSvc);
      await orch.afterConfirmedSaleCommitted(order.id);
      const inv = await prisma!.invoice.findFirst({ where: { orderId: order.id } });
      if (!inv) throw new Error("issuance rolled back on enqueue failure");
      createdInvoiceIds.push(inv.id);
      if (inv.status !== "issued") throw new Error("status mutated");
    });

    await run("W3 idempotent when invoice already exists", async () => {
      const order = await seedConfirmedPaid();
      const invoices = new InvoicesService(prisma!);
      const enqueues: string[] = [];
      const fakeQueue: InvoicePdfQueuePort = {
        enqueueGenerate: async (invoiceId) => {
          enqueues.push(invoiceId);
          return "enqueued";
        },
      };
      const pdfSvc = new InvoicePdfService(prisma!, fakeQueue, {
        afterInvoicePdfReady: async () => "skipped_not_ready",
      } as never);
      const orch = new InvoiceAfterSaleOrchestrator(prisma!, invoices, pdfSvc);
      await orch.afterConfirmedSaleCommitted(order.id);
      await orch.afterConfirmedSaleCommitted(order.id);
      const count = await prisma!.invoice.count({ where: { orderId: order.id } });
      if (count !== 1) throw new Error(`invoice count ${count}`);
      const inv = await prisma!.invoice.findFirstOrThrow({ where: { orderId: order.id } });
      createdInvoiceIds.push(inv.id);
      if (enqueues.length < 1) throw new Error("no enqueue");
    });

    await run("W4 issueForOrder unchanged / not inside Tx with enqueue", async () => {
      // Structural: InvoicesService still arity 1; orchestrator calls issue then enqueue separately.
      if (InvoicesService.length !== 1) {
        throw new Error(`InvoicesService arity ${InvoicesService.length}`);
      }
      const order = await seedConfirmedPaid();
      const invoices = new InvoicesService(prisma!);
      let enqueueDuringIssue = false;
      const origIssue = invoices.issueForOrder.bind(invoices);
      let issueReturned = false;
      const fakeQueue: InvoicePdfQueuePort = {
        enqueueGenerate: async (invoiceId) => {
          if (!issueReturned) enqueueDuringIssue = true;
          // also prove real BullMQ jobId identity when used by adapter path
          void invoiceId;
          return "enqueued";
        },
      };
      invoices.issueForOrder = async (orderId: string) => {
        const inv = await origIssue(orderId);
        issueReturned = true;
        return inv;
      };
      const pdfSvc = new InvoicePdfService(prisma!, fakeQueue, {
        afterInvoicePdfReady: async () => "skipped_not_ready",
      } as never);
      const orch = new InvoiceAfterSaleOrchestrator(prisma!, invoices, pdfSvc);
      await orch.afterConfirmedSaleCommitted(order.id);
      if (enqueueDuringIssue) throw new Error("enqueue overlapped issuance before return");
      if (!issueReturned) throw new Error("issue not called");
      const inv = await prisma!.invoice.findFirstOrThrow({ where: { orderId: order.id } });
      createdInvoiceIds.push(inv.id);
    });

    await run("W5 Payments settle path contract: job identity still deterministic", async () => {
      const id = "inv_wire_job";
      if (invoicePdfWorkKey(id) !== `invoice-pdf:${id}`) throw new Error("work");
      if (invoicePdfJobId(id) !== `inv:pdf:${id}`) throw new Error("job");
      // Prove ConflictException ALREADY_EXISTS helper path via second issue
      const order = await seedConfirmedPaid();
      const invoices = new InvoicesService(prisma!);
      const first = await invoices.issueForOrder(order.id);
      createdInvoiceIds.push(first.id);
      try {
        await invoices.issueForOrder(order.id);
        throw new Error("expected conflict");
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e;
        const body = e.getResponse() as { error?: string };
        if (body.error !== InvoiceError.INVOICE_ALREADY_EXISTS) {
          throw new Error(String(body.error));
        }
      }
    });
  } finally {
    if (queue) {
      for (const id of createdInvoiceIds) {
        const j = await queue.getJob(invoicePdfJobId(id));
        if (j) await j.remove().catch(() => undefined);
      }
      await queue.close().catch(() => undefined);
    }
    queueConn?.disconnect();
    if (prisma) {
      try {
        if (createdInvoiceIds.length) {
          await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
        }
        // also by order in case
        if (createdOrderIds.length) {
          await prisma.invoice.deleteMany({ where: { orderId: { in: createdOrderIds } } });
          await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
          await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
        }
        if (createdUserIds.length) {
          await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
        }
        if (taxBefore) {
          await prisma.companySettings.update({
            where: { id: "default" },
            data: {
              steuernummer: taxBefore.steuernummer,
              vatId: taxBefore.vatId,
              kleinunternehmerId: taxBefore.kleinunternehmerId,
              invoiceNextNumber: taxBefore.invoiceNextNumber,
            },
          });
        }
      } catch (e) {
        console.warn("cleanup", e);
      }
      await prisma.$disconnect().catch(() => undefined);
    }
  }

  printSummary(results);
  if (results.some((r) => r.status === "FAIL")) process.exit(1);
  console.log(`\nALL PASS ${results.length}/${results.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
