/**
 * Webhook → PAID — POST /v1/payments/webhook
 * 10.9 §1 / §1a
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory, roles, PaymentMethod)
 * Run (after build): node dist/payments.webhook.selftest.js
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { createHmac, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import {
  ActorType,
  BonusLedgerType,
  OrderStatus,
  PaymentStatus,
  TaxMode,
} from "@dodo/database";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { hashToken } from "./auth/crypto.util";
import { InventoryService } from "./inventory/inventory.service";
import { PaymentsWebhookTestAppModule } from "./payments.webhook-test.module";
import { PrismaService } from "./prisma/prisma.service";
import { WEBHOOK_FRESHNESS_SEC } from "./payments/webhook.types";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown; headers: IncomingHttpHeaders };

const IDS = [
  "WH1",
  "WH2",
  "WH3",
  "WH4",
  "WH5",
  "WH6",
  "WH7",
  "WH8",
  "WH9",
  "WH10",
  "WH11",
  "WH12",
  "WH13",
  "WH14",
  "WH15",
] as const;

const STRIPE_WHSEC = "whsec_test_dodo_webhook_secret";
const PAYPAL_WH_ID = "WH-TEST-DODO";

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function errCode(body: unknown): string | undefined {
  return (body as { code?: string })?.code ?? (body as { error?: string })?.error;
}

function stripeSign(raw: string, t = Math.floor(Date.now() / 1000)): string {
  const hmac = createHmac("sha256", STRIPE_WHSEC).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${hmac}`;
}

function stripePaidRaw(eventId: string, intentId: string): string {
  return JSON.stringify({
    id: eventId,
    type: "payment_intent.succeeded",
    data: { object: { id: intentId, object: "payment_intent" } },
  });
}

function stripeIgnoreRaw(eventId: string, intentId: string): string {
  return JSON.stringify({
    id: eventId,
    type: "payment_intent.created",
    data: { object: { id: intentId, object: "payment_intent" } },
  });
}

function paypalPaidRaw(eventId: string, orderId: string): string {
  return JSON.stringify({
    id: eventId,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: `CAP-${eventId}`,
      supplementary_data: { related_ids: { order_id: orderId } },
    },
  });
}

function paypalIgnoreRaw(eventId: string): string {
  return JSON.stringify({
    id: eventId,
    event_type: "MERCHANT.ONBOARDING.COMPLETED",
    resource: { id: "not-an-order" },
  });
}

function paypalHeaders(transmissionTime = new Date().toISOString()): Record<string, string> {
  return {
    "PAYPAL-TRANSMISSION-ID": randomBytes(8).toString("hex"),
    "PAYPAL-TRANSMISSION-TIME": transmissionTime,
    "PAYPAL-TRANSMISSION-SIG": "dGVzdC1zaWc=",
    "PAYPAL-CERT-URL": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
    "PAYPAL-AUTH-ALGO": "SHA256withRSA",
  };
}

function call(
  server: Server,
  opts: { headers?: Record<string, string>; body?: string | Buffer },
): Promise<HttpResult> {
  const addr = server.address() as AddressInfo;
  const payload = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: addr.port,
        path: "/v1/payments/webhook",
        method: "POST",
        headers: {
          ...(payload !== undefined
            ? { "Content-Type": "application/json", "Content-Length": payload.length }
            : { "Content-Length": 0 }),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          if (text) {
            try {
              body = JSON.parse(text) as unknown;
            } catch {
              body = text;
            }
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function main() {
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WHSEC;
  process.env.PAYPAL_WEBHOOK_ID = PAYPAL_WH_ID;
  process.env.PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "test-paypal-client";
  process.env.PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "test-paypal-secret";

  const stamp = Date.now();
  const results: Result[] = [];
  const run = async (id: (typeof IDS)[number], fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ id, status: "PASS" });
    } catch (e) {
      results.push({
        id,
        status: "FAIL",
        note: e instanceof Error ? e.message : String(e),
      });
    }
  };

  let paypalVerifyStatus = "SUCCESS";
  const paypalFetchUrls: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    paypalFetchUrls.push(url);
    if (url.includes("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/v1/notifications/verify-webhook-signature")) {
      return new Response(JSON.stringify({ verification_status: paypalVerifyStatus }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (origFetch) return origFetch(input, init);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const app = await NestFactory.create(PaymentsWebhookTestAppModule, {
    logger: false,
    rawBody: true,
  });
  app.setGlobalPrefix("v1");
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0);
  const server = app.getHttpServer() as Server;
  const prisma = app.get(PrismaService);
  const inventory = app.get(InventoryService);

  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdBonusAccountIds: string[] = [];

  const location = await prisma.location.findFirst({
    where: { code: "MAIN", isActive: true },
  });
  if (!location) throw new Error("MAIN location missing — seed required");
  const inv = await prisma.inventory.findFirst({
    where: { locationId: location.id },
  });
  if (!inv) throw new Error("MAIN inventory missing — seed required");
  const variantId = inv.variantId;
  const inventoryId = inv.id;
  const onHandBefore = inv.quantityOnHand;
  const locationId = location.id;

  await prisma.paymentMethod.upsert({
    where: { code: "stripe_card" },
    create: { code: "stripe_card", provider: "stripe", isEnabled: true, sortOrder: 1 },
    update: { isEnabled: true },
  });
  await prisma.paymentMethod.upsert({
    where: { code: "paypal" },
    create: { code: "paypal", provider: "paypal", isEnabled: true, sortOrder: 2 },
    update: { isEnabled: true },
  });

  const stripeMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "stripe_card" } });
  const paypalMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "paypal" } });

  const resetStock = async () => {
    await prisma.reservation.updateMany({
      where: { variantId, locationId, releasedAt: null, convertedAt: null },
      data: { releasedAt: new Date() },
    });
    await prisma.inventory.update({
      where: { id: inventoryId },
      data: { quantityOnHand: 10 },
    });
  };

  const createUser = async (): Promise<string> => {
    const user = await prisma.user.create({
      data: {
        email: `wh_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
        passwordHash: `hash_${randomBytes(8).toString("hex")}`,
        locale: "de",
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);
    return user.id;
  };

  const ensureBonus = async (userId: string, balance: number): Promise<string> => {
    const existing = await prisma.bonusAccount.findUnique({ where: { userId } });
    if (existing) {
      await prisma.bonusAccount.update({ where: { id: existing.id }, data: { balanceCached: balance } });
      createdBonusAccountIds.push(existing.id);
      return existing.id;
    }
    const acct = await prisma.bonusAccount.create({
      data: { userId, balanceCached: balance },
    });
    createdBonusAccountIds.push(acct.id);
    return acct.id;
  };

  const seedReady = async (opts: {
    provider: "stripe" | "paypal";
    intentId: string;
    guest?: boolean;
    redeem?: number;
    skipReservation?: boolean;
    expireReservation?: boolean;
    skipPayment?: boolean;
  }): Promise<{ orderId: string; userId: string | null }> => {
    const userId = opts.guest ? null : await createUser();
    if (userId && (opts.redeem ?? 0) > 0) {
      await ensureBonus(userId, Math.max(opts.redeem ?? 0, 200));
    }
    const redeem = opts.redeem ?? 0;
    const discountBonus = redeem > 0 ? (redeem / 100).toFixed(2) : "0.00";
    const order = await prisma.order.create({
      data: {
        orderNumber: `WH-${stamp}-${randomBytes(3).toString("hex")}`,
        userId,
        guestEmail: userId ? null : `wh-guest-${stamp}@test.local`,
        guestAccessTokenHash: userId ? null : hashToken(randomBytes(16).toString("hex")),
        status: OrderStatus.PLACED,
        paymentStatus: PaymentStatus.PENDING,
        currencyCode: "EUR",
        locale: "de",
        shippingCountryCode: "DE",
        taxMode: TaxMode.KLEINUNTERNEHMER,
        companyIsKleinunternehmer: true,
        invoiceExemptionTextSnapshot: "§19",
        itemsSubtotal: "10.00",
        shippingTotal: "0.00",
        discountCoupon: "0.00",
        discountBonus,
        grandTotal: (10 - Number(discountBonus)).toFixed(2),
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: "0.00",
        shippingAddressJson: { line1: "WH Test" },
        billingAddressJson: { line1: "WH Test" },
        sellerIdentitySnapshotJson: {
          legalName: "WH Test UG",
          line1: "Test Str. 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        paymentMethodCodeSnapshot: opts.provider === "stripe" ? "stripe" : "paypal",
        bonusPointsRedeemed: redeem,
        bonusDiscountAmount: discountBonus,
        items: {
          create: [
            {
              variantId,
              skuSnapshot: "WH-SKU",
              nameSnapshot: "WH item",
              quantity: 1,
              unitPriceSnapshot: "10.00",
              lineTotalSnapshot: "10.00",
              weightGramsSnapshot: 100,
            },
          ],
        },
      },
    });
    createdOrderIds.push(order.id);

    if (!opts.skipReservation) {
      const key = `wh-${stamp}-${randomBytes(4).toString("hex")}`;
      await inventory.reserve(key, variantId, locationId, 1);
      await inventory.bind(key, order.id);
      if (opts.expireReservation) {
        await prisma.reservation.updateMany({
          where: { orderId: order.id },
          data: { expiresAt: new Date(Date.now() - 60_000) },
        });
      }
    }

    if (!opts.skipPayment) {
      await prisma.payment.create({
        data: {
          orderId: order.id,
          paymentMethodId: opts.provider === "stripe" ? stripeMethod.id : paypalMethod.id,
          provider: opts.provider,
          providerIntentId: opts.intentId,
          amount: "10.00",
          currencyCode: "EUR",
          status: PaymentStatus.PENDING,
        },
      });
    }

    return { orderId: order.id, userId };
  };

  const assertSettled = async (orderId: string, opts?: { redeem?: number; earn?: number; guest?: boolean }) => {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== OrderStatus.CONFIRMED) throw new Error(`status ${order.status}`);
    if (order.paymentStatus !== PaymentStatus.PAID) throw new Error(`paymentStatus ${order.paymentStatus}`);
    const payment = await prisma.payment.findFirst({ where: { orderId } });
    if (payment?.status !== PaymentStatus.PAID) throw new Error("payment not PAID");
    const movements = await prisma.stockMovement.findMany({
      where: { orderId, reason: "sale" },
    });
    if (movements.length !== 1) throw new Error(`sale movements ${movements.length}`);
    if (movements[0].delta !== -1) throw new Error(`delta ${movements[0].delta}`);
    const redeemRows = await prisma.bonusLedger.findMany({
      where: { orderId, type: BonusLedgerType.REDEEM },
    });
    const earnRows = await prisma.bonusLedger.findMany({
      where: { orderId, type: BonusLedgerType.EARN },
    });
    if (opts?.guest) {
      if (earnRows.length !== 0) throw new Error("guest EARN");
      if (order.bonusPointsEarned != null) throw new Error("guest bonusPointsEarned");
    } else if (opts?.earn !== undefined) {
      if (earnRows.length !== 1) throw new Error(`earn rows ${earnRows.length}`);
      if (earnRows[0].points !== opts.earn) throw new Error(`earn ${earnRows[0].points}`);
      if (earnRows[0].idempotencyKey !== `earn:${orderId}`) throw new Error("earn key");
      if (earnRows[0].actorType !== ActorType.SYSTEM) throw new Error("earn actor");
      if (order.bonusPointsEarned !== opts.earn) throw new Error(`bonusPointsEarned ${order.bonusPointsEarned}`);
    }
    if (opts?.redeem) {
      if (redeemRows.length !== 1) throw new Error(`redeem rows ${redeemRows.length}`);
      if (redeemRows[0].points !== -opts.redeem) throw new Error(`redeem ${redeemRows[0].points}`);
      if (redeemRows[0].idempotencyKey !== `redeem:${orderId}`) throw new Error("redeem key");
    } else if (!opts?.guest) {
      if (redeemRows.length !== 0) throw new Error("unexpected REDEEM");
    }
  };

  const assertUnchangedPending = async (orderId: string) => {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== OrderStatus.PLACED) throw new Error(`status ${order.status}`);
    if (order.paymentStatus !== PaymentStatus.PENDING) throw new Error(`paymentStatus ${order.paymentStatus}`);
    const payment = await prisma.payment.findFirst({ where: { orderId } });
    if (payment && payment.status !== PaymentStatus.PENDING) throw new Error("payment mutated");
    const movements = await prisma.stockMovement.count({ where: { orderId } });
    if (movements !== 0) throw new Error("sale written");
    const ledger = await prisma.bonusLedger.count({ where: { orderId } });
    if (ledger !== 0) throw new Error("ledger written");
  };

  await resetStock();

  try {
    await run("WH1", async () => {
      await resetStock();
      const intentId = `pi_wh1_${stamp}`;
      const eventId = `evt_wh1_${stamp}`;
      createdEventIds.push(eventId);
      const { orderId } = await seedReady({ provider: "stripe", intentId });
      const raw = stripePaidRaw(eventId, intentId);
      const res = await call(server, {
        headers: { "Stripe-Signature": stripeSign(raw) },
        body: raw,
      });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      await assertSettled(orderId, { earn: 10 });
    });

    await run("WH2", async () => {
      await resetStock();
      paypalVerifyStatus = "SUCCESS";
      const intentId = `PAYPALWH2${stamp.toString(16)}`.slice(0, 17);
      const eventId = `WH-TEST-2-${stamp}`;
      createdEventIds.push(eventId);
      const { orderId } = await seedReady({ provider: "paypal", intentId });
      const raw = paypalPaidRaw(eventId, intentId);
      const res = await call(server, { headers: paypalHeaders(), body: raw });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      await assertSettled(orderId, { earn: 10 });
    });

    await run("WH3", async () => {
      await resetStock();
      const intentId = `pi_wh3_${stamp}`;
      const eventId = `evt_wh3_${stamp}`;
      createdEventIds.push(eventId);
      const { orderId } = await seedReady({ provider: "stripe", intentId });
      const raw = stripePaidRaw(eventId, intentId);
      const res = await call(server, {
        headers: { "Stripe-Signature": "t=1,v1=deadbeef" },
        body: raw,
      });
      if (res.status !== 400 || errCode(res.body) !== "VALIDATION_ERROR") {
        throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      }
      await assertUnchangedPending(orderId);
      const ev = await prisma.webhookEvent.findUnique({
        where: { provider_eventId: { provider: "stripe", eventId } },
      });
      if (ev) throw new Error("WebhookEvent written on invalid signature");
    });

    await run("WH4", async () => {
      await resetStock();
      paypalVerifyStatus = "FAILURE";
      const intentId = `PAYPALWH4${stamp.toString(16)}`.slice(0, 17);
      const eventId = `WH-TEST-4-${stamp}`;
      createdEventIds.push(eventId);
      const { orderId } = await seedReady({ provider: "paypal", intentId });
      const raw = paypalPaidRaw(eventId, intentId);
      const res = await call(server, { headers: paypalHeaders(), body: raw });
      if (res.status !== 400 || errCode(res.body) !== "VALIDATION_ERROR") {
        throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      }
      await assertUnchangedPending(orderId);
      const ev = await prisma.webhookEvent.findUnique({
        where: { provider_eventId: { provider: "paypal", eventId } },
      });
      if (ev) throw new Error("WebhookEvent written on invalid PayPal signature");
      paypalVerifyStatus = "SUCCESS";
    });

    await run("WH5", async () => {
      const empty = await call(server, { body: "" });
      if (empty.status !== 400) throw new Error(`empty ${empty.status}`);
      const none = await call(server, { body: "{" });
      if (none.status !== 400) throw new Error(`garbage ${none.status}`);
      const raw = "{not-json";
      const signed = await call(server, {
        headers: { "Stripe-Signature": stripeSign(raw) },
        body: raw,
      });
      if (signed.status !== 400) throw new Error(`signed malformed ${signed.status}`);
    });

    await run("WH6", async () => {
      await resetStock();
      const intentId = `pi_wh6_${stamp}`;
      const eventId = `evt_wh6_${stamp}`;
      createdEventIds.push(eventId);
      const { orderId } = await seedReady({ provider: "stripe", intentId });
      const raw = stripePaidRaw(eventId, intentId);
      const staleT = Math.floor(Date.now() / 1000) - (WEBHOOK_FRESHNESS_SEC + 100);
      const stripeRes = await call(server, {
        headers: { "Stripe-Signature": stripeSign(raw, staleT) },
        body: raw,
      });
      if (stripeRes.status !== 400) throw new Error(`stripe stale ${stripeRes.status}`);
      await assertUnchangedPending(orderId);
      const ev = await prisma.webhookEvent.findUnique({
        where: { provider_eventId: { provider: "stripe", eventId } },
      });
      if (ev) throw new Error("stale stripe wrote WebhookEvent");

      paypalVerifyStatus = "SUCCESS";
      const before = paypalFetchUrls.filter((u) => u.includes("verify-webhook-signature")).length;
      const pEvent = `WH-TEST-6-${stamp}`;
      createdEventIds.push(pEvent);
      const pIntent = `PAYPALWH6${stamp.toString(16)}`.slice(0, 17);
      await seedReady({ provider: "paypal", intentId: pIntent });
      const pRaw = paypalPaidRaw(pEvent, pIntent);
      const old = new Date(Date.now() - (WEBHOOK_FRESHNESS_SEC + 100) * 1000).toISOString();
      const paypalRes = await call(server, { headers: paypalHeaders(old), body: pRaw });
      if (paypalRes.status !== 400) throw new Error(`paypal stale ${paypalRes.status}`);
      const after = paypalFetchUrls.filter((u) => u.includes("verify-webhook-signature")).length;
      if (after !== before) throw new Error("stale PayPal must not call verify API");
    });

    await run("WH7", async () => {
      await resetStock();
      const intentId = `pi_wh7_${stamp}`;
      const eventId = `evt_wh7_${stamp}`;
      createdEventIds.push(eventId);
      const { orderId } = await seedReady({ provider: "stripe", intentId });
      const raw = stripeIgnoreRaw(eventId, intentId);
      const res = await call(server, {
        headers: { "Stripe-Signature": stripeSign(raw) },
        body: raw,
      });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      await assertUnchangedPending(orderId);
      const ev = await prisma.webhookEvent.findUnique({
        where: { provider_eventId: { provider: "stripe", eventId } },
      });
      if (!ev) throw new Error("ignore event should persist WebhookEvent");
    });

    await run("WH8", async () => {
      const eventId = `evt_wh8_${stamp}`;
      createdEventIds.push(eventId);
      const raw = stripePaidRaw(eventId, `pi_orphan_${stamp}`);
      const beforeOrders = await prisma.order.count();
      const beforePay = await prisma.payment.count();
      const res = await call(server, {
        headers: { "Stripe-Signature": stripeSign(raw) },
        body: raw,
      });
      if (res.status !== 503) throw new Error(`orphan status ${res.status} ${JSON.stringify(res.body)}`);
      if (errCode(res.body) !== "INTERNAL_ERROR") throw new Error(`orphan code ${errCode(res.body)}`);
      const ev = await prisma.webhookEvent.findUnique({
        where: { provider_eventId: { provider: "stripe", eventId } },
      });
      if (ev) throw new Error("orphan wrote WebhookEvent");
      if ((await prisma.order.count()) !== beforeOrders) throw new Error("orphan created Order");
      if ((await prisma.payment.count()) !== beforePay) throw new Error("orphan created Payment");
    });

    await run("WH9", async () => {
      await resetStock();
      const intentId = `pi_wh9_${stamp}`;
      const eventId = `evt_wh9_${stamp}`;
      createdEventIds.push(eventId);
      const { orderId } = await seedReady({ provider: "stripe", intentId });
      const raw = stripePaidRaw(eventId, intentId);
      const headers = { "Stripe-Signature": stripeSign(raw) };
      const first = await call(server, { headers, body: raw });
      if (first.status !== 200) throw new Error(`first ${first.status}`);
      const second = await call(server, { headers, body: raw });
      if (second.status !== 200) throw new Error(`second ${second.status}`);
      await assertSettled(orderId, { earn: 10 });
      const events = await prisma.webhookEvent.count({
        where: { provider: "stripe", eventId },
      });
      if (events !== 1) throw new Error(`events ${events}`);
    });

    await run("WH10", async () => {
      await resetStock();
      const intentId = `pi_wh10_${stamp}`;
      const eventId = `evt_wh10_${stamp}`;
      createdEventIds.push(eventId);
      const { orderId, userId } = await seedReady({ provider: "stripe", intentId, redeem: 100 });
      if (!userId) throw new Error("expected user");
      const raw = stripePaidRaw(eventId, intentId);
      const res = await call(server, {
        headers: { "Stripe-Signature": stripeSign(raw) },
        body: raw,
      });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      // goods = 10.00 − 0 − 1.00 = 9 → 9 EARN; REDEEM 100
      await assertSettled(orderId, { redeem: 100, earn: 9 });
      const acct = await prisma.bonusAccount.findUniqueOrThrow({ where: { userId } });
      if (acct.balanceCached !== 200 - 100 + 9) {
        throw new Error(`balanceCached ${acct.balanceCached}`);
      }
      const ev = await prisma.webhookEvent.findUnique({
        where: { provider_eventId: { provider: "stripe", eventId } },
      });
      if (!ev) throw new Error("missing WebhookEvent in settlement commit");
    });

    await run("WH11", async () => {
      await resetStock();
      const expiredIntent = `pi_wh11e_${stamp}`;
      const expiredEvent = `evt_wh11e_${stamp}`;
      createdEventIds.push(expiredEvent);
      const expired = await seedReady({
        provider: "stripe",
        intentId: expiredIntent,
        expireReservation: true,
      });
      const expiredRaw = stripePaidRaw(expiredEvent, expiredIntent);
      const expiredRes = await call(server, {
        headers: { "Stripe-Signature": stripeSign(expiredRaw) },
        body: expiredRaw,
      });
      if (expiredRes.status !== 500) {
        throw new Error(`expired ${expiredRes.status} ${JSON.stringify(expiredRes.body)}`);
      }
      await assertUnchangedPending(expired.orderId);
      if (
        await prisma.webhookEvent.findUnique({
          where: { provider_eventId: { provider: "stripe", eventId: expiredEvent } },
        })
      ) {
        throw new Error("expired wrote WebhookEvent");
      }

      const missIntent = `pi_wh11m_${stamp}`;
      const missEvent = `evt_wh11m_${stamp}`;
      createdEventIds.push(missEvent);
      const missing = await seedReady({
        provider: "stripe",
        intentId: missIntent,
        skipReservation: true,
      });
      const missRaw = stripePaidRaw(missEvent, missIntent);
      const missRes = await call(server, {
        headers: { "Stripe-Signature": stripeSign(missRaw) },
        body: missRaw,
      });
      if (missRes.status !== 500) {
        throw new Error(`missing ${missRes.status} ${JSON.stringify(missRes.body)}`);
      }
      await assertUnchangedPending(missing.orderId);
      if (
        await prisma.webhookEvent.findUnique({
          where: { provider_eventId: { provider: "stripe", eventId: missEvent } },
        })
      ) {
        throw new Error("missing wrote WebhookEvent");
      }
    });

    await run("WH12", async () => {
      await resetStock();
      const intentId = `pi_wh12_${stamp}`;
      const eventA = `evt_wh12a_${stamp}`;
      const eventB = `evt_wh12b_${stamp}`;
      createdEventIds.push(eventA, eventB);
      const { orderId } = await seedReady({ provider: "stripe", intentId });
      const rawA = stripePaidRaw(eventA, intentId);
      const first = await call(server, {
        headers: { "Stripe-Signature": stripeSign(rawA) },
        body: rawA,
      });
      if (first.status !== 200) throw new Error(`first ${first.status}`);
      const rawB = stripePaidRaw(eventB, intentId);
      const second = await call(server, {
        headers: { "Stripe-Signature": stripeSign(rawB) },
        body: rawB,
      });
      if (second.status !== 200) throw new Error(`second ${second.status}`);
      const movements = await prisma.stockMovement.count({
        where: { orderId, reason: "sale" },
      });
      if (movements !== 1) throw new Error(`movements ${movements}`);
      const onHand = (await prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId } }))
        .quantityOnHand;
      if (onHand !== 9) throw new Error(`onHand ${onHand}`);
    });

    await run("WH13", async () => {
      await resetStock();
      const intentId = `pi_wh13_${stamp}`;
      const eventId = `evt_wh13_${stamp}`;
      createdEventIds.push(eventId);
      const { orderId } = await seedReady({ provider: "stripe", intentId, redeem: 100 });
      const raw = stripePaidRaw(eventId, intentId);
      const headers = { "Stripe-Signature": stripeSign(raw) };
      const first = await call(server, { headers, body: raw });
      if (first.status !== 200) throw new Error(`first ${first.status}`);
      const second = await call(server, { headers, body: raw });
      if (second.status !== 200) throw new Error(`second ${second.status}`);
      const redeemRows = await prisma.bonusLedger.count({
        where: { orderId, type: BonusLedgerType.REDEEM },
      });
      if (redeemRows !== 1) throw new Error(`redeem ${redeemRows}`);
      const earnRows = await prisma.bonusLedger.count({
        where: { orderId, type: BonusLedgerType.EARN },
      });
      if (earnRows !== 1) throw new Error(`earn ${earnRows}`);
    });

    await run("WH14", async () => {
      await resetStock();
      const intentId = `pi_wh14_${stamp}`;
      const eventId = `evt_wh14_${stamp}`;
      createdEventIds.push(eventId);
      const { orderId } = await seedReady({ provider: "stripe", intentId, guest: true });
      const raw = stripePaidRaw(eventId, intentId);
      const res = await call(server, {
        headers: { "Stripe-Signature": stripeSign(raw) },
        body: raw,
      });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      await assertSettled(orderId, { guest: true });
    });

    await run("WH15", async () => {
      await resetStock();
      const intentId = `pi_wh15_${stamp}`;
      const eventId = `evt_wh15_${stamp}`;
      createdEventIds.push(eventId);
      const { orderId } = await seedReady({ provider: "stripe", intentId, redeem: 100 });
      const raw = stripePaidRaw(eventId, intentId);
      const headers = { "Stripe-Signature": stripeSign(raw) };
      const [a, b] = await Promise.all([
        call(server, { headers, body: raw }),
        call(server, { headers, body: raw }),
      ]);
      if (a.status !== 200 || b.status !== 200) {
        throw new Error(`concurrent ${a.status}/${b.status} ${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
      }
      await assertSettled(orderId, { redeem: 100, earn: 9 });
      const movements = await prisma.stockMovement.count({
        where: { orderId, reason: "sale" },
      });
      if (movements !== 1) throw new Error(`movements ${movements}`);
      const events = await prisma.webhookEvent.count({
        where: { provider: "stripe", eventId },
      });
      if (events !== 1) throw new Error(`events ${events}`);
    });
  } finally {
    globalThis.fetch = origFetch;
    try {
      for (const eventId of createdEventIds) {
        await prisma.webhookEvent.deleteMany({ where: { eventId } });
      }
      for (const orderId of createdOrderIds) {
        await prisma.bonusLedger.deleteMany({ where: { orderId } });
        await prisma.stockMovement.deleteMany({ where: { orderId } });
        await prisma.payment.deleteMany({ where: { orderId } });
        await prisma.invoice.deleteMany({ where: { orderId } });
        await prisma.orderItem.deleteMany({ where: { orderId } });
        await prisma.reservation.updateMany({
          where: { orderId },
          data: { orderId: null, releasedAt: new Date() },
        });
        await prisma.order.delete({ where: { id: orderId } }).catch(() => undefined);
      }
      for (const id of createdBonusAccountIds) {
        await prisma.bonusLedger.deleteMany({ where: { accountId: id } });
        await prisma.bonusAccount.delete({ where: { id } }).catch(() => undefined);
      }
      for (const userId of createdUserIds) {
        await prisma.session.deleteMany({ where: { userId } });
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      }
      await prisma.inventory.update({
        where: { id: inventoryId },
        data: { quantityOnHand: onHandBefore },
      });
    } catch (restoreErr) {
      console.error("restore failed", restoreErr);
    }
    await app.close();
  }

  printSummary(results);
  const failed = results.some((r) => r.status !== "PASS");
  if (failed || results.length !== IDS.length) process.exit(1);
  console.log("\nWebhook → PAID: ALL PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
