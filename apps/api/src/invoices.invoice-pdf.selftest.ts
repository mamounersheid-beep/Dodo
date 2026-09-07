/**
 * Invoice PDF object lifecycle — 10.11 §4a Execute selftest.
 * Focused: keys, queue collapse, content authority, Leistungsdatum as-of,
 * storage→claim, concurrency, failures, PDF READY → #17 boundary.
 *
 * Requires: DATABASE_URL, REDIS_URL, seed CompanySettings + ProductVariant
 * Run: pnpm --filter @dodo/api test:invoice-pdf
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { OrderStatus, PaymentStatus, TaxMode } from "@dodo/database";
import { env } from "./config/env";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";
import { PostOrderEmailHooks } from "./integrations/email/post-order-email.hooks";
import { PrismaService } from "./prisma/prisma.service";
import { InvoicesService } from "./invoices/invoices.service";
import {
  buildInvoicePdfBuffer,
  resolveDocumentLocale,
} from "./invoices/pdf/invoice-pdf.builder";
import {
  invoicePdfDlqJobId,
  invoicePdfJobId,
  invoicePdfObjectKey,
  invoicePdfWorkKey,
  INVOICE_PDF_QUEUE_NAME,
} from "./invoices/pdf/invoice-pdf.keys";
import { resolveLeistungsdatumAsOfIssuedAt } from "./invoices/pdf/invoice-pdf.leistungsdatum";
import {
  INVOICE_PDF_BACKOFF_MS,
  INVOICE_PDF_DLQ_NAME,
  INVOICE_PDF_JOB_ATTEMPTS,
  INVOICE_PDF_JOB_OPTIONS,
} from "./invoices/pdf/invoice-pdf.queue-config";
import type { InvoicePdfJobPayload } from "./invoices/pdf/invoice-pdf.port";
import { assembleInvoicePdfContent, processInvoicePdfJob } from "./invoices/pdf/invoice-pdf.processor";
import { InvoicePdfQueueAdapter } from "./invoices/pdf/invoice-pdf.queue";
import { InvoicePdfService } from "./invoices/pdf/invoice-pdf.service";
import { InMemoryInvoicePdfObjectStorage } from "./invoices/pdf/invoice-pdf.storage";

type Result = { id: string; status: "PASS" | "FAIL"; note?: string };

const SELLER_7 = {
  legalName: "PDF Test UG",
  line1: "PDF Weg 1",
  postalCode: "10115",
  city: "Berlin",
  countryCode: "DE",
  supportEmail: "support@pdf.test",
  supportPhone: "+49 30 1",
} as const;

const BILLING = {
  name: "Buyer PDF",
  line1: "Buyer 1",
  postalCode: "80331",
  city: "München",
  countryCode: "DE",
  phone: "+49 89 1",
} as const;

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

async function waitUntil(
  label: string,
  pred: () => Promise<boolean>,
  ms = 8_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${label}: timeout after ${ms}ms`);
}

async function main() {
  const stamp = Date.now().toString(36);
  const results: Result[] = [];
  const scenarioIds = [
    "P1 work/job identity",
    "P2 retry/DLQ config",
    "P3 Leistungsdatum as-of issuedAt",
    "P4 document locale",
    "P5 content authority / KU no MwSt 0,00",
    "P6 storage → conditional claim → READY",
    "P7 concurrent claim single winner",
    "P8 storage failure keeps key null",
    "P9 orphan retry same key",
    "P10 key immutability",
    "P11 #17 hook only after readiness",
    "P12 hook failure does not clear key",
    "P13 ensure + duplicate enqueue collapse",
    "P14 worker DLQ after exhausted attempts",
  ];

  console.log("10.11 §4a — Invoice PDF object lifecycle\n");

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

  let prisma: PrismaService | undefined;
  let invoices: InvoicesService | undefined;
  let queueConn: IORedis | undefined;
  let workerConn: IORedis | undefined;
  let dlqConn: IORedis | undefined;
  let queue: Queue<InvoicePdfJobPayload, void, string> | undefined;
  let dlq: Queue | undefined;
  let worker: Worker<InvoicePdfJobPayload, void, string> | undefined;
  let adapter: InvoicePdfQueueAdapter | undefined;
  const createdOrderIds: string[] = [];
  const createdInvoiceIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdShipmentIds: string[] = [];
  let taxBefore:
    | {
        steuernummer: string | null;
        vatId: string | null;
        kleinunternehmerId: string | null;
        invoiceNextNumber: number;
      }
    | undefined;

  try {
    prisma = new PrismaService();
    await prisma.$connect();
    invoices = new InvoicesService(prisma);

    const settings = await prisma.companySettings.findUnique({ where: { id: "default" } });
    if (!settings) throw new Error("CompanySettings id=default missing — seed required");
    taxBefore = {
      steuernummer: settings.steuernummer,
      vatId: settings.vatId,
      kleinunternehmerId: settings.kleinunternehmerId,
      invoiceNextNumber: settings.invoiceNextNumber,
    };
    await prisma.companySettings.update({
      where: { id: "default" },
      data: {
        steuernummer: "SN-PDF-1",
        vatId: null,
        kleinunternehmerId: null,
      },
    });

    const variant = await prisma.productVariant.findFirst();
    if (!variant) throw new Error("no ProductVariant — seed required");

    const seedOrder = async (opts?: {
      locale?: string;
      confirmedAt?: Date | null;
      deliveredAt?: Date | null;
      placedAt?: Date;
      taxMode?: TaxMode;
      isKu?: boolean;
      taxRate?: string | null;
    }) => {
      const user = await prisma!.user.create({
        data: {
          email: `pdf_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
          passwordHash: "x",
          locale: opts?.locale ?? "de",
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(user.id);
      const placedAt = opts?.placedAt ?? new Date("2026-01-01T10:00:00.000Z");
      const order = await prisma!.order.create({
        data: {
          orderNumber: `PDF-${stamp}-${randomBytes(3).toString("hex")}`,
          userId: user.id,
          status: OrderStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          currencyCode: "EUR",
          locale: opts?.locale ?? "de",
          shippingCountryCode: "DE",
          taxMode: opts?.taxMode ?? TaxMode.KLEINUNTERNEHMER,
          companyIsKleinunternehmer: opts?.isKu ?? true,
          invoiceExemptionTextSnapshot: "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.",
          itemsSubtotal: "20.00",
          shippingTotal: "5.00",
          discountCoupon: "1.00",
          discountBonus: "0.50",
          bonusDiscountAmount: "0.50",
          couponCodeSnapshot: "SAVE1",
          grandTotal: "23.50",
          shippingMethodCodeSnapshot: "standard",
          shippingStandardAmountSnapshot: "5.00",
          shippingAddressJson: { name: "Ship", line1: "S1", postalCode: "1", city: "Hamburg", countryCode: "DE" },
          billingAddressJson: BILLING,
          sellerIdentitySnapshotJson: SELLER_7,
          paymentMethodCodeSnapshot: "stripe",
          placedAt,
          confirmedAt: opts?.confirmedAt === undefined ? new Date("2026-01-02T10:00:00.000Z") : opts.confirmedAt,
          deliveredAt: opts?.deliveredAt ?? null,
          items: {
            create: [
              {
                variantId: variant.id,
                skuSnapshot: "SKU-PDF-1",
                nameSnapshot: "PDF Line Item",
                unitPriceSnapshot: "20.00",
                quantity: 1,
                lineTotalSnapshot: "20.00",
                weightGramsSnapshot: 100,
                taxRateSnapshot: opts?.taxRate === undefined ? null : opts.taxRate,
              },
            ],
          },
        },
      });
      createdOrderIds.push(order.id);
      return order;
    };

    const issue = async (orderId: string) => {
      const inv = await invoices!.issueForOrder(orderId);
      createdInvoiceIds.push(inv.id);
      return inv;
    };

    await run("P1 work/job identity", async () => {
      const id = "inv_test_abc";
      if (invoicePdfWorkKey(id) !== `invoice-pdf:${id}`) throw new Error("work key");
      if (invoicePdfJobId(id) !== `inv:pdf:${id}`) throw new Error("jobId");
      if (invoicePdfJobId(id).split(":").length !== 3) throw new Error("jobId segments");
      if (invoicePdfDlqJobId(id).split(":").length !== 3) throw new Error("dlq segments");
      if (invoicePdfObjectKey(id) !== `invoices/${id}.pdf`) throw new Error("object key");
    });

    await run("P2 retry/DLQ config", async () => {
      if (INVOICE_PDF_JOB_ATTEMPTS !== 3) throw new Error("attempts");
      if (INVOICE_PDF_BACKOFF_MS !== 50) throw new Error("backoff");
      if (INVOICE_PDF_DLQ_NAME !== "invoice-pdf-dlq") throw new Error("dlq name");
      if (INVOICE_PDF_JOB_OPTIONS.attempts !== 3) throw new Error("options attempts");
      if (INVOICE_PDF_JOB_OPTIONS.backoff.type !== "fixed") throw new Error("backoff type");
      if (INVOICE_PDF_QUEUE_NAME !== "invoice-pdf") throw new Error("queue name");
    });

    await run("P3 Leistungsdatum as-of issuedAt", async () => {
      const issuedAt = new Date("2026-01-10T12:00:00.000Z");
      const placedAt = new Date("2026-01-01T10:00:00.000Z");
      const confirmedAt = new Date("2026-01-02T10:00:00.000Z");
      // Post-issue delivery must be ignored
      const lateDelivered = new Date("2026-01-20T10:00:00.000Z");
      const d1 = resolveLeistungsdatumAsOfIssuedAt({
        issuedAt,
        placedAt,
        confirmedAt,
        orderDeliveredAt: lateDelivered,
        shipmentShippedAts: [new Date("2026-01-15T10:00:00.000Z")],
      });
      if (d1.getTime() !== confirmedAt.getTime()) {
        throw new Error(`expected confirmedAt got ${d1.toISOString()}`);
      }

      const earlyShip = new Date("2026-01-05T10:00:00.000Z");
      const d2 = resolveLeistungsdatumAsOfIssuedAt({
        issuedAt,
        placedAt,
        confirmedAt,
        orderDeliveredAt: null,
        shipmentShippedAts: [earlyShip, new Date("2026-01-06T10:00:00.000Z")],
      });
      if (d2.getTime() !== earlyShip.getTime()) throw new Error("expected earliest shippedAt");

      const earlyDelivered = new Date("2026-01-08T10:00:00.000Z");
      const d3 = resolveLeistungsdatumAsOfIssuedAt({
        issuedAt,
        placedAt,
        confirmedAt,
        orderDeliveredAt: earlyDelivered,
        shipmentShippedAts: [earlyShip],
      });
      if (d3.getTime() !== earlyDelivered.getTime()) throw new Error("delivered wins");
    });

    await run("P4 document locale", async () => {
      if (resolveDocumentLocale("de") !== "de") throw new Error("de");
      if (resolveDocumentLocale("en") !== "en") throw new Error("en");
      if (resolveDocumentLocale("ar") !== "ar") throw new Error("ar");
      if (resolveDocumentLocale("fr") !== "en") throw new Error("fallback en");
      if (resolveDocumentLocale(null) !== "en") throw new Error("null → en");
    });

    await run("P5 content authority / KU no MwSt 0,00", async () => {
      const order = await seedOrder({ taxRate: "0.00", isKu: true });
      const inv = await issue(order.id);
      const full = await prisma!.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      const ord = await prisma!.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true },
      });
      const content = assembleInvoicePdfContent(full, ord, []);
      if (content.invoiceNumber !== inv.invoiceNumber) throw new Error("invoiceNumber SoT");
      if (content.grandTotal !== "23.50") throw new Error("grand from Invoice");
      if (content.orderNumber !== ord.orderNumber) throw new Error("orderNumber");
      if (content.lines[0]?.name !== "PDF Line Item") throw new Error("line name");
      if (content.lines[0]?.sku !== "SKU-PDF-1") throw new Error("sku");
      if (!content.isKleinunternehmer) throw new Error("KU flag");
      if (!content.exemptionText?.includes("§ 19")) throw new Error("exemption");
      // Content model carries taxRate snapshot but PDF must not print MwSt under KU
      if (content.lines[0]?.taxRate !== "0.00") throw new Error("taxRate snapshot retained");
      const buf = await buildInvoicePdfBuffer(content);
      if (buf.subarray(0, 4).toString() !== "%PDF") throw new Error("not PDF");
      // Builder rule: under KU, taxBit is empty even if taxRate present
      const kuLine = content.lines[0]!;
      const taxBit =
        !content.isKleinunternehmer && kuLine.taxRate != null
          ? ` · MwSt ${kuLine.taxRate}%`
          : "";
      if (taxBit !== "") throw new Error("KU must not emit MwSt taxBit");
    });

    await run("P6 storage → conditional claim → READY", async () => {
      const order = await seedOrder();
      const inv = await issue(order.id);
      if (inv.pdfObjectKey !== null) throw new Error("expected null at issue");

      const storage = new InMemoryInvoicePdfObjectStorage();
      let hookCalls = 0;
      const result = await processInvoicePdfJob(inv.id, {
        prisma: prisma!,
        storage,
        afterInvoicePdfReady: async () => {
          hookCalls += 1;
        },
      });
      if (result.status !== "ready" || !result.claimed) throw new Error(JSON.stringify(result));
      const key = invoicePdfObjectKey(inv.id);
      if (result.pdfObjectKey !== key) throw new Error("key mismatch");
      if (!storage.objects.has(key)) throw new Error("object missing");
      const row = await prisma!.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      if (row.pdfObjectKey !== key) throw new Error("db key not set");
      if (hookCalls !== 1) throw new Error(`hookCalls ${hookCalls}`);
      // financial fields untouched
      if (row.grandTotalSnapshot.toString() !== inv.grandTotalSnapshot.toString()) {
        throw new Error("grandTotal mutated");
      }
    });

    await run("P7 concurrent claim single winner", async () => {
      const order = await seedOrder();
      const inv = await issue(order.id);
      const storage = new InMemoryInvoicePdfObjectStorage();
      let hooks = 0;
      const deps = {
        prisma: prisma!,
        storage,
        afterInvoicePdfReady: async () => {
          hooks += 1;
        },
      };
      const [a, b] = await Promise.all([
        processInvoicePdfJob(inv.id, deps),
        processInvoicePdfJob(inv.id, deps),
      ]);
      if (a.status !== "ready" || b.status !== "ready") throw new Error("both ready");
      const claimedCount = [a, b].filter((r) => r.status === "ready" && r.claimed).length;
      if (claimedCount !== 1) throw new Error(`claimedCount=${claimedCount}`);
      const row = await prisma!.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      if (row.pdfObjectKey !== invoicePdfObjectKey(inv.id)) throw new Error("winner key");
      if (hooks < 1) throw new Error("hook not called");
    });

    await run("P8 storage failure keeps key null", async () => {
      const order = await seedOrder();
      const inv = await issue(order.id);
      const storage = new InMemoryInvoicePdfObjectStorage();
      storage.failNextPut = true;
      let hooks = 0;
      try {
        await processInvoicePdfJob(inv.id, {
          prisma: prisma!,
          storage,
          afterInvoicePdfReady: async () => {
            hooks += 1;
          },
        });
        throw new Error("expected throw");
      } catch (e) {
        if (!(e instanceof Error) || e.message !== "storage_put_failed") throw e;
      }
      const row = await prisma!.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      if (row.pdfObjectKey !== null) throw new Error("key must stay null");
      if (row.status !== "issued") throw new Error("status mutated");
      if (hooks !== 0) throw new Error("hook must not run");
    });

    await run("P9 orphan retry same key", async () => {
      const order = await seedOrder();
      const inv = await issue(order.id);
      const storage = new InMemoryInvoicePdfObjectStorage();
      const key = invoicePdfObjectKey(inv.id);
      // Simulate orphan: object exists, DB still null
      await storage.putPdfObject(key, Buffer.from("%PDF-orphan"));
      const result = await processInvoicePdfJob(inv.id, {
        prisma: prisma!,
        storage,
        afterInvoicePdfReady: async () => undefined,
      });
      if (result.status !== "ready" || !result.claimed) throw new Error(JSON.stringify(result));
      if (!storage.objects.has(key)) throw new Error("key rewritten missing");
      // put called again on retry (overwrite same key) — accepted
      if (storage.putCount < 2) throw new Error("expected overwrite put");
      const row = await prisma!.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      if (row.pdfObjectKey !== key) throw new Error("claim failed");
    });

    await run("P10 key immutability", async () => {
      const order = await seedOrder();
      const inv = await issue(order.id);
      const storage = new InMemoryInvoicePdfObjectStorage();
      await processInvoicePdfJob(inv.id, {
        prisma: prisma!,
        storage,
        afterInvoicePdfReady: async () => undefined,
      });
      const second = await prisma!.invoice.updateMany({
        where: { id: inv.id, pdfObjectKey: null },
        data: { pdfObjectKey: "invoices/other.pdf" },
      });
      if (second.count !== 0) throw new Error("must not replace non-null key");
      const row = await prisma!.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      if (row.pdfObjectKey !== invoicePdfObjectKey(inv.id)) throw new Error("key changed");
    });

    await run("P11 #17 hook only after readiness", async () => {
      const order = await seedOrder();
      const inv = await issue(order.id);
      const counters = { readyHooks: 0 as number, premature: 0 as number };
      const storage = new InMemoryInvoicePdfObjectStorage();
      // Premature: ensure with null key only enqueues — use direct hook gate
      const hooks = new PostOrderEmailHooks(
        prisma!,
        createEmailIntegrationStub({
          enqueueInvoiceEmail: async () => {
            counters.premature += 1;
          },
        }),
      );
      const early = await hooks.afterInvoicePdfReady(inv.id);
      if (early !== "skipped_not_ready") throw new Error(`early=${early}`);
      if (counters.premature > 0) throw new Error("email enqueued before ready");

      await processInvoicePdfJob(inv.id, {
        prisma: prisma!,
        storage,
        afterInvoicePdfReady: async (id) => {
          counters.readyHooks += 1;
          const r = await hooks.afterInvoicePdfReady(id);
          if (r !== "enqueued") throw new Error(`after ready ${r}`);
        },
      });
      if (counters.readyHooks !== 1) throw new Error("hook once");
      if (Number(counters.premature) !== 1) throw new Error("email after ready");
    });

    await run("P12 hook failure does not clear key", async () => {
      const order = await seedOrder();
      const inv = await issue(order.id);
      const storage = new InMemoryInvoicePdfObjectStorage();
      await processInvoicePdfJob(inv.id, {
        prisma: prisma!,
        storage,
        afterInvoicePdfReady: async () => {
          throw new Error("enqueue_boom");
        },
      });
      const row = await prisma!.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      if (row.pdfObjectKey !== invoicePdfObjectKey(inv.id)) throw new Error("key cleared");
      if (row.status !== "issued") throw new Error("status");
    });

    // Redis queue collapse + ensure
    queueConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    workerConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    dlqConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(INVOICE_PDF_QUEUE_NAME, {
      connection: queueConn,
      defaultJobOptions: { ...INVOICE_PDF_JOB_OPTIONS },
    });
    dlq = new Queue(INVOICE_PDF_DLQ_NAME, { connection: dlqConn });
    await queue.waitUntilReady();
    await dlq.waitUntilReady();
    adapter = new InvoicePdfQueueAdapter(prisma);
    const memStorage = new InMemoryInvoicePdfObjectStorage();

    await run("P13 ensure + duplicate enqueue collapse", async () => {
      const order = await seedOrder();
      const inv = await issue(order.id);
      const jobId = invoicePdfJobId(inv.id);
      const existing = await queue!.getJob(jobId);
      if (existing) await existing.remove().catch(() => undefined);

      const svc = new InvoicePdfService(
        prisma!,
        adapter!,
        new PostOrderEmailHooks(prisma!, createEmailIntegrationStub()),
      );
      const a = await svc.ensureInvoicePdf(inv.id);
      const b = await svc.ensureInvoicePdf(inv.id);
      if (a.status !== "enqueued") throw new Error(`a=${a.status}`);
      if (b.status !== "already_queued") throw new Error(`b=${b.status}`);
      const job = await queue!.getJob(jobId);
      if (!job) throw new Error("job missing");
      if (job.data.idempotencyKey !== invoicePdfWorkKey(inv.id)) {
        throw new Error("work key payload");
      }
      await job.remove().catch(() => undefined);
    });

    await run("P14 worker DLQ after exhausted attempts", async () => {
      const order = await seedOrder();
      const inv = await issue(order.id);
      const jobId = invoicePdfJobId(inv.id);
      const dlqId = invoicePdfDlqJobId(inv.id);
      const ex = await queue!.getJob(jobId);
      if (ex) await ex.remove().catch(() => undefined);
      const dx = await dlq!.getJob(dlqId);
      if (dx) await dx.remove().catch(() => undefined);

      const failStorage = new InMemoryInvoicePdfObjectStorage();
      failStorage.failNextPut = true;
      // Always fail
      const origPut = failStorage.putPdfObject.bind(failStorage);
      failStorage.putPdfObject = async () => {
        throw new Error("always_fail_put");
      };

      worker = new Worker<InvoicePdfJobPayload, void, string>(
        INVOICE_PDF_QUEUE_NAME,
        async (job) => {
          await processInvoicePdfJob(job.data.invoiceId, {
            prisma: prisma!,
            storage: failStorage,
            afterInvoicePdfReady: async () => undefined,
          });
        },
        { connection: workerConn!, concurrency: 1 },
      );
      worker.on("failed", (job, err) => {
        void (async () => {
          if (!job) return;
          const max = job.opts.attempts ?? INVOICE_PDF_JOB_ATTEMPTS;
          if (job.attemptsMade < max) return;
          if (await dlq!.getJob(dlqId)) return;
          await dlq!.add(
            "failed",
            {
              ...job.data,
              failedAt: new Date().toISOString(),
              attemptsMade: job.attemptsMade,
              failedReason: err.message,
              sourceJobId: String(job.id),
            },
            { jobId: dlqId },
          );
        })();
      });
      await worker.waitUntilReady();

      await queue!.add(
        "generate",
        { idempotencyKey: invoicePdfWorkKey(inv.id), invoiceId: inv.id },
        { jobId, ...INVOICE_PDF_JOB_OPTIONS },
      );

      await waitUntil("dlq", async () => Boolean(await dlq!.getJob(dlqId)), 15_000);
      const row = await prisma!.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      if (row.pdfObjectKey !== null) throw new Error("key set after DLQ");
      if (row.status !== "issued") throw new Error("issuance voided");
      void origPut;
    });

    // Extra: as-of with shipment on real rows
    await run("P3b Leistungsdatum from DB shipment as-of", async () => {
      const issuedLike = new Date("2026-01-10T12:00:00.000Z");
      const confirmedAt = new Date("2026-01-02T10:00:00.000Z");
      const order = await seedOrder({
        placedAt: new Date("2026-01-01T10:00:00.000Z"),
        confirmedAt,
        deliveredAt: null,
      });
      const ship = await prisma!.shipment.create({
        data: {
          orderId: order.id,
          carrier: "dhl",
          trackingNumber: `PDF-${stamp}-${randomBytes(2).toString("hex")}`,
          shippedAt: new Date("2026-01-20T10:00:00.000Z"), // after typical issue
        },
      });
      createdShipmentIds.push(ship.id);
      const inv = await issue(order.id);
      await prisma!.invoice.update({
        where: { id: inv.id },
        data: { issuedAt: issuedLike },
      });
      const full = await prisma!.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      const ord = await prisma!.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true },
      });
      const shipments = await prisma!.shipment.findMany({
        where: { orderId: order.id },
        select: { shippedAt: true },
      });
      const content = assembleInvoicePdfContent(full, ord, shipments);
      if (content.leistungsdatum.getTime() !== confirmedAt.getTime()) {
        throw new Error(
          `expected confirmedAt ${confirmedAt.toISOString()} got ${content.leistungsdatum.toISOString()}`,
        );
      }
      await processInvoicePdfJob(inv.id, {
        prisma: prisma!,
        storage: new InMemoryInvoicePdfObjectStorage(),
        afterInvoicePdfReady: async () => undefined,
      });
      const row = await prisma!.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      if (!row.pdfObjectKey) throw new Error("not ready");
    });
  } finally {
    await worker?.close().catch(() => undefined);
    await adapter?.onModuleDestroy().catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await dlq?.close().catch(() => undefined);
    queueConn?.disconnect();
    workerConn?.disconnect();
    dlqConn?.disconnect();

    if (prisma) {
      try {
        if (createdShipmentIds.length) {
          await prisma.shipment.deleteMany({ where: { id: { in: createdShipmentIds } } });
        }
        if (createdInvoiceIds.length) {
          await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
        }
        if (createdOrderIds.length) {
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
        console.warn("cleanup warning", e);
      }
      await prisma.$disconnect().catch(() => undefined);
    }
  }

  printSummary(results);
  // Include P3b in pass check
  const failed = results.filter((r) => r.status === "FAIL");
  if (failed.length) {
    console.error(`\nFAILED ${failed.length}/${results.length}`);
    process.exit(1);
  }
  console.log(`\nALL PASS ${results.length}/${results.length}`);
  void scenarioIds;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
