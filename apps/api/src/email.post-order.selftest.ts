/**
 * 10.10 §4 — #17 Post-order transactional emails (Execute harness).
 *
 * Requires: REDIS_URL + DATABASE_URL (+ seed MAIN)
 * Run (after build): node dist/email.post-order.selftest.js
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import {
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
  ReturnRequestStatus,
  ReturnType,
  TaxMode,
} from "@dodo/database";
import { env } from "./config/env";
import {
  AUTH_EMAIL_DLQ_NAME,
  AUTH_EMAIL_JOB_ATTEMPTS,
  AUTH_EMAIL_JOB_OPTIONS,
  refundEmailDlqJobId,
} from "./integrations/email/auth-email.queue-config";
import {
  AUTH_EMAIL_QUEUE_NAME,
  deliveryEmailJobId,
  deliveryEmailWorkKey,
  invoiceEmailJobId,
  invoiceEmailWorkKey,
  isPostOrderEmailPayload,
  refundEmailJobId,
  refundEmailWorkKey,
  resolveOrderCommunicationLocale,
  returnRequestEmailJobId,
  returnRequestEmailWorkKey,
  shipmentEmailJobId,
  shipmentEmailWorkKey,
  type EmailJobPayload,
} from "./integrations/email/email-integration.port";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";
import { PostOrderEmailHooks } from "./integrations/email/post-order-email.hooks";
import { processPostOrderEmailJob } from "./integrations/email/post-order-email.processor";
import { RedisOrderEmailDeliveryStore } from "./integrations/email/order-email-delivery.store";
import { QueuedEmailAdapter } from "./integrations/email/queued-email.adapter";
import type { SmtpMailMessage, SmtpTransport } from "./integrations/email/smtp-transport.port";
import { InventoryService } from "./inventory/inventory.service";
import { PayPalFirstAttemptAdapter } from "./payments/paypal.first-attempt.adapter";
import { PaymentsService } from "./payments/payments.service";
import { StripeFirstAttemptAdapter } from "./payments/stripe.first-attempt.adapter";
import { PrismaService } from "./prisma/prisma.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

class RecordingSmtpTransport implements SmtpTransport {
  readonly messages: SmtpMailMessage[] = [];
  failuresBeforeSuccess = 0;
  alwaysFail = false;
  callCount = 0;

  async sendMail(message: SmtpMailMessage): Promise<void> {
    this.callCount += 1;
    if (this.alwaysFail || this.failuresBeforeSuccess > 0) {
      if (this.failuresBeforeSuccess > 0) this.failuresBeforeSuccess -= 1;
      throw new Error("forced SMTP failure");
    }
    this.messages.push({ ...message, meta: { ...message.meta } });
  }

  reset(): void {
    this.messages.length = 0;
    this.callCount = 0;
    this.failuresBeforeSuccess = 0;
    this.alwaysFail = false;
  }
}

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(
  label: string,
  fn: () => boolean | Promise<boolean>,
  ms = 20_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error(`${label}: timeout after ${ms}ms`);
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const scenarioIds = [
    "PO1 work keys / jobIds",
    "PO2 refund enqueue + SMTP + delivery mark",
    "PO3 replay skips duplicate SMTP",
    "PO4 SMTP failure no mark / no Refund mutation",
    "PO5 retry then success",
    "PO6 invoice link-only / no attachment field",
    "PO7 invoice without pdfObjectKey not ready",
    "PO8 shipment/delivery/return gates refuse missing producer",
    "PO9 Order.locale → communicationLocale",
    "PO10 markRefundSucceeded after-commit enqueue",
    "PO11 no fake emails when upstream absent",
  ];

  console.log("10.10 — #17 Post-order transactional emails\n");

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

  let queueConn: IORedis | undefined;
  let workerConn: IORedis | undefined;
  let storeConn: IORedis | undefined;
  let dlqConn: IORedis | undefined;
  let queue: Queue<EmailJobPayload, void, string> | undefined;
  let dlq: Queue | undefined;
  let worker: Worker<EmailJobPayload, void, string> | undefined;
  let adapter: QueuedEmailAdapter | undefined;
  let prisma: PrismaService | undefined;
  const transport = new RecordingSmtpTransport();
  const createdOrderIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdRefundIds: string[] = [];
  const createdInvoiceIds: string[] = [];
  const createdShipmentIds: string[] = [];
  const createdReturnIds: string[] = [];
  const jobIds: string[] = [];

  try {
    prisma = new PrismaService();
    await prisma.$connect();

    const company = await prisma.companySettings.findUnique({ where: { id: "default" } });
    if (!company) throw new Error("CompanySettings default missing — seed required");

    let paymentMethod = await prisma.paymentMethod.findFirst({
      where: { code: "stripe", isEnabled: true },
    });
    if (!paymentMethod) {
      paymentMethod = await prisma.paymentMethod.findFirst({ where: { isEnabled: true } });
    }
    if (!paymentMethod) throw new Error("no PaymentMethod — seed required");

    const variant = await prisma.productVariant.findFirst();
    if (!variant) throw new Error("no ProductVariant — seed required");

    queueConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    workerConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    storeConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    dlqConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const delivery = new RedisOrderEmailDeliveryStore(storeConn);

    queue = new Queue(AUTH_EMAIL_QUEUE_NAME, {
      connection: queueConn,
      defaultJobOptions: { ...AUTH_EMAIL_JOB_OPTIONS },
    });
    dlq = new Queue(AUTH_EMAIL_DLQ_NAME, { connection: dlqConn });
    await queue.waitUntilReady();
    await dlq.waitUntilReady();

    worker = new Worker<EmailJobPayload, void, string>(
      AUTH_EMAIL_QUEUE_NAME,
      async (job) => {
        if (!isPostOrderEmailPayload(job.data)) {
          throw new Error(`unexpected non-post-order job: ${job.data.template}`);
        }
        await processPostOrderEmailJob(job.data, {
          prisma: prisma!,
          transport,
          delivery,
        });
      },
      { connection: workerConn, concurrency: 1 },
    );
    worker.on("failed", (job, err) => {
      void (async () => {
        if (!job || !isPostOrderEmailPayload(job.data)) return;
        const max = job.opts.attempts ?? AUTH_EMAIL_JOB_ATTEMPTS;
        if (job.attemptsMade < max) return;
        if (job.data.template !== "refund") return;
        const dlqId = refundEmailDlqJobId(job.data.refundId);
        if (await dlq!.getJob(dlqId)) return;
        await dlq!.add(
          "dead",
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
    adapter = new QueuedEmailAdapter();

    const cleanJob = async (jobId: string, workKey: string, dlqId?: string) => {
      await delivery.clearDelivered(workKey);
      const j = await queue!.getJob(jobId);
      if (j) await j.remove().catch(() => undefined);
      if (dlqId) {
        const d = await dlq!.getJob(dlqId);
        if (d) await d.remove().catch(() => undefined);
      }
    };

    const seedUser = async (locale: string) => {
      const email = `po17_${stamp}_${randomBytes(4).toString("hex")}@example.com`;
      const user = await prisma!.user.create({
        data: {
          email,
          passwordHash: "x",
          locale,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(user.id);
      return user;
    };

    const seedPaidOrder = async (userId: string, locale: string) => {
      const order = await prisma!.order.create({
        data: {
          orderNumber: `PO17-${stamp}-${randomBytes(3).toString("hex")}`,
          userId,
          status: OrderStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PAID,
          currencyCode: "EUR",
          locale,
          shippingCountryCode: "DE",
          taxMode: TaxMode.KLEINUNTERNEHMER,
          companyIsKleinunternehmer: true,
          invoiceExemptionTextSnapshot: "§19 UStG",
          itemsSubtotal: "40.00",
          shippingTotal: "0.00",
          discountCoupon: "0.00",
          discountBonus: "0.00",
          grandTotal: "40.00",
          shippingMethodCodeSnapshot: "standard",
          shippingStandardAmountSnapshot: "0.00",
          shippingAddressJson: { line1: "PO17" },
          billingAddressJson: { line1: "PO17" },
          sellerIdentitySnapshotJson: {
            legalName: "PO17 UG",
            line1: "Test 1",
            postalCode: "10115",
            city: "Berlin",
            countryCode: "DE",
          },
          paymentMethodCodeSnapshot: "stripe",
          confirmedAt: new Date(),
          items: {
            create: [
              {
                variantId: variant!.id,
                skuSnapshot: "SKU-PO17",
                nameSnapshot: "PO17 Item",
                unitPriceSnapshot: "40.00",
                quantity: 1,
                lineTotalSnapshot: "40.00",
                weightGramsSnapshot: 100,
              },
            ],
          },
        },
        include: { items: true },
      });
      createdOrderIds.push(order.id);
      const payment = await prisma!.payment.create({
        data: {
          orderId: order.id,
          paymentMethodId: paymentMethod!.id,
          provider: "stripe",
          providerIntentId: `pi_po17_${order.id}`,
          amount: new Prisma.Decimal("40.00"),
          currencyCode: "EUR",
          status: PaymentStatus.PAID,
        },
      });
      return { order, payment };
    };

    await run("PO1 work keys / jobIds", async () => {
      const id = "abc123";
      if (shipmentEmailWorkKey(id) !== `shipment:${id}`) throw new Error("shipment work key");
      if (shipmentEmailJobId(id) !== `ord:ship:${id}`) throw new Error("shipment jobId");
      if (invoiceEmailWorkKey(id) !== `invoice:${id}`) throw new Error("invoice work key");
      if (invoiceEmailJobId(id) !== `ord:inv:${id}`) throw new Error("invoice jobId");
      if (refundEmailWorkKey(id) !== `refund:${id}`) throw new Error("refund work key");
      if (refundEmailJobId(id) !== `ord:refund:${id}`) throw new Error("refund jobId");
      if (deliveryEmailWorkKey(id) !== `delivery:${id}`) throw new Error("delivery work key");
      if (deliveryEmailJobId(id) !== `ord:deliver:${id}`) throw new Error("delivery jobId");
      if (returnRequestEmailWorkKey(id) !== `return-request:${id}`) {
        throw new Error("return-request work key");
      }
      if (returnRequestEmailJobId(id) !== `ord:retreq:${id}`) {
        throw new Error("return-request jobId");
      }
      for (const jid of [
        shipmentEmailJobId(id),
        invoiceEmailJobId(id),
        refundEmailJobId(id),
        deliveryEmailJobId(id),
        returnRequestEmailJobId(id),
      ]) {
        if (jid.split(":").length !== 3) throw new Error(`jobId segments ${jid}`);
      }
    });

    await run("PO2 refund enqueue + SMTP + delivery mark", async () => {
      transport.reset();
      const user = await seedUser("de");
      const { order, payment } = await seedPaidOrder(user.id, "de");
      const refund = await prisma!.refund.create({
        data: {
          orderId: order.id,
          paymentId: payment.id,
          amount: new Prisma.Decimal("40.00"),
          currencyCode: "EUR",
          status: RefundStatus.SUCCEEDED,
          reason: "po17",
          refundTotal: new Prisma.Decimal("40.00"),
          completedAt: new Date(),
        },
      });
      createdRefundIds.push(refund.id);
      const workKey = refundEmailWorkKey(refund.id);
      const jobId = refundEmailJobId(refund.id);
      jobIds.push(jobId);
      await cleanJob(jobId, workKey, refundEmailDlqJobId(refund.id));

      await adapter!.enqueueRefundEmail({
        refundId: refund.id,
        orderId: order.id,
        to: user.email,
        communicationLocale: "de",
      });
      await waitUntil("PO2 smtp", () => transport.messages.length >= 1);
      const msg = transport.messages[0]!;
      if (msg.meta.template !== "refund") throw new Error("template");
      if (msg.meta.idempotencyKey !== workKey) throw new Error("work key meta");
      if (!msg.subject.includes("Erstattung")) throw new Error("DE subject");
      if (!(await delivery.wasDelivered(workKey))) throw new Error("delivery mark missing");
      if ("attachments" in msg) throw new Error("attachments must not exist on SmtpMailMessage");
    });

    await run("PO3 replay skips duplicate SMTP", async () => {
      transport.reset();
      const user = await seedUser("en");
      const { order, payment } = await seedPaidOrder(user.id, "en");
      const refund = await prisma!.refund.create({
        data: {
          orderId: order.id,
          paymentId: payment.id,
          amount: new Prisma.Decimal("10.00"),
          currencyCode: "EUR",
          status: RefundStatus.SUCCEEDED,
          reason: "po17-replay",
          refundTotal: new Prisma.Decimal("10.00"),
          completedAt: new Date(),
        },
      });
      createdRefundIds.push(refund.id);
      const workKey = refundEmailWorkKey(refund.id);
      const jobId = refundEmailJobId(refund.id);
      await cleanJob(jobId, workKey);

      const payload = {
        idempotencyKey: workKey,
        to: user.email,
        template: "refund" as const,
        refundId: refund.id,
        orderId: order.id,
        communicationLocale: resolveOrderCommunicationLocale(order.locale),
      };
      const r1 = await processPostOrderEmailJob(payload, {
        prisma: prisma!,
        transport,
        delivery,
      });
      const r2 = await processPostOrderEmailJob(payload, {
        prisma: prisma!,
        transport,
        delivery,
      });
      if (r1 !== "sent" || r2 !== "skipped") throw new Error(`results ${r1}/${r2}`);
      if (transport.callCount !== 1) throw new Error(`smtp calls ${transport.callCount}`);
    });

    await run("PO4 SMTP failure no mark / no Refund mutation", async () => {
      transport.reset();
      transport.alwaysFail = true;
      const user = await seedUser("de");
      const { order, payment } = await seedPaidOrder(user.id, "de");
      const refund = await prisma!.refund.create({
        data: {
          orderId: order.id,
          paymentId: payment.id,
          amount: new Prisma.Decimal("5.00"),
          currencyCode: "EUR",
          status: RefundStatus.SUCCEEDED,
          reason: "po17-fail",
          refundTotal: new Prisma.Decimal("5.00"),
          completedAt: new Date(),
        },
      });
      createdRefundIds.push(refund.id);
      const workKey = refundEmailWorkKey(refund.id);
      await delivery.clearDelivered(workKey);
      const before = await prisma!.refund.findUniqueOrThrow({ where: { id: refund.id } });
      try {
        await processPostOrderEmailJob(
          {
            idempotencyKey: workKey,
            to: user.email,
            template: "refund",
            refundId: refund.id,
            orderId: order.id,
            communicationLocale: "de",
          },
          { prisma: prisma!, transport, delivery },
        );
        throw new Error("expected SMTP throw");
      } catch (e) {
        if (!(e instanceof Error) || !/forced SMTP/.test(e.message)) throw e;
      }
      if (await delivery.wasDelivered(workKey)) throw new Error("mark set on failure");
      const after = await prisma!.refund.findUniqueOrThrow({ where: { id: refund.id } });
      if (after.status !== before.status) throw new Error("Refund status mutated");
      if (String(after.amount) !== String(before.amount)) throw new Error("Refund amount mutated");
      transport.alwaysFail = false;
    });

    await run("PO5 retry then success", async () => {
      transport.reset();
      transport.failuresBeforeSuccess = 1;
      const user = await seedUser("de");
      const { order, payment } = await seedPaidOrder(user.id, "de");
      const refund = await prisma!.refund.create({
        data: {
          orderId: order.id,
          paymentId: payment.id,
          amount: new Prisma.Decimal("8.00"),
          currencyCode: "EUR",
          status: RefundStatus.SUCCEEDED,
          reason: "po17-retry",
          refundTotal: new Prisma.Decimal("8.00"),
          completedAt: new Date(),
        },
      });
      createdRefundIds.push(refund.id);
      const workKey = refundEmailWorkKey(refund.id);
      const jobId = refundEmailJobId(refund.id);
      await cleanJob(jobId, workKey, refundEmailDlqJobId(refund.id));

      await adapter!.enqueueRefundEmail({
        refundId: refund.id,
        orderId: order.id,
        to: user.email,
        communicationLocale: "de",
      });
      await waitUntil("PO5 smtp", () => transport.messages.length >= 1, 25_000);
      if (transport.callCount < 2) throw new Error(`expected retry smtp calls got ${transport.callCount}`);
      if (!(await delivery.wasDelivered(workKey))) throw new Error("mark after retry");
    });

    await run("PO6 invoice link-only / no attachment field", async () => {
      transport.reset();
      const user = await seedUser("de");
      const { order } = await seedPaidOrder(user.id, "de");
      const invoice = await prisma!.invoice.create({
        data: {
          orderId: order.id,
          invoiceNumber: `INV-PO17-${stamp}-${randomBytes(2).toString("hex")}`,
          grandTotalSnapshot: "40.00",
          exemptionTextSnapshot: "§19 UStG",
          pdfObjectKey: `invoices/po17/${order.id}.pdf`,
          buyerSnapshotJson: { name: "Buyer" },
          sellerSnapshotJson: { legalName: "Seller" },
          status: "issued",
        },
      });
      createdInvoiceIds.push(invoice.id);
      const workKey = invoiceEmailWorkKey(invoice.id);
      await delivery.clearDelivered(workKey);

      const result = await processPostOrderEmailJob(
        {
          idempotencyKey: workKey,
          to: user.email,
          template: "invoice",
          invoiceId: invoice.id,
          orderId: order.id,
          communicationLocale: "de",
        },
        { prisma: prisma!, transport, delivery },
      );
      if (result !== "sent") throw new Error(result);
      const msg = transport.messages[0]!;
      if (!msg.text.includes(`/v1/invoices/${encodeURIComponent(invoice.invoiceNumber)}/pdf`)) {
        throw new Error("missing PDF download path");
      }
      if (/\battached\b/i.test(msg.text) || /\bas an attachment\b/i.test(msg.text)) {
        throw new Error("attachment claim in body");
      }
      if ("attachments" in msg) throw new Error("must not attach PDF");
      if (msg.meta.pdfObjectKey !== invoice.pdfObjectKey) throw new Error("pdfObjectKey meta");
    });

    await run("PO7 invoice without pdfObjectKey not ready", async () => {
      const user = await seedUser("de");
      const { order } = await seedPaidOrder(user.id, "de");
      const invoice = await prisma!.invoice.create({
        data: {
          orderId: order.id,
          invoiceNumber: `INV-NOPDF-${stamp}-${randomBytes(2).toString("hex")}`,
          grandTotalSnapshot: "40.00",
          exemptionTextSnapshot: null,
          pdfObjectKey: null,
          buyerSnapshotJson: {},
          sellerSnapshotJson: {},
          status: "issued",
        },
      });
      createdInvoiceIds.push(invoice.id);
      const email = createEmailIntegrationStub({
        enqueueInvoiceEmail: async () => {
          throw new Error("must not enqueue");
        },
      });
      const hooks = new PostOrderEmailHooks(prisma!, email);
      const out = await hooks.afterInvoicePdfReady(invoice.id);
      if (out !== "skipped_not_ready") throw new Error(`got ${out}`);
    });

    await run("PO8 shipment/delivery/return gates refuse missing producer", async () => {
      const user = await seedUser("de");
      const { order } = await seedPaidOrder(user.id, "de");
      let enqueues = 0;
      const email = createEmailIntegrationStub({
        enqueueShipmentEmail: async () => {
          enqueues += 1;
        },
        enqueueDeliveryEmail: async () => {
          enqueues += 1;
        },
        enqueueReturnRequestEmail: async () => {
          enqueues += 1;
        },
      });
      const hooks = new PostOrderEmailHooks(prisma!, email);

      const ship = await prisma!.shipment.create({
        data: {
          orderId: order.id,
          carrier: "dhl",
          trackingNumber: `TN-${stamp}`,
          shippedAt: null,
        },
      });
      createdShipmentIds.push(ship.id);
      if ((await hooks.afterShipmentShipped(ship.id)) !== "skipped_not_ready") {
        throw new Error("shipment without shippedAt");
      }

      if ((await hooks.afterOrderDelivered(order.id)) !== "skipped_not_ready") {
        throw new Error("delivery without DELIVERED");
      }

      if ((await hooks.afterReturnRequestCreated("missing-rr-id")) !== "skipped_missing") {
        throw new Error("missing RR");
      }
      if (enqueues !== 0) throw new Error(`unexpected enqueues ${enqueues}`);
    });

    await run("PO9 Order.locale → communicationLocale", async () => {
      transport.reset();
      const user = await seedUser("ar");
      const { order, payment } = await seedPaidOrder(user.id, "ar");
      const refund = await prisma!.refund.create({
        data: {
          orderId: order.id,
          paymentId: payment.id,
          amount: new Prisma.Decimal("4.00"),
          currencyCode: "EUR",
          status: RefundStatus.SUCCEEDED,
          reason: "po17-locale",
          refundTotal: new Prisma.Decimal("4.00"),
          completedAt: new Date(),
        },
      });
      createdRefundIds.push(refund.id);
      const workKey = refundEmailWorkKey(refund.id);
      await delivery.clearDelivered(workKey);
      await processPostOrderEmailJob(
        {
          idempotencyKey: workKey,
          to: user.email,
          template: "refund",
          refundId: refund.id,
          orderId: order.id,
          communicationLocale: "en", // enqueue may pass en; processor uses Order.locale via builder
        },
        { prisma: prisma!, transport, delivery },
      );
      const msg = transport.messages[0]!;
      if (msg.meta.communicationLocale !== "ar") {
        throw new Error(`locale ${msg.meta.communicationLocale}`);
      }
      if (!msg.subject.includes("استرداد")) throw new Error("AR subject from Order.locale");
    });

    await run("PO10 markRefundSucceeded after-commit enqueue", async () => {
      transport.reset();
      const user = await seedUser("de");
      const { order, payment } = await seedPaidOrder(user.id, "de");
      const refund = await prisma!.refund.create({
        data: {
          orderId: order.id,
          paymentId: payment.id,
          amount: new Prisma.Decimal("12.00"),
          currencyCode: "EUR",
          status: RefundStatus.PENDING,
          reason: "po17-hook",
          refundTotal: new Prisma.Decimal("12.00"),
        },
      });
      createdRefundIds.push(refund.id);
      const workKey = refundEmailWorkKey(refund.id);
      const jobId = refundEmailJobId(refund.id);
      await cleanJob(jobId, workKey);

      const emailPort = adapter!;
      const hooks = new PostOrderEmailHooks(prisma!, emailPort);
      const payments = new PaymentsService(
        prisma!,
        new InventoryService(prisma!),
        new StripeFirstAttemptAdapter(),
        new PayPalFirstAttemptAdapter(),
        undefined,
        undefined,
        hooks,
      );
      const out = await payments.markRefundSucceeded(refund.id);
      if (out.status !== RefundStatus.SUCCEEDED) throw new Error(out.status);
      await waitUntil("PO10 smtp", () => transport.messages.length >= 1);
      const msg = transport.messages[0]!;
      if (msg.meta.template !== "refund") throw new Error("template");
      if (msg.meta.idempotencyKey !== workKey) throw new Error("work key");
      const persisted = await prisma!.refund.findUniqueOrThrow({ where: { id: refund.id } });
      if (persisted.status !== RefundStatus.SUCCEEDED) throw new Error("refund not SUCCEEDED");
    });

    await run("PO11 no fake emails when upstream absent", async () => {
      transport.reset();
      let calls = 0;
      const email = createEmailIntegrationStub({
        enqueueShipmentEmail: async () => {
          calls += 1;
        },
        enqueueInvoiceEmail: async () => {
          calls += 1;
        },
        enqueueDeliveryEmail: async () => {
          calls += 1;
        },
        enqueueReturnRequestEmail: async () => {
          calls += 1;
        },
      });
      const hooks = new PostOrderEmailHooks(prisma!, email);
      // No domain rows created for ship/invoice/delivery/return — hooks must not invent jobs.
      if ((await hooks.afterShipmentShipped("no-such-shipment")) !== "skipped_missing") {
        throw new Error("shipment");
      }
      if ((await hooks.afterInvoicePdfReady("no-such-invoice")) !== "skipped_missing") {
        throw new Error("invoice");
      }
      if ((await hooks.afterOrderDelivered("no-such-order")) !== "skipped_missing") {
        throw new Error("delivery");
      }
      if ((await hooks.afterReturnRequestCreated("no-such-rr")) !== "skipped_missing") {
        throw new Error("return");
      }
      if (calls !== 0) throw new Error(`fake enqueues ${calls}`);
      if (transport.messages.length !== 0) throw new Error("SMTP without producer");
      // ReturnRequest exists but REJECTED path is out of V1 — creating RR is not auto-emailed here
      // (owning domain must call afterReturnRequestCreated). Assert no auto side-effect from create alone:
      const user = await seedUser("de");
      const { order } = await seedPaidOrder(user.id, "de");
      const rr = await prisma!.returnRequest.create({
        data: {
          orderId: order.id,
          userId: user.id,
          type: ReturnType.WIDERRUF,
          status: ReturnRequestStatus.REQUESTED,
          orderPriorStatus: OrderStatus.DELIVERED,
          returnAddressSnapshotJson: { line1: "Return" },
          returnInstructionsSnapshot: "pack securely",
          returnLocale: "de",
          estimatedRefundTotal: "40.00",
        },
      });
      createdReturnIds.push(rr.id);
      if (calls !== 0) throw new Error("RR create must not auto-enqueue");
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`setup/fatal: ${msg}`);
    for (const id of scenarioIds) {
      if (!results.some((r) => r.id === id)) {
        results.push({ id, status: "BLOCKED", note: msg });
      }
    }
  } finally {
    await worker?.close().catch(() => undefined);
    await adapter?.onModuleDestroy().catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await dlq?.close().catch(() => undefined);
    queueConn?.disconnect();
    workerConn?.disconnect();
    storeConn?.disconnect();
    dlqConn?.disconnect();

    if (prisma) {
      for (const id of createdRefundIds) {
        await prisma.refund.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of createdInvoiceIds) {
        await prisma.invoice.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of createdShipmentIds) {
        await prisma.shipment.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of createdReturnIds) {
        await prisma.returnRequest.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of createdOrderIds) {
        await prisma.orderItem.deleteMany({ where: { orderId: id } }).catch(() => undefined);
        await prisma.payment.deleteMany({ where: { orderId: id } }).catch(() => undefined);
        await prisma.order.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of createdUserIds) {
        await prisma.user.delete({ where: { id } }).catch(() => undefined);
      }
      await prisma.$disconnect().catch(() => undefined);
    }
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
