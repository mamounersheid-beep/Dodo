/**
 * Payment Retry after FAILED — POST /v1/orders/:orderId/payment-intent
 * 10.9 §7 / §7a · 10.15 Path B checkoutEnabled · first-intent §7e unchanged
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory, roles, PaymentMethod)
 * Run (after build): node dist/orders.payment-retry.selftest.js
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { OrderStatus, PaymentStatus, TaxMode } from "@dodo/database";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { InventoryService } from "./inventory/inventory.service";
import { UNPAID_ORDER_TTL_MS } from "./inventory/inventory.constants";
import { PlaceOrderPreconditionError } from "./orders/place-order-preconditions";
import { InMemoryFirstAttemptProviders } from "./payments/in-memory.first-attempt.providers";
import { OrdersPaymentIntentTestAppModule } from "./orders.payment-intent-test.module";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown; headers: IncomingHttpHeaders };

const IDS = [
  "PR1",
  "PR2",
  "PR3",
  "PR4",
  "PR5",
  "PR6",
  "PR7",
  "PR8",
  "PR9",
  "PR10",
] as const;

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function errCode(body: unknown): string | undefined {
  return (body as { code?: string })?.code ?? (body as { error?: string })?.error;
}

function call(
  server: Server,
  method: string,
  path: string,
  opts?: {
    bearer?: string;
    json?: unknown;
    sendJson?: boolean;
  },
): Promise<HttpResult> {
  const addr = server.address() as AddressInfo;
  const sendJson = opts?.sendJson === true || opts?.json !== undefined;
  const payload = sendJson ? JSON.stringify(opts?.json ?? {}) : undefined;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          ...(payload !== undefined
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          ...(opts?.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
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

function assertStripeEnvelope(body: unknown): { provider: "stripe"; clientSecret: string } {
  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["clientSecret", "provider"])) {
    throw new Error(`stripe keys ${keys.join(",")}`);
  }
  if (obj.provider !== "stripe") throw new Error(`provider ${String(obj.provider)}`);
  if (typeof obj.clientSecret !== "string" || !obj.clientSecret) throw new Error("clientSecret");
  return { provider: "stripe", clientSecret: obj.clientSecret };
}

async function main() {
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

  const app = await NestFactory.create(OrdersPaymentIntentTestAppModule, { logger: false });
  app.setGlobalPrefix("v1");
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0);
  const server = app.getHttpServer() as Server;
  const prisma = app.get(PrismaService);
  const jwt = app.get(JwtService);
  const providers = app.get(InMemoryFirstAttemptProviders);
  const inventory = app.get(InventoryService);

  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  let checkoutEnabledRestore: boolean | null = null;

  const location = await prisma.location.findFirst({
    where: { code: "MAIN", isActive: true },
  });
  if (!location) throw new Error("MAIN location missing — seed required");
  const inv = await prisma.inventory.findFirst({
    where: { locationId: location.id },
  });
  if (!inv) throw new Error("MAIN inventory missing — seed required");
  const variantId = inv.variantId;

  await prisma.paymentMethod.upsert({
    where: { code: "stripe_card" },
    create: { code: "stripe_card", provider: "stripe", isEnabled: true, sortOrder: 1 },
    update: { isEnabled: true },
  });

  await prisma.companySettings.update({
    where: { id: "default" },
    data: { checkoutEnabled: true },
  });

  const registerUser = async (): Promise<{ bearer: string; userId: string }> => {
    const user = await prisma.user.create({
      data: {
        email: `pr_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
        passwordHash: `hash_${randomBytes(8).toString("hex")}`,
        locale: "de",
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: randomBytes(16).toString("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const bearer = await jwt.signAsync({ sub: user.id, sid: session.id, roles: [] });
    return { bearer, userId: user.id };
  };

  const createOrder = async (opts: {
    userId: string;
    status?: OrderStatus;
    paymentStatus?: PaymentStatus;
    placedAt?: Date;
  }): Promise<{ id: string; orderNumber: string }> => {
    const order = await prisma.order.create({
      data: {
        orderNumber: `PR-${stamp}-${randomBytes(3).toString("hex")}`,
        userId: opts.userId,
        status: opts.status ?? OrderStatus.PLACED,
        paymentStatus: opts.paymentStatus ?? PaymentStatus.PENDING,
        placedAt: opts.placedAt ?? new Date(),
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
        shippingAddressJson: { line1: "PR Test" },
        billingAddressJson: { line1: "PR Test" },
        sellerIdentitySnapshotJson: {
          legalName: "PR Test UG",
          line1: "Test Str. 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        paymentMethodCodeSnapshot: "stripe",
        items: {
          create: [
            {
              variantId,
              skuSnapshot: "PR-SKU",
              nameSnapshot: "PR item",
              quantity: 1,
              unitPriceSnapshot: "10.00",
              lineTotalSnapshot: "10.00",
              weightGramsSnapshot: 100,
            },
          ],
        },
      },
      select: { id: true, orderNumber: true },
    });
    createdOrderIds.push(order.id);
    return order;
  };

  const intent = (orderId: string, bearer: string) =>
    call(server, "POST", `/v1/orders/${orderId}/payment-intent`, { bearer, json: {} });

  const markFailed = async (orderId: string, paymentId: string) => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.FAILED },
    });
    await prisma.order.update({
      where: { id: orderId },
      data: { paymentStatus: PaymentStatus.FAILED },
    });
    await inventory.releaseByOrderId(orderId);
  };

  providers.reset();

  try {
    // PR1 — successful retry after FAILED (new Payment + new intent)
    await run("PR1", async () => {
      providers.reset();
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      const first = await intent(order.id, bearer);
      if (first.status !== 200) throw new Error(`first ${first.status}`);
      const firstEnv = assertStripeEnvelope(first.body);
      const paymentsBefore = await prisma.payment.findMany({ where: { orderId: order.id } });
      if (paymentsBefore.length !== 1) throw new Error("expected one first payment");
      const failedIntentId = paymentsBefore[0].providerIntentId;
      await markFailed(order.id, paymentsBefore[0].id);

      const retry = await intent(order.id, bearer);
      if (retry.status !== 200) throw new Error(`retry ${retry.status} ${JSON.stringify(retry.body)}`);
      const retryEnv = assertStripeEnvelope(retry.body);
      if (retryEnv.clientSecret === firstEnv.clientSecret) {
        throw new Error("retry reused first clientSecret");
      }
      const payments = await prisma.payment.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: "asc" },
      });
      if (payments.length !== 2) throw new Error(`payments ${payments.length}`);
      if (payments[0].status !== PaymentStatus.FAILED) throw new Error("first not FAILED");
      if (payments[1].status !== PaymentStatus.PENDING) throw new Error("retry not PENDING");
      if (payments[1].providerIntentId === failedIntentId) {
        throw new Error("reused FAILED providerIntentId");
      }
      const ord = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      if (ord.paymentStatus !== PaymentStatus.PENDING) throw new Error("order not PENDING");
    });

    // PR2 — checkoutEnabled=false → 409 STORE_CHECKOUT_DISABLED on retry only
    await run("PR2", async () => {
      providers.reset();
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      const first = await intent(order.id, bearer);
      if (first.status !== 200) throw new Error(`first ${first.status}`);
      const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      await markFailed(order.id, pay.id);

      const before = await prisma.companySettings.findUniqueOrThrow({
        where: { id: "default" },
        select: { checkoutEnabled: true },
      });
      checkoutEnabledRestore = before.checkoutEnabled;
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { checkoutEnabled: false },
      });

      const retry = await intent(order.id, bearer);
      if (retry.status !== 409 || errCode(retry.body) !== PlaceOrderPreconditionError.STORE_CHECKOUT_DISABLED) {
        throw new Error(`retry gate ${retry.status} ${JSON.stringify(retry.body)}`);
      }

      await prisma.companySettings.update({
        where: { id: "default" },
        data: { checkoutEnabled: true },
      });
      checkoutEnabledRestore = null;
    });

    // PR3 — non-owner → 404
    await run("PR3", async () => {
      providers.reset();
      const a = await registerUser();
      const b = await registerUser();
      const order = await createOrder({ userId: a.userId });
      const first = await intent(order.id, a.bearer);
      if (first.status !== 200) throw new Error(`first ${first.status}`);
      const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      await markFailed(order.id, pay.id);
      const res = await intent(order.id, b.bearer);
      if (res.status !== 404 || errCode(res.body) !== "NOT_FOUND") {
        throw new Error(`non-owner ${res.status} ${JSON.stringify(res.body)}`);
      }
    });

    // PR4 — invalid state (CONFIRMED) rejected
    await run("PR4", async () => {
      providers.reset();
      const { bearer, userId } = await registerUser();
      const order = await createOrder({
        userId,
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.FAILED,
      });
      const method = await prisma.paymentMethod.findFirstOrThrow({ where: { provider: "stripe" } });
      await prisma.payment.create({
        data: {
          orderId: order.id,
          paymentMethodId: method.id,
          provider: "stripe",
          providerIntentId: `pi_failed_${randomBytes(4).toString("hex")}`,
          amount: "10.00",
          currencyCode: "EUR",
          status: PaymentStatus.FAILED,
        },
      });
      const res = await intent(order.id, bearer);
      if (res.status !== 404 || errCode(res.body) !== "NOT_FOUND") {
        throw new Error(`confirmed ${res.status} ${JSON.stringify(res.body)}`);
      }
    });

    // PR5 — sellability reject
    await run("PR5", async () => {
      providers.reset();
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      const first = await intent(order.id, bearer);
      if (first.status !== 200) throw new Error(`first ${first.status}`);
      const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      await markFailed(order.id, pay.id);

      const variant = await prisma.productVariant.findUniqueOrThrow({
        where: { id: variantId },
        select: { isActive: true },
      });
      await prisma.productVariant.update({
        where: { id: variantId },
        data: { isActive: false },
      });
      try {
        const res = await intent(order.id, bearer);
        if (res.status !== 409) {
          throw new Error(`sellability ${res.status} ${JSON.stringify(res.body)}`);
        }
      } finally {
        await prisma.productVariant.update({
          where: { id: variantId },
          data: { isActive: variant.isActive },
        });
      }
    });

    // PR6 — order-bound reservation (orderId set, checkoutKey NULL)
    await run("PR6", async () => {
      providers.reset();
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      const first = await intent(order.id, bearer);
      if (first.status !== 200) throw new Error(`first ${first.status}`);
      const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      await markFailed(order.id, pay.id);

      const beforeActive = await prisma.reservation.count({
        where: {
          orderId: order.id,
          releasedAt: null,
          convertedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (beforeActive !== 0) throw new Error(`expected released before retry, got ${beforeActive}`);

      const retry = await intent(order.id, bearer);
      if (retry.status !== 200) throw new Error(`retry ${retry.status}`);

      const rows = await prisma.reservation.findMany({
        where: {
          orderId: order.id,
          releasedAt: null,
          convertedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (rows.length < 1) throw new Error("no active order-bound reservation");
      for (const r of rows) {
        if (r.checkoutKey !== null) throw new Error("checkoutKey must be NULL");
        if (r.orderId !== order.id) throw new Error("orderId mismatch");
        if (r.variantId !== variantId) throw new Error("variant mismatch");
      }
    });

    // PR7 — new intent; FAILED attempt not reused (also replay converges)
    await run("PR7", async () => {
      providers.reset();
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      const first = await intent(order.id, bearer);
      if (first.status !== 200) throw new Error(`first ${first.status}`);
      const firstPay = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      const failedIntent = firstPay.providerIntentId;
      await markFailed(order.id, firstPay.id);

      const createsBefore = providers.createCalls;
      const a = await intent(order.id, bearer);
      const b = await intent(order.id, bearer);
      if (a.status !== 200 || b.status !== 200) throw new Error(`replay ${a.status}/${b.status}`);
      const sa = assertStripeEnvelope(a.body).clientSecret;
      const sb = assertStripeEnvelope(b.body).clientSecret;
      if (sa !== sb) throw new Error("retry replay diverged");
      const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
      const pending = payments.filter((p) => p.status === PaymentStatus.PENDING);
      if (pending.length !== 1) throw new Error(`pending ${pending.length}`);
      if (pending[0].providerIntentId === failedIntent) throw new Error("reused failed intent");
      if (providers.createCalls !== createsBefore + 1) {
        throw new Error(`createCalls ${providers.createCalls - createsBefore}`);
      }
    });

    // PR8 — concurrent retry converges
    await run("PR8", async () => {
      providers.reset();
      providers.createDelayMs = 80;
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      const first = await intent(order.id, bearer);
      if (first.status !== 200) throw new Error(`first ${first.status}`);
      const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
      await markFailed(order.id, pay.id);

      const [x, y] = await Promise.all([intent(order.id, bearer), intent(order.id, bearer)]);
      providers.createDelayMs = 0;
      if (x.status !== 200 || y.status !== 200) throw new Error(`concurrent ${x.status}/${y.status}`);
      if (assertStripeEnvelope(x.body).clientSecret !== assertStripeEnvelope(y.body).clientSecret) {
        throw new Error("concurrent secrets diverged");
      }
      const pending = await prisma.payment.findMany({
        where: { orderId: order.id, status: PaymentStatus.PENDING },
      });
      if (pending.length !== 1) throw new Error(`concurrent pending ${pending.length}`);
    });

    // PR9 — outside UNPAID_ORDER_TTL → 404
    await run("PR9", async () => {
      providers.reset();
      const { bearer, userId } = await registerUser();
      const order = await createOrder({
        userId,
        paymentStatus: PaymentStatus.FAILED,
        placedAt: new Date(Date.now() - UNPAID_ORDER_TTL_MS - 60_000),
      });
      const method = await prisma.paymentMethod.findFirstOrThrow({ where: { provider: "stripe" } });
      await prisma.payment.create({
        data: {
          orderId: order.id,
          paymentMethodId: method.id,
          provider: "stripe",
          providerIntentId: `pi_old_${randomBytes(4).toString("hex")}`,
          amount: "10.00",
          currencyCode: "EUR",
          status: PaymentStatus.FAILED,
        },
      });
      const res = await intent(order.id, bearer);
      if (res.status !== 404) throw new Error(`ttl ${res.status} ${JSON.stringify(res.body)}`);
    });

    // PR10 — first intent still ignores checkoutEnabled (Option B)
    await run("PR10", async () => {
      providers.reset();
      const before = await prisma.companySettings.findUniqueOrThrow({
        where: { id: "default" },
        select: { checkoutEnabled: true },
      });
      checkoutEnabledRestore = before.checkoutEnabled;
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { checkoutEnabled: false },
      });
      try {
        const { bearer, userId } = await registerUser();
        const order = await createOrder({ userId });
        const res = await intent(order.id, bearer);
        if (res.status !== 200) {
          throw new Error(`first under checkoutEnabled=false → ${res.status} ${JSON.stringify(res.body)}`);
        }
        assertStripeEnvelope(res.body);
        const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
        if (payments.length !== 1) throw new Error("first intent broke");
      } finally {
        await prisma.companySettings.update({
          where: { id: "default" },
          data: { checkoutEnabled: true },
        });
        checkoutEnabledRestore = null;
      }
    });
  } finally {
    if (checkoutEnabledRestore !== null) {
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { checkoutEnabled: checkoutEnabledRestore },
      });
    }
    if (createdOrderIds.length) {
      await prisma.payment.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.reservation.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (createdUserIds.length) {
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
