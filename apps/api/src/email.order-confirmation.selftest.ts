/**
 * 10.10 — Order Confirmation Email Foundation (auto only) — test-only harness.
 *
 * Requires: REDIS_URL + DATABASE_URL (+ seeded CompanySettings + a ProductVariant)
 * Run (after build): node dist/email.order-confirmation.selftest.js
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { hashToken } from "./auth/crypto.util";
import { env } from "./config/env";
import {
  AUTH_EMAIL_DLQ_NAME,
  AUTH_EMAIL_JOB_ATTEMPTS,
  AUTH_EMAIL_JOB_OPTIONS,
  orderConfirmationDlqJobId,
} from "./integrations/email/auth-email.queue-config";
import {
  AUTH_EMAIL_QUEUE_NAME,
  type EmailJobPayload,
  type EnqueueOrderConfirmationInput,
  isOrderConfirmationPayload,
  orderConfirmationJobId,
  orderConfirmationWorkKey,
  resolveOrderCommunicationLocale,
} from "./integrations/email/email-integration.port";
import { processOrderConfirmationJob } from "./integrations/email/order-confirmation.processor";
import {
  orderConfirmationDeliveredRedisKey,
  RedisOrderEmailDeliveryStore,
} from "./integrations/email/order-email-delivery.store";
import { QueuedEmailAdapter } from "./integrations/email/queued-email.adapter";
import type { SmtpMailMessage, SmtpTransport } from "./integrations/email/smtp-transport.port";
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

function assertNoForbidden(text: string): void {
  const forbidden = [
    /\binvoice\b/i,
    /\bPAID\b/,
    /payment confirmation/i,
    /\bPAN\b/,
    /\bCVV\b/,
    /Lieferzeit/i,
    /estimated delivery/i,
  ];
  for (const re of forbidden) {
    if (re.test(text)) throw new Error(`forbidden content matched ${re}`);
  }
  if (!/paymentStatus=PENDING/.test(text)) {
    throw new Error("missing explicit paymentStatus=PENDING");
  }
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const scenarioIds = [
    "OC1 enqueue → process → SMTP",
    "OC2 Order.locale over User.locale",
    "OC3 snapshot-only line items",
    "OC4 PENDING wording / no forbidden",
    "OC5 idempotent delivered mark",
    "OC6 replay no duplicate SMTP",
    "OC7 SMTP failure no mark / no Order mutation",
    "OC8 retry then success",
    "OC9 exhaustion → DLQ",
    "OC10 guest order access link",
    "OC11 registered order access link",
    "OC12 Auth delivered keys remain separate",
    "OC13 seller snapshot ignores live CompanySettings",
  ];

  console.log("10.10 — Order Confirmation Email Foundation (auto only)\n");

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
  const jobIds: string[] = [];
  let variantIdForRestore: string | undefined;
  let variantPriceBefore: { toString(): string } | string | number | undefined;
  let companyMutated = false;
  let companyRestore:
    | {
        legalName: string;
        line1: string;
        postalCode: string;
        city: string;
        countryCode: string;
        supportEmail: string | null;
        supportPhone: string | null;
      }
    | undefined;

  try {
    prisma = new PrismaService();
    await prisma.$connect();

    const company = await prisma.companySettings.findUnique({ where: { id: "default" } });
    if (!company) throw new Error("CompanySettings default missing — seed required");
    companyRestore = {
      legalName: company.legalName,
      line1: company.line1,
      postalCode: company.postalCode,
      city: company.city,
      countryCode: company.countryCode,
      supportEmail: company.supportEmail,
      supportPhone: company.supportPhone,
    };
    const variant = await prisma.productVariant.findFirst();
    if (!variant) throw new Error("no ProductVariant — seed required");
    variantIdForRestore = variant.id;
    variantPriceBefore = variant.price;

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
        if (!isOrderConfirmationPayload(job.data)) {
          throw new Error(`unexpected non-order job in OC harness: ${job.data.template}`);
        }
        await processOrderConfirmationJob(job.data, {
          prisma: prisma!,
          transport,
          delivery,
        });
      },
      { connection: workerConn, concurrency: 1 },
    );
    worker.on("failed", (job, err) => {
      void (async () => {
        if (!job || !isOrderConfirmationPayload(job.data)) return;
        const max = job.opts.attempts ?? AUTH_EMAIL_JOB_ATTEMPTS;
        if (job.attemptsMade < max) return;
        const dlqId = orderConfirmationDlqJobId(job.data.orderId);
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

    const cleanOrderJob = async (orderId: string) => {
      const workKey = orderConfirmationWorkKey(orderId);
      const jobId = orderConfirmationJobId(orderId);
      await delivery.clearDelivered(workKey);
      const j = await queue!.getJob(jobId);
      if (j) await j.remove().catch(() => undefined);
      const d = await dlq!.getJob(orderConfirmationDlqJobId(orderId));
      if (d) await d.remove().catch(() => undefined);
    };

    const createRegisteredOrder = async (opts: {
      locale: string;
      userLocale: string;
      nameSnapshot: string;
      unitPrice: string;
    }) => {
      const email = `oc-reg-${stamp}-${randomBytes(4).toString("hex")}@order.invalid`;
      const user = await prisma!.user.create({
        data: {
          email,
          passwordHash: "not-used",
          locale: opts.userLocale,
        },
      });
      createdUserIds.push(user.id);
      const order = await prisma!.order.create({
        data: {
          orderNumber: `OC-R-${stamp}-${randomBytes(3).toString("hex")}`,
          userId: user.id,
          status: "PLACED",
          paymentStatus: "PENDING",
          currencyCode: "EUR",
          locale: opts.locale,
          shippingCountryCode: "DE",
          taxMode: "KLEINUNTERNEHMER",
          companyIsKleinunternehmer: true,
          invoiceExemptionTextSnapshot: "§19 UStG snapshot text",
          itemsSubtotal: opts.unitPrice,
          shippingTotal: "4.90",
          discountCoupon: "0",
          discountBonus: "0",
          grandTotal: String(Number(opts.unitPrice) + 4.9),
          shippingMethodCodeSnapshot: "standard",
          shippingStandardAmountSnapshot: "4.90",
          shippingAddressJson: { line1: "Ship Snap 1", city: "Berlin" },
          billingAddressJson: { line1: "Bill Snap 1", name: "Buyer Snap" },
          sellerIdentitySnapshotJson: {
            legalName: "OC Frozen Seller UG",
            line1: "Frozen Seller Str. 1",
            postalCode: "10115",
            city: "Berlin",
            countryCode: "DE",
            supportEmail: "seller-oc@example.com",
            supportPhone: "+49 30 000000",
          },
          legalAgbVersionId: "agb-v1",
          legalAgbHash: "hash-agb",
          legalWiderrufVersionId: "wid-v1",
          legalWiderrufHash: "hash-wid",
          legalPrivacyVersionId: "priv-v1",
          legalPrivacyHash: "hash-priv",
          items: {
            create: [
              {
                variantId: variant.id,
                skuSnapshot: "SNAP-SKU-REG",
                nameSnapshot: opts.nameSnapshot,
                quantity: 1,
                unitPriceSnapshot: opts.unitPrice,
                lineTotalSnapshot: opts.unitPrice,
                weightGramsSnapshot: 100,
              },
            ],
          },
        },
        include: { items: true },
      });
      createdOrderIds.push(order.id);
      return { user, order, email };
    };

    const createGuestOrder = async () => {
      const rawToken = randomBytes(32).toString("base64url");
      const guestEmail = `oc-guest-${stamp}@order.invalid`;
      const order = await prisma!.order.create({
        data: {
          orderNumber: `OC-G-${stamp}-${randomBytes(3).toString("hex")}`,
          guestEmail,
          guestAccessTokenHash: hashToken(rawToken),
          status: "PLACED",
          paymentStatus: "PENDING",
          currencyCode: "EUR",
          locale: "de",
          shippingCountryCode: "DE",
          taxMode: "KLEINUNTERNEHMER",
          companyIsKleinunternehmer: true,
          invoiceExemptionTextSnapshot: "§19 UStG guest snapshot",
          itemsSubtotal: "19.99",
          shippingTotal: "0",
          grandTotal: "19.99",
          shippingMethodCodeSnapshot: "standard",
          shippingStandardAmountSnapshot: "0",
          shippingAddressJson: { line1: "Guest Ship" },
          billingAddressJson: { line1: "Guest Bill" },
          sellerIdentitySnapshotJson: {
            legalName: "OC Frozen Seller UG",
            line1: "Frozen Seller Str. 1",
            postalCode: "10115",
            city: "Berlin",
            countryCode: "DE",
            supportEmail: "seller-oc@example.com",
            supportPhone: null,
          },
          legalAgbVersionId: "agb-g",
          legalPrivacyVersionId: "priv-g",
          legalWiderrufVersionId: "wid-g",
          items: {
            create: [
              {
                variantId: variant.id,
                skuSnapshot: "SNAP-SKU-GUEST",
                nameSnapshot: "Guest Snapshot Product",
                quantity: 1,
                unitPriceSnapshot: "19.99",
                lineTotalSnapshot: "19.99",
                weightGramsSnapshot: 50,
              },
            ],
          },
        },
      });
      createdOrderIds.push(order.id);
      return { order, guestEmail, rawToken };
    };

    // --- OC1 + OC2 + OC3 + OC4 + OC5 + OC11 ---
    const reg = await createRegisteredOrder({
      locale: "en",
      userLocale: "ar",
      nameSnapshot: "Frozen Snapshot Tee",
      unitPrice: "29.00",
    });
    await cleanOrderJob(reg.order.id);
    jobIds.push(orderConfirmationJobId(reg.order.id));

    // Mutate live catalog + user locale after order create — email must ignore these.
    await prisma.productVariant.update({
      where: { id: variant.id },
      data: { price: "999.00" },
    });
    await prisma.user.update({
      where: { id: reg.user.id },
      data: { locale: "ar" },
    });

    await run("OC1 enqueue → process → SMTP", async () => {
      transport.messages.length = 0;
      transport.callCount = 0;
      transport.alwaysFail = false;
      transport.failuresBeforeSuccess = 0;
      await adapter!.enqueueOrderConfirmation({
        orderId: reg.order.id,
        to: reg.email,
        communicationLocale: resolveOrderCommunicationLocale(reg.order.locale),
      });
      const jobId = orderConfirmationJobId(reg.order.id);
      await waitUntil("OC1 completed", async () => {
        const j = await queue!.getJob(jobId);
        return !!j && (await j.getState()) === "completed";
      });
      if (transport.messages.length !== 1) {
        throw new Error(`expected 1 SMTP message, got ${transport.messages.length}`);
      }
      const msg = transport.messages[0]!;
      if (msg.meta.template !== "order_confirmation") throw new Error("wrong template");
      if (msg.meta.orderId !== reg.order.id) throw new Error("orderId missing in meta");
      if (msg.meta.idempotencyKey !== orderConfirmationWorkKey(reg.order.id)) {
        throw new Error("work key mismatch");
      }
    });

    await run("OC2 Order.locale over User.locale", async () => {
      const msg = transport.messages[0]!;
      if (msg.meta.communicationLocale !== "en") {
        throw new Error(`expected Order.locale=en, got ${msg.meta.communicationLocale}`);
      }
      if (!msg.text.includes("communicationLocale=en")) {
        throw new Error("body missing communicationLocale=en");
      }
      if (msg.text.includes("communicationLocale=ar")) {
        throw new Error("body used User.locale=ar");
      }
      const u = await prisma!.user.findUniqueOrThrow({ where: { id: reg.user.id } });
      if (u.locale !== "ar") throw new Error("setup: User.locale should still be ar");
    });

    await run("OC3 snapshot-only line items", async () => {
      const msg = transport.messages[0]!;
      if (!msg.text.includes("Frozen Snapshot Tee")) throw new Error("missing nameSnapshot");
      if (!msg.text.includes("SNAP-SKU-REG")) throw new Error("missing skuSnapshot");
      if (!msg.text.includes("29.00")) throw new Error("missing unitPriceSnapshot");
      if (msg.text.includes("999.00")) throw new Error("live variant price leaked into email");
      if (!msg.text.includes("Ship Snap 1")) throw new Error("missing shipping snapshot");
      if (!msg.text.includes("Bill Snap 1")) throw new Error("missing billing snapshot");
      if (!msg.text.includes("§19 UStG snapshot text")) throw new Error("missing KU snapshot");
      if (!msg.text.includes("OC Frozen Seller UG")) throw new Error("missing Order seller snapshot");
      if (!msg.text.includes("Frozen Seller Str. 1")) throw new Error("missing seller address snapshot");
      if (msg.text.includes(company.legalName) && company.legalName !== "OC Frozen Seller UG") {
        throw new Error("live CompanySettings.legalName leaked into confirmation");
      }
    });

    await run("OC4 PENDING wording / no forbidden", async () => {
      assertNoForbidden(transport.messages[0]!.text);
    });

    await run("OC5 idempotent delivered mark", async () => {
      const key = orderConfirmationWorkKey(reg.order.id);
      if (!(await delivery.wasDelivered(key))) throw new Error("missing delivered mark");
      const redisKey = orderConfirmationDeliveredRedisKey(key);
      if (!redisKey.startsWith("order-email:delivered:")) {
        throw new Error("delivered key namespace wrong");
      }
    });

    await run("OC6 replay no duplicate SMTP", async () => {
      const before = transport.messages.length;
      const payload: EnqueueOrderConfirmationInput = {
        idempotencyKey: orderConfirmationWorkKey(reg.order.id),
        to: reg.email,
        template: "order_confirmation",
        orderId: reg.order.id,
        communicationLocale: "en",
      };
      const r = await processOrderConfirmationJob(payload, {
        prisma: prisma!,
        transport,
        delivery,
      });
      if (r !== "skipped") throw new Error(`expected skipped, got ${r}`);
      await adapter!.enqueueOrderConfirmation({
        orderId: reg.order.id,
        to: reg.email,
        communicationLocale: "en",
      });
      await sleep(200);
      if (transport.messages.length !== before) {
        throw new Error("replay/duplicate enqueue caused extra SMTP send");
      }
    });

    await run("OC11 registered order access link", async () => {
      const msg = transport.messages[0]!;
      const expected = `accessPath=/account/orders/${encodeURIComponent(reg.order.orderNumber)}`;
      if (!msg.text.includes(expected)) throw new Error(`missing ${expected}`);
      if (msg.text.includes("/order-tracking")) {
        throw new Error("registered order must not use guest tracking link");
      }
    });

    await run("OC7 SMTP failure no mark / no Order mutation", async () => {
      const failReg = await createRegisteredOrder({
        locale: "de",
        userLocale: "de",
        nameSnapshot: "Fail Snap",
        unitPrice: "11.00",
      });
      await cleanOrderJob(failReg.order.id);
      jobIds.push(orderConfirmationJobId(failReg.order.id));
      const before = JSON.stringify(
        await prisma!.order.findUniqueOrThrow({ where: { id: failReg.order.id } }),
      );
      const failTransport = new RecordingSmtpTransport();
      failTransport.alwaysFail = true;
      const payload: EnqueueOrderConfirmationInput = {
        idempotencyKey: orderConfirmationWorkKey(failReg.order.id),
        to: failReg.email,
        template: "order_confirmation",
        orderId: failReg.order.id,
        communicationLocale: "de",
      };
      let threw = false;
      try {
        await processOrderConfirmationJob(payload, {
          prisma: prisma!,
          transport: failTransport,
          delivery,
        });
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("expected SMTP failure");
      if (await delivery.wasDelivered(payload.idempotencyKey)) {
        throw new Error("delivered mark after SMTP failure");
      }
      const after = JSON.stringify(
        await prisma!.order.findUniqueOrThrow({ where: { id: failReg.order.id } }),
      );
      if (before !== after) throw new Error("Order mutated on SMTP failure");
      const u = await prisma!.user.findUniqueOrThrow({ where: { id: failReg.user.id } });
      if (u.email !== failReg.email) throw new Error("User mutated");
      if ((await prisma!.session.count({ where: { userId: failReg.user.id } })) !== 0) {
        throw new Error("sessions mutated");
      }
    });

    await run("OC8 retry then success", async () => {
      transport.messages.length = 0;
      transport.callCount = 0;
      transport.alwaysFail = false;
      transport.failuresBeforeSuccess = 2;
      const o = await createRegisteredOrder({
        locale: "de",
        userLocale: "en",
        nameSnapshot: "Retry Snap",
        unitPrice: "5.00",
      });
      await cleanOrderJob(o.order.id);
      jobIds.push(orderConfirmationJobId(o.order.id));
      await adapter!.enqueueOrderConfirmation({
        orderId: o.order.id,
        to: o.email,
        communicationLocale: "de",
      });
      await waitUntil("OC8 completed", async () => {
        const j = await queue!.getJob(orderConfirmationJobId(o.order.id));
        return !!j && (await j.getState()) === "completed";
      });
      if (transport.callCount !== 3) {
        throw new Error(`expected 3 SMTP attempts, got ${transport.callCount}`);
      }
      if (transport.messages.length !== 1) {
        throw new Error(`expected 1 success, got ${transport.messages.length}`);
      }
      if (!(await delivery.wasDelivered(orderConfirmationWorkKey(o.order.id)))) {
        throw new Error("missing mark after retry success");
      }
    });

    await run("OC9 exhaustion → DLQ", async () => {
      transport.callCount = 0;
      transport.messages.length = 0;
      transport.alwaysFail = true;
      const o = await createRegisteredOrder({
        locale: "en",
        userLocale: "en",
        nameSnapshot: "DLQ Snap",
        unitPrice: "3.00",
      });
      await cleanOrderJob(o.order.id);
      jobIds.push(orderConfirmationJobId(o.order.id));
      const beforeOrder = JSON.stringify(
        await prisma!.order.findUniqueOrThrow({ where: { id: o.order.id } }),
      );
      await adapter!.enqueueOrderConfirmation({
        orderId: o.order.id,
        to: o.email,
        communicationLocale: "en",
      });
      await waitUntil("OC9 failed", async () => {
        const j = await queue!.getJob(orderConfirmationJobId(o.order.id));
        return !!j && (await j.getState()) === "failed";
      });
      await waitUntil("OC9 DLQ", async () => {
        return (await dlq!.getJob(orderConfirmationDlqJobId(o.order.id))) != null;
      });
      if (await delivery.wasDelivered(orderConfirmationWorkKey(o.order.id))) {
        throw new Error("mark must not exist after DLQ");
      }
      const afterOrder = JSON.stringify(
        await prisma!.order.findUniqueOrThrow({ where: { id: o.order.id } }),
      );
      if (beforeOrder !== afterOrder) throw new Error("Order mutated after DLQ");
    });

    await run("OC10 guest order access link", async () => {
      transport.alwaysFail = false;
      transport.failuresBeforeSuccess = 0;
      transport.messages.length = 0;
      transport.callCount = 0;
      const g = await createGuestOrder();
      await cleanOrderJob(g.order.id);
      jobIds.push(orderConfirmationJobId(g.order.id));
      await adapter!.enqueueOrderConfirmation({
        orderId: g.order.id,
        to: g.guestEmail,
        communicationLocale: "de",
        guestAccessToken: g.rawToken,
      });
      await waitUntil("OC10 completed", async () => {
        const j = await queue!.getJob(orderConfirmationJobId(g.order.id));
        return !!j && (await j.getState()) === "completed";
      });
      if (transport.messages.length !== 1) throw new Error("guest SMTP missing");
      const text = transport.messages[0]!.text;
      assertNoForbidden(text);
      if (!text.includes("Guest Snapshot Product")) throw new Error("guest snapshot name missing");
      if (!text.includes("/order-tracking?")) throw new Error("guest tracking path missing");
      if (!text.includes(`orderNumber=${encodeURIComponent(g.order.orderNumber)}`)) {
        throw new Error("guest orderNumber missing from link");
      }
      if (!text.includes(`token=${encodeURIComponent(g.rawToken)}`)) {
        throw new Error("guest raw token missing from link");
      }
      if (text.includes("/account/orders/")) {
        throw new Error("guest must not use account path");
      }
      if (transport.messages[0]!.meta.communicationLocale !== "de") {
        throw new Error("guest Order.locale=de not used");
      }
    });

    await run("OC12 Auth delivered keys remain separate", async () => {
      const workKey = orderConfirmationWorkKey(reg.order.id);
      const authStyle = `auth-email:delivered:${workKey}`;
      const orderStyle = orderConfirmationDeliveredRedisKey(workKey);
      const authVal = await storeConn!.get(authStyle);
      const orderVal = await storeConn!.get(orderStyle);
      if (authVal != null) throw new Error("order mark leaked into auth-email keyspace");
      if (orderVal == null) throw new Error("order mark missing in order-email keyspace");
    });

    await run("OC13 seller snapshot ignores live CompanySettings", async () => {
      transport.alwaysFail = false;
      transport.failuresBeforeSuccess = 0;
      transport.messages.length = 0;
      transport.callCount = 0;

      const frozenLegal = "OC Frozen Seller UG";
      const liveChanged = `LIVE-CHANGED-SELLER-${stamp}`;
      const o = await createRegisteredOrder({
        locale: "en",
        userLocale: "de",
        nameSnapshot: "Seller Freeze Probe",
        unitPrice: "7.00",
      });
      await cleanOrderJob(o.order.id);
      jobIds.push(orderConfirmationJobId(o.order.id));

      companyMutated = true;
      await prisma!.companySettings.update({
        where: { id: "default" },
        data: {
          legalName: liveChanged,
          line1: "LIVE Changed Street 99",
          supportEmail: "live-changed@example.com",
        },
      });

      await adapter!.enqueueOrderConfirmation({
        orderId: o.order.id,
        to: o.email,
        communicationLocale: "en",
      });
      await waitUntil("OC13 completed", async () => {
        const j = await queue!.getJob(orderConfirmationJobId(o.order.id));
        return !!j && (await j.getState()) === "completed";
      });
      if (transport.messages.length !== 1) throw new Error("expected 1 SMTP message");
      const text = transport.messages[0]!.text;
      if (!text.includes(frozenLegal)) throw new Error("frozen seller legalName missing");
      if (!text.includes("Frozen Seller Str. 1")) throw new Error("frozen seller address missing");
      if (text.includes(liveChanged)) throw new Error("live CompanySettings.legalName used");
      if (text.includes("LIVE Changed Street 99")) throw new Error("live CompanySettings.line1 used");
      if (text.includes("live-changed@example.com")) {
        throw new Error("live CompanySettings.supportEmail used");
      }

      await prisma!.companySettings.update({
        where: { id: "default" },
        data: companyRestore!,
      });
      companyMutated = false;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of scenarioIds) {
      if (!results.some((r) => r.id === id)) {
        results.push({ id, status: "BLOCKED", note: msg });
        console.error(`  ⊘ ${id}: BLOCKED`);
      }
    }
  } finally {
    for (const id of jobIds) {
      const j = await queue?.getJob(id).catch(() => undefined);
      if (j) await j.remove().catch(() => undefined);
      const orderId = id.split(":")[2];
      if (orderId) {
        const d = await dlq?.getJob(orderConfirmationDlqJobId(orderId)).catch(() => undefined);
        if (d) await d.remove().catch(() => undefined);
        await storeConn
          ?.del(orderConfirmationDeliveredRedisKey(orderConfirmationWorkKey(orderId)))
          .catch(() => undefined);
      }
    }
    for (const orderId of createdOrderIds) {
      await prisma?.orderItem.deleteMany({ where: { orderId } }).catch(() => undefined);
      await prisma?.order.delete({ where: { id: orderId } }).catch(() => undefined);
    }
    for (const userId of createdUserIds) {
      await prisma?.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    if (prisma && companyMutated && companyRestore) {
      await prisma.companySettings
        .update({ where: { id: "default" }, data: companyRestore })
        .catch(() => undefined);
    }
    if (prisma && variantIdForRestore != null && variantPriceBefore !== undefined) {
      await prisma.productVariant
        .update({ where: { id: variantIdForRestore }, data: { price: variantPriceBefore as never } })
        .catch(() => undefined);
    }
    await worker?.close().catch(() => undefined);
    await adapter?.onModuleDestroy().catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await dlq?.close().catch(() => undefined);
    queueConn?.disconnect();
    workerConn?.disconnect();
    storeConn?.disconnect();
    dlqConn?.disconnect();
    await prisma?.$disconnect().catch(() => undefined);
  }

  printSummary(results);
  process.exit(results.some((r) => r.status !== "PASS") ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
