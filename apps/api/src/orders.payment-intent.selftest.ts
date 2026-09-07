/**
 * First Payment Intent — POST /v1/orders/:orderId/payment-intent
 * 10.9 §7b HTTP · §7c invariant · §7d create-failure recovery
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory, roles, PaymentMethod)
 * Run (after build): node dist/orders.payment-intent.selftest.js
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
import { hashToken } from "./auth/crypto.util";
import { GUEST_KEY_HEADER } from "./cart/cart.types";
import { CHECKOUT_KEY_HEADER } from "./orders/checkout-key.transport";
import {
  GUEST_ACCESS_TOKEN_HEADER,
  ORDER_NUMBER_HEADER,
} from "./orders/guest-order-access.transport";
import { paymentIntentTestHooks } from "./payments/first-intent.hooks";
import { InMemoryFirstAttemptProviders } from "./payments/in-memory.first-attempt.providers";
import { OrdersPaymentIntentTestAppModule } from "./orders.payment-intent-test.module";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown; headers: IncomingHttpHeaders };

const IDS = [
  "PI1",
  "PI2",
  "PI3",
  "PI4",
  "PI5",
  "PI6",
  "PI7",
  "PI8",
  "PI9",
  "PI10",
  "PI11",
  "PI12",
  "PI13",
  "PI14",
  "PI15",
  "PI16",
] as const;

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function errCode(body: unknown): string | undefined {
  return (body as { code?: string })?.code
    ?? (body as { error?: string })?.error;
}

function mintCheckoutKey(): string {
  return randomBytes(32).toString("base64url");
}

function call(
  server: Server,
  method: string,
  path: string,
  opts?: {
    bearer?: string;
    guestKey?: string;
    checkoutKey?: string;
    idempotencyKey?: string;
    orderNumber?: string;
    guestAccessToken?: string;
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
          ...(opts?.guestKey ? { [GUEST_KEY_HEADER]: opts.guestKey } : {}),
          ...(opts?.checkoutKey ? { [CHECKOUT_KEY_HEADER]: opts.checkoutKey } : {}),
          ...(opts?.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
          ...(opts?.orderNumber ? { [ORDER_NUMBER_HEADER]: opts.orderNumber } : {}),
          ...(opts?.guestAccessToken ? { [GUEST_ACCESS_TOKEN_HEADER]: opts.guestAccessToken } : {}),
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
  if ("approvalUrl" in obj) throw new Error("approvalUrl leaked");
  if ("pan" in obj || "cvv" in obj || "card" in obj) throw new Error("card data leaked");
  return { provider: "stripe", clientSecret: obj.clientSecret };
}

function assertPayPalEnvelope(body: unknown): { provider: "paypal"; approvalUrl: string } {
  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["approvalUrl", "provider"])) {
    throw new Error(`paypal keys ${keys.join(",")}`);
  }
  if (obj.provider !== "paypal") throw new Error(`provider ${String(obj.provider)}`);
  if (typeof obj.approvalUrl !== "string" || !obj.approvalUrl.startsWith("https://")) {
    throw new Error("approvalUrl");
  }
  if ("clientSecret" in obj) throw new Error("clientSecret leaked");
  return { provider: "paypal", approvalUrl: obj.approvalUrl };
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

  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdCartGuestKeys: string[] = [];
  const createdCheckoutKeys: string[] = [];

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
  await prisma.paymentMethod.upsert({
    where: { code: "paypal" },
    create: { code: "paypal", provider: "paypal", isEnabled: true, sortOrder: 2 },
    update: { isEnabled: true },
  });

  /** Fixture user — created directly so the auth register throttler is not exercised. */
  const registerUser = async (): Promise<{ bearer: string; userId: string }> => {
    const user = await prisma.user.create({
      data: {
        email: `pi_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
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
    userId?: string | null;
    guestToken?: string;
    snapshot?: "stripe" | "paypal";
    status?: OrderStatus;
    paymentStatus?: PaymentStatus;
  }): Promise<{ id: string; orderNumber: string }> => {
    const order = await prisma.order.create({
      data: {
        orderNumber: `PI-${stamp}-${randomBytes(3).toString("hex")}`,
        userId: opts.userId ?? null,
        guestEmail: opts.userId ? null : `pi-guest-${stamp}@test.local`,
        guestAccessTokenHash: opts.guestToken ? hashToken(opts.guestToken) : null,
        status: opts.status ?? OrderStatus.PLACED,
        paymentStatus: opts.paymentStatus ?? PaymentStatus.PENDING,
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
        shippingAddressJson: { line1: "PI Test" },
        billingAddressJson: { line1: "PI Test" },
        sellerIdentitySnapshotJson: {
          legalName: "PI Test UG",
          line1: "Test Str. 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        paymentMethodCodeSnapshot: opts.snapshot ?? "stripe",
        items: {
          create: [
            {
              variantId,
              skuSnapshot: "PI-SKU",
              nameSnapshot: "PI item",
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

  const intent = (
    orderId: string,
    opts?: Parameters<typeof call>[3],
  ) => call(server, "POST", `/v1/orders/${orderId}/payment-intent`, { json: {}, ...opts });

  providers.reset();

  try {
    await run("PI1", async () => {
      providers.reset();
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId, snapshot: "stripe" });
      const res = await intent(order.id, { bearer });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const env = assertStripeEnvelope(res.body);
      if (res.headers.location) throw new Error("Location header present");
      const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
      if (payments.length !== 1) throw new Error(`payments ${payments.length}`);
      if (payments[0].status !== PaymentStatus.PENDING) throw new Error("not PENDING");
      if (payments[0].provider !== "stripe") throw new Error("provider");
      if (!payments[0].providerIntentId) throw new Error("providerIntentId");
      if (env.clientSecret.includes("pan") || env.clientSecret.length < 8) {
        throw new Error("clientSecret shape");
      }
    });

    await run("PI2", async () => {
      providers.reset();
      const raw = randomBytes(24).toString("base64url");
      const order = await createOrder({ guestToken: raw, snapshot: "stripe" });
      const res = await intent(order.id, {
        orderNumber: order.orderNumber,
        guestAccessToken: raw,
      });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      assertStripeEnvelope(res.body);
    });

    await run("PI3", async () => {
      const order = await createOrder({ snapshot: "stripe" });
      const none = await intent(order.id);
      if (none.status !== 400 || errCode(none.body) !== "VALIDATION_ERROR") {
        throw new Error(`none ${none.status} ${JSON.stringify(none.body)}`);
      }
      const partial = await intent(order.id, { orderNumber: order.orderNumber });
      if (partial.status !== 400 || errCode(partial.body) !== "VALIDATION_ERROR") {
        throw new Error(`partial ${partial.status}`);
      }
      const blank = await intent(order.id, { orderNumber: "  ", guestAccessToken: "  " });
      if (blank.status !== 400 || errCode(blank.body) !== "VALIDATION_ERROR") {
        throw new Error(`blank ${blank.status}`);
      }
    });

    await run("PI4", async () => {
      const { userId } = await registerUser();
      const order = await createOrder({ userId });
      const res = await intent(order.id, { bearer: "not-a-jwt" });
      if (res.status !== 401 || errCode(res.body) !== "UNAUTHORIZED") {
        throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      }
    });

    await run("PI5", async () => {
      const a = await registerUser();
      const b = await registerUser();
      const order = await createOrder({ userId: a.userId });
      const res = await intent(order.id, { bearer: b.bearer });
      if (res.status !== 404 || errCode(res.body) !== "NOT_FOUND") {
        throw new Error(`non-owner ${res.status} ${JSON.stringify(res.body)}`);
      }
      const adminRole = await prisma.role.findUnique({ where: { code: "ADMIN" } });
      if (adminRole) {
        await prisma.userRole.upsert({
          where: { userId_roleId: { userId: b.userId, roleId: adminRole.id } },
          create: { userId: b.userId, roleId: adminRole.id },
          update: {},
        });
        const staffRes = await intent(order.id, { bearer: b.bearer });
        if (staffRes.status !== 404) throw new Error(`staff ${staffRes.status}`);
      }
    });

    await run("PI6", async () => {
      const raw = randomBytes(24).toString("base64url");
      const order = await createOrder({ guestToken: raw });
      const badToken = await intent(order.id, {
        orderNumber: order.orderNumber,
        guestAccessToken: "wrong-token",
      });
      if (badToken.status !== 404) throw new Error(`bad token ${badToken.status}`);
      const badNumber = await intent(order.id, {
        orderNumber: "NOPE",
        guestAccessToken: raw,
      });
      if (badNumber.status !== 404) throw new Error(`bad number ${badNumber.status}`);
      const cancelled = await createOrder({
        guestToken: raw,
        status: OrderStatus.CANCELLED,
      });
      const cancelledRes = await intent(cancelled.id, {
        orderNumber: cancelled.orderNumber,
        guestAccessToken: raw,
      });
      if (cancelledRes.status !== 404) throw new Error(`cancelled ${cancelledRes.status}`);
    });

    await run("PI7", async () => {
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      const res = await intent(order.id, {
        bearer,
        json: { paymentMethodCode: "stripe" },
      });
      if (res.status !== 400) {
        throw new Error(`extra ${res.status} ${JSON.stringify(res.body)}`);
      }
      const code = errCode(res.body);
      if (code !== "VALIDATION_ERROR" && code !== "Bad Request") {
        throw new Error(`extra code ${code}`);
      }
    });

    await run("PI8", async () => {
      providers.reset();
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId, snapshot: "paypal" });
      const res = await intent(order.id, { bearer });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      assertPayPalEnvelope(res.body);
      const payment = await prisma.payment.findFirst({ where: { orderId: order.id } });
      if (payment?.provider !== "paypal") throw new Error("paypal provider row");
    });

    await run("PI9", async () => {
      providers.reset();
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      const first = await intent(order.id, { bearer, checkoutKey: "ignored-checkout" });
      if (first.status !== 200) throw new Error(`first ${first.status}`);
      assertStripeEnvelope(first.body);
      if (first.headers.location) throw new Error("Location");
      const second = await intent(order.id, { bearer, checkoutKey: "still-ignored" });
      if (second.status !== 200) throw new Error(`second ${second.status}`);
      const a = assertStripeEnvelope(first.body);
      const b = assertStripeEnvelope(second.body);
      if (a.clientSecret !== b.clientSecret) throw new Error("clientSecret changed");
      const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
      if (payments.length !== 1) throw new Error(`second payment ${payments.length}`);
      if (providers.createCalls !== 1) throw new Error(`createCalls ${providers.createCalls}`);
      if (providers.retrieveCalls < 1) throw new Error("expected retrieve on replay");
    });

    await run("PI10", async () => {
      providers.reset();
      providers.createDelayMs = 80;
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      const [x, y] = await Promise.all([
        intent(order.id, { bearer }),
        intent(order.id, { bearer }),
      ]);
      providers.createDelayMs = 0;
      if (x.status !== 200 || y.status !== 200) {
        throw new Error(`concurrent ${x.status}/${y.status}`);
      }
      const cx = assertStripeEnvelope(x.body).clientSecret;
      const cy = assertStripeEnvelope(y.body).clientSecret;
      if (cx !== cy) throw new Error("concurrent secrets diverged");
      const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
      if (payments.length !== 1) throw new Error(`concurrent payments ${payments.length}`);
      if (providers.createCalls !== 1) throw new Error(`concurrent creates ${providers.createCalls}`);
    });

    await run("PI11", async () => {
      providers.reset();
      providers.stripeMode = "unknown-once";
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      const first = await intent(order.id, { bearer });
      if (first.status < 500) throw new Error(`unknown not 5xx ${first.status}`);
      const paymentsAfterFail = await prisma.payment.findMany({ where: { orderId: order.id } });
      if (paymentsAfterFail.length !== 0) throw new Error("payment after unknown");
      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      if (row.paymentStatus !== PaymentStatus.PENDING) throw new Error("wrote FAILED on unknown");
      const second = await intent(order.id, { bearer });
      if (second.status !== 200) throw new Error(`recover ${second.status} ${JSON.stringify(second.body)}`);
      assertStripeEnvelope(second.body);
      const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
      if (payments.length !== 1) throw new Error(`recover payments ${payments.length}`);
      if (providers.storedCount() !== 1) throw new Error("second provider object");
    });

    await run("PI12", async () => {
      providers.reset();
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      paymentIntentTestHooks.beforePersist = async () => {
        throw new Error("persist-fail");
      };
      const first = await intent(order.id, { bearer });
      delete paymentIntentTestHooks.beforePersist;
      if (first.status < 500) throw new Error(`persist fail not 5xx ${first.status}`);
      const paymentsAfter = await prisma.payment.findMany({ where: { orderId: order.id } });
      if (paymentsAfter.length !== 0) throw new Error("payment after persist fail");
      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      if (row.paymentStatus !== PaymentStatus.PENDING) throw new Error("wrote FAILED on persist fail");
      const second = await intent(order.id, { bearer });
      if (second.status !== 200) throw new Error(`persist recover ${second.status}`);
      const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
      if (payments.length !== 1) throw new Error(`after recover ${payments.length}`);
    });

    await run("PI13", async () => {
      providers.reset();
      providers.stripeMode = "reject";
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      const res = await intent(order.id, { bearer });
      if (res.status < 500) throw new Error(`reject not 5xx ${res.status}`);
      const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
      if (payments.length !== 0) throw new Error("payment after reject");
      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      if (row.paymentStatus !== PaymentStatus.PENDING) throw new Error("wrote FAILED on reject");
      providers.stripeMode = "ok";
    });

    await run("PI14", async () => {
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      const without = await intent(order.id, { bearer });
      if (without.status !== 200) throw new Error(`no key ${without.status}`);
      const withKey = await intent(order.id, { bearer, idempotencyKey: "client-key-must-be-ignored" });
      if (withKey.status !== 200) throw new Error(`with key ${withKey.status}`);
      const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
      if (payments.length !== 1) throw new Error("Idempotency-Key minted a second Payment");
    });

    await run("PI15", async () => {
      providers.reset();
      const before = providers.createCalls;
      const { bearer, userId } = await registerUser();
      const gk = `gk-pi-${stamp}-${randomBytes(4).toString("hex")}`;
      createdCartGuestKeys.push(gk);
      const add = await call(server, "POST", "/v1/cart/items", {
        bearer,
        json: { variantId, quantity: 1 },
      });
      if (add.status !== 200 && add.status !== 201) {
        throw new Error(`cart ${add.status} ${JSON.stringify(add.body)}`);
      }
      const ck = mintCheckoutKey();
      createdCheckoutKeys.push(ck);
      const reserve = await call(server, "POST", "/v1/orders/reserve", {
        bearer,
        checkoutKey: ck,
        json: { variantId, quantity: 1 },
      });
      if (reserve.status !== 200) {
        throw new Error(`reserve ${reserve.status} ${JSON.stringify(reserve.body)}`);
      }
      const placed = await call(server, "POST", "/v1/orders", {
        bearer,
        checkoutKey: ck,
        idempotencyKey: `ik-pi-${stamp}`,
        json: {
          shippingAddressJson: {
            name: "Ada",
            line1: "Musterstraße 1",
            postalCode: "10115",
            city: "Berlin",
            countryCode: "DE",
          },
          billingAddressJson: {
            name: "Ada",
            line1: "Musterstraße 1",
            postalCode: "10115",
            city: "Berlin",
            countryCode: "DE",
          },
          paymentMethodCode: "stripe",
          acceptedAgb: true,
          acceptedWiderrufInfo: true,
        },
      });
      if (placed.status !== 201) {
        throw new Error(`placeOrder ${placed.status} ${JSON.stringify(placed.body)}`);
      }
      const id = (placed.body as { id: string }).id;
      createdOrderIds.push(id);
      if (providers.createCalls !== before) {
        throw new Error(`placeOrder called provider (${providers.createCalls - before})`);
      }
      const payments = await prisma.payment.findMany({ where: { orderId: id } });
      if (payments.length !== 0) throw new Error("placeOrder created Payment");
    });

    await run("PI16", async () => {
      const { bearer, userId } = await registerUser();
      const order = await createOrder({ userId });
      await intent(order.id, { bearer, guestKey: "must-be-ignored" });
      const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
      if (payments.length !== 1) throw new Error("x-guest-key affected first attempt");
    });
  } finally {
    delete paymentIntentTestHooks.beforePersist;
    if (createdOrderIds.length) {
      await prisma.payment.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.reservation.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.couponUsage.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    }
    if (createdCheckoutKeys.length) {
      await prisma.reservation.deleteMany({
        where: { checkoutKey: { in: createdCheckoutKeys } },
      });
    }
    if (createdOrderIds.length) {
      await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (createdCartGuestKeys.length) {
      await prisma.cartItem.deleteMany({
        where: { cart: { guestKey: { in: createdCartGuestKeys } } },
      });
      await prisma.cart.deleteMany({ where: { guestKey: { in: createdCartGuestKeys } } });
    }
    if (createdUserIds.length) {
      await prisma.cartItem.deleteMany({
        where: { cart: { userId: { in: createdUserIds } } },
      });
      await prisma.cart.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.bonusLedger.deleteMany({
        where: { account: { userId: { in: createdUserIds } } },
      });
      await prisma.bonusAccount.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
      await prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.couponUsage.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
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
