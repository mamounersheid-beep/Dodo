/**
 * 10.10 §2a/§2b — Admin Resend order confirmation.
 *
 * Requires: DATABASE_URL (+ seeded Role + ProductVariant)
 * Run (after build): pnpm --filter @dodo/api test:admin-resend
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import { OrderStatus, PaymentStatus, RoleCode } from "@dodo/database";
import { hashToken } from "./auth/crypto.util";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import {
  GUEST_ACCESS_REISSUE_AUDIT_ACTION,
  GUEST_ORDER_ACCESS_TTL_MS,
  ORDER_CONFIRMATION_RESEND_AUDIT_ACTION,
} from "./orders/guest-access.constants";
import { buildOrderConfirmationEmail } from "./integrations/email/order-confirmation.builder";
import {
  orderConfirmationResendJobId,
  orderConfirmationResendWorkKey,
  orderConfirmationWorkKey,
} from "./integrations/email/email-integration.port";
import {
  adminResendEmailState,
  OrdersAdminResendTestAppModule,
} from "./orders.admin-resend-test.module";
import type { OrdersService } from "./orders/orders.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

const SELLER_SNAP = {
  legalName: "Resend Frozen Seller UG",
  line1: "Resend Str. 1",
  postalCode: "10115",
  city: "Berlin",
  countryCode: "DE",
  supportEmail: "resend-seller@example.com",
  supportPhone: "+49 30 111",
};

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
  const pass = results.filter((r) => r.status === "PASS").length;
  console.log(`\n${pass}/${results.length} PASS`);
}

function call(
  server: Server,
  method: string,
  path: string,
  opts?: { bearer?: string; json?: unknown },
): Promise<HttpResult> {
  const addr = server.address() as AddressInfo;
  const payload = opts?.json !== undefined ? JSON.stringify(opts.json) : undefined;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          ...(payload
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
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function errCode(body: unknown): string | undefined {
  return (body as { code?: string })?.code;
}

async function main(): Promise<void> {
  const results: Result[] = [];
  const stamp = Date.now().toString(36);
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  const run = async (id: string, fn: () => Promise<void>) => {
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

  const app = await NestFactory.create(OrdersAdminResendTestAppModule, { logger: false });
  app.setGlobalPrefix("v1");
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0);
  const server = app.getHttpServer() as Server;
  const prisma = app.get(PrismaService);
  const jwt = app.get(JwtService);
  // Avoid top-level OrdersService value import (Nest DI circular / undefined token under tsx).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OrdersService: OrdersServiceClass } = require("./orders/orders.service") as {
    OrdersService: new (...args: never[]) => OrdersService;
  };
  const orders = app.get(OrdersServiceClass);

  const pathFor = (orderId: string) => `/v1/admin/orders/${orderId}/resend-confirmation`;

  const staffUser = async (code: RoleCode): Promise<{ bearer: string; userId: string }> => {
    const role = await prisma.role.findUniqueOrThrow({ where: { code } });
    const user = await prisma.user.create({
      data: {
        email: `ar_${code}_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
        passwordHash: `hash_${randomBytes(8).toString("hex")}`,
        locale: "de",
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: randomBytes(16).toString("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const bearer = await jwt.signAsync({ sub: user.id, sid: session.id, roles: [code] });
    return { bearer, userId: user.id };
  };

  const variant = await prisma.productVariant.findFirst({ where: { isActive: true } });
  if (!variant) throw new Error("ProductVariant required — seed");

  const baseOrderData = () => ({
    currencyCode: "EUR" as const,
    locale: "de",
    shippingCountryCode: "DE",
    taxMode: "KLEINUNTERNEHMER" as const,
    companyIsKleinunternehmer: true,
    invoiceExemptionTextSnapshot: "§19 snapshot",
    itemsSubtotal: "10.00",
    shippingTotal: "0",
    discountCoupon: "0",
    discountBonus: "0",
    grandTotal: "10.00",
    shippingMethodCodeSnapshot: "standard",
    shippingStandardAmountSnapshot: "0",
    shippingAddressJson: { line1: "Ship" },
    billingAddressJson: { line1: "Bill" },
    sellerIdentitySnapshotJson: SELLER_SNAP,
    legalAgbVersionId: "agb",
    legalWiderrufVersionId: "wid",
    legalPrivacyVersionId: "priv",
    items: {
      create: [
        {
          variantId: variant.id,
          skuSnapshot: "AR-SKU",
          nameSnapshot: "Resend Item",
          quantity: 1,
          unitPriceSnapshot: "10.00",
          lineTotalSnapshot: "10.00",
          weightGramsSnapshot: 100,
        },
      ],
    },
  });

  const createRegistered = async (opts?: {
    status?: OrderStatus;
    paymentStatus?: PaymentStatus;
  }) => {
    const email = `ar-cust-${stamp}-${randomBytes(3).toString("hex")}@test.local`;
    const user = await prisma.user.create({
      data: { email, passwordHash: "x", locale: "de", emailVerifiedAt: new Date() },
    });
    createdUserIds.push(user.id);
    const order = await prisma.order.create({
      data: {
        ...baseOrderData(),
        orderNumber: `AR-R-${stamp}-${randomBytes(3).toString("hex")}`,
        userId: user.id,
        status: opts?.status ?? OrderStatus.PLACED,
        paymentStatus: opts?.paymentStatus ?? PaymentStatus.PENDING,
      },
    });
    createdOrderIds.push(order.id);
    return { order, user, email };
  };

  const createGuest = async (opts?: {
    status?: OrderStatus;
    paymentStatus?: PaymentStatus;
    placedAt?: Date;
    rawToken?: string;
  }) => {
    const rawToken = opts?.rawToken ?? randomBytes(32).toString("base64url");
    const guestEmail = `ar-guest-${stamp}-${randomBytes(3).toString("hex")}@test.local`;
    const order = await prisma.order.create({
      data: {
        ...baseOrderData(),
        orderNumber: `AR-G-${stamp}-${randomBytes(3).toString("hex")}`,
        guestEmail,
        guestAccessTokenHash: hashToken(rawToken),
        status: opts?.status ?? OrderStatus.PLACED,
        paymentStatus: opts?.paymentStatus ?? PaymentStatus.PENDING,
        placedAt: opts?.placedAt ?? new Date(),
      },
    });
    createdOrderIds.push(order.id);
    return { order, guestEmail, rawToken };
  };

  const resendAuditCount = (orderId: string) =>
    prisma.auditLog.count({
      where: {
        action: ORDER_CONFIRMATION_RESEND_AUDIT_ACTION,
        entityType: "Order",
        entityId: orderId,
      },
    });

  try {
    adminResendEmailState.reset();
    const admin = await staffUser(RoleCode.ADMIN);
    const owner = await staffUser(RoleCode.OWNER);
    const support = await staffUser(RoleCode.SUPPORT);

    await run("AR1", async () => {
      adminResendEmailState.reset();
      const { order } = await createRegistered();
      const res = await call(server, "POST", pathFor(order.id), {
        bearer: admin.bearer,
        json: {},
      });
      if (res.status !== 202) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = res.body as { orderId: string; resendId: string; queued: boolean };
      const keys = Object.keys(body).sort().join(",");
      if (keys !== "orderId,queued,resendId") throw new Error(`keys ${keys}`);
      if (body.orderId !== order.id) throw new Error("orderId mismatch");
      if (!body.resendId || typeof body.resendId !== "string") throw new Error("resendId");
      if (body.queued !== true) throw new Error("queued");
      if (adminResendEmailState.resendCalls.length !== 1) throw new Error("enqueue count");
      if (adminResendEmailState.resendCalls[0]!.guestAccessToken) {
        throw new Error("registered must skip guest token");
      }
    });

    await run("AR2", async () => {
      adminResendEmailState.reset();
      const { order } = await createRegistered({ status: OrderStatus.CONFIRMED });
      const res = await call(server, "POST", pathFor(order.id), {
        bearer: owner.bearer,
        json: {},
      });
      if (res.status !== 202) throw new Error(`status ${res.status}`);
    });

    await run("AR3", async () => {
      const { order } = await createRegistered();
      const before = await resendAuditCount(order.id);
      const res = await call(server, "POST", pathFor(order.id), {
        bearer: support.bearer,
        json: {},
      });
      if (res.status !== 403) throw new Error(`status ${res.status}`);
      if (errCode(res.body) !== "FORBIDDEN") throw new Error(`code ${errCode(res.body)}`);
      if (adminResendEmailState.resendCalls.some((c) => c.orderId === order.id)) {
        throw new Error("SUPPORT must not enqueue");
      }
      if ((await resendAuditCount(order.id)) !== before) throw new Error("SUPPORT audit");
    });

    await run("AR4", async () => {
      const { order } = await createRegistered();
      const res = await call(server, "POST", pathFor(order.id), { json: {} });
      if (res.status !== 401) throw new Error(`status ${res.status}`);
    });

    await run("AR5", async () => {
      const fake = `c${randomBytes(12).toString("hex")}`;
      const res = await call(server, "POST", pathFor(fake), {
        bearer: admin.bearer,
        json: {},
      });
      if (res.status !== 404) throw new Error(`status ${res.status}`);
      if (errCode(res.body) !== "NOT_FOUND") throw new Error(`code ${errCode(res.body)}`);
    });

    await run("AR6", async () => {
      const { order } = await createRegistered();
      const res = await call(server, "POST", pathFor(order.id), {
        bearer: admin.bearer,
        json: { extra: true },
      });
      if (res.status !== 400) throw new Error(`status ${res.status}`);
      // Existing ValidationPipe shape: code is often "Bad Request" (see checkout-key selftest).
      const code = errCode(res.body);
      if (code !== "VALIDATION_ERROR" && code !== "Bad Request") {
        throw new Error(`code ${code}`);
      }
    });

    await run("AR7", async () => {
      const res = await call(server, "POST", pathFor("short"), {
        bearer: admin.bearer,
        json: {},
      });
      if (res.status !== 400) throw new Error(`status ${res.status}`);
      if (errCode(res.body) !== "VALIDATION_ERROR") throw new Error(`code ${errCode(res.body)}`);
    });

    await run("AR8", async () => {
      adminResendEmailState.reset();
      const { order } = await createRegistered({ status: OrderStatus.CANCELLED });
      const res = await call(server, "POST", pathFor(order.id), {
        bearer: admin.bearer,
        json: {},
      });
      if (res.status !== 409) throw new Error(`status ${res.status}`);
      if (errCode(res.body) !== "ORDER_CONFIRMATION_RESEND_NOT_ALLOWED") {
        throw new Error(`code ${errCode(res.body)}`);
      }
      if (adminResendEmailState.resendCalls.length !== 0) throw new Error("must not enqueue");
    });

    await run("AR9", async () => {
      const { order } = await createRegistered({ status: OrderStatus.REFUNDED });
      const res = await call(server, "POST", pathFor(order.id), {
        bearer: admin.bearer,
        json: {},
      });
      if (res.status !== 409) throw new Error(`status ${res.status}`);
      if (errCode(res.body) !== "ORDER_CONFIRMATION_RESEND_NOT_ALLOWED") {
        throw new Error(`code ${errCode(res.body)}`);
      }
    });

    await run("AR10", async () => {
      adminResendEmailState.reset();
      for (const ps of [
        PaymentStatus.PENDING,
        PaymentStatus.PAID,
        PaymentStatus.FAILED,
        PaymentStatus.PARTIALLY_REFUNDED,
        PaymentStatus.REFUNDED,
      ] as const) {
        const { order } = await createRegistered({
          status: OrderStatus.CONFIRMED,
          paymentStatus: ps,
        });
        const res = await call(server, "POST", pathFor(order.id), {
          bearer: admin.bearer,
          json: {},
        });
        if (res.status !== 202) {
          throw new Error(`paymentStatus ${ps}: status ${res.status}`);
        }
      }
    });

    await run("AR11", async () => {
      adminResendEmailState.reset();
      const { order } = await createRegistered({ status: OrderStatus.SHIPPED });
      const res = await call(server, "POST", pathFor(order.id), {
        bearer: admin.bearer,
        json: {},
      });
      if (res.status !== 202) throw new Error(`status ${res.status}`);
      if (adminResendEmailState.resendCalls[0]?.guestAccessToken) {
        throw new Error("registered skip Reissue");
      }
      const reissueAudits = await prisma.auditLog.count({
        where: {
          action: GUEST_ACCESS_REISSUE_AUDIT_ACTION,
          entityId: order.id,
        },
      });
      if (reissueAudits !== 0) throw new Error("registered must not #16 audit");
    });

    await run("AR12", async () => {
      adminResendEmailState.reset();
      const g = await createGuest();
      const hashBefore = (
        await prisma.order.findUniqueOrThrow({ where: { id: g.order.id } })
      ).guestAccessTokenHash;
      const res = await call(server, "POST", pathFor(g.order.id), {
        bearer: admin.bearer,
        json: {},
      });
      if (res.status !== 202) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const call0 = adminResendEmailState.resendCalls[0];
      if (!call0?.guestAccessToken) throw new Error("fresh token required");
      if (call0.guestAccessToken === g.rawToken) throw new Error("token must rotate");
      const hashAfter = (
        await prisma.order.findUniqueOrThrow({ where: { id: g.order.id } })
      ).guestAccessTokenHash;
      if (hashAfter === hashBefore) throw new Error("hash must change");
      if (hashAfter !== hashToken(call0.guestAccessToken)) throw new Error("hash mismatch");
      const reissue = await prisma.auditLog.findFirst({
        where: {
          action: GUEST_ACCESS_REISSUE_AUDIT_ACTION,
          entityId: g.order.id,
        },
      });
      if (!reissue) throw new Error("missing #16 Reissue audit");
      const resend = await prisma.auditLog.findFirst({
        where: {
          action: ORDER_CONFIRMATION_RESEND_AUDIT_ACTION,
          entityId: g.order.id,
        },
      });
      if (!resend) throw new Error("missing Resend audit");
      const after = resend.afterJson as { resendId?: string; guestReissued?: boolean };
      if (after.guestReissued !== true) throw new Error("guestReissued");
      if (after.resendId !== (res.body as { resendId: string }).resendId) {
        throw new Error("resendId meta");
      }
    });

    await run("AR13", async () => {
      adminResendEmailState.reset();
      const old = new Date(Date.now() - GUEST_ORDER_ACCESS_TTL_MS - 60_000);
      const g = await createGuest({ placedAt: old });
      const hashBefore = (
        await prisma.order.findUniqueOrThrow({ where: { id: g.order.id } })
      ).guestAccessTokenHash;
      const res = await call(server, "POST", pathFor(g.order.id), {
        bearer: admin.bearer,
        json: {},
      });
      if (res.status !== 409) throw new Error(`status ${res.status}`);
      if (errCode(res.body) !== "ORDER_CONFIRMATION_RESEND_NOT_ALLOWED") {
        throw new Error(`code ${errCode(res.body)}`);
      }
      const hashAfter = (
        await prisma.order.findUniqueOrThrow({ where: { id: g.order.id } })
      ).guestAccessTokenHash;
      if (hashAfter !== hashBefore) throw new Error("must not reissue outside TTL");
      if (adminResendEmailState.resendCalls.length !== 0) throw new Error("no enqueue");
    });

    await run("AR14", async () => {
      adminResendEmailState.reset();
      const g = await createGuest({ status: OrderStatus.CANCELLED });
      const hashBefore = (
        await prisma.order.findUniqueOrThrow({ where: { id: g.order.id } })
      ).guestAccessTokenHash;
      const res = await call(server, "POST", pathFor(g.order.id), {
        bearer: admin.bearer,
        json: {},
      });
      if (res.status !== 409) throw new Error(`status ${res.status}`);
      const hashAfter = (
        await prisma.order.findUniqueOrThrow({ where: { id: g.order.id } })
      ).guestAccessTokenHash;
      if (hashAfter !== hashBefore) throw new Error("CANCELLED guest must not reissue");
      if (adminResendEmailState.resendCalls.length !== 0) throw new Error("no enqueue");
    });

    await run("AR15", async () => {
      adminResendEmailState.reset();
      const g = await createGuest();
      const beforeEnq = adminResendEmailState.resendCalls.length;
      const beforeResendAudit = await resendAuditCount(g.order.id);
      try {
        await orders.adminResendOrderConfirmation(g.order.id, "missing_actor_xxxxxxxx");
        throw new Error("expected failure");
      } catch (e) {
        const status = (e as { getStatus?: () => number }).getStatus?.();
        if (status !== 500) throw new Error(`expected 500 got ${status} ${e}`);
      }
      if (adminResendEmailState.resendCalls.length !== beforeEnq) {
        throw new Error("Reissue fail must not enqueue");
      }
      if ((await resendAuditCount(g.order.id)) !== beforeResendAudit) {
        throw new Error("Reissue fail must not Resend audit");
      }
    });

    await run("AR16", async () => {
      adminResendEmailState.reset();
      adminResendEmailState.failEnqueue = true;
      const { order } = await createRegistered();
      const before = await resendAuditCount(order.id);
      const res = await call(server, "POST", pathFor(order.id), {
        bearer: admin.bearer,
        json: {},
      });
      adminResendEmailState.failEnqueue = false;
      if (res.status !== 503) throw new Error(`status ${res.status}`);
      if (errCode(res.body) !== "INTERNAL_ERROR") throw new Error(`code ${errCode(res.body)}`);
      if ((await resendAuditCount(order.id)) !== before) {
        throw new Error("enqueue fail must not Resend audit");
      }
    });

    await run("AR17", async () => {
      adminResendEmailState.reset();
      const { order } = await createRegistered();
      const a = await call(server, "POST", pathFor(order.id), {
        bearer: admin.bearer,
        json: {},
      });
      const b = await call(server, "POST", pathFor(order.id), {
        bearer: admin.bearer,
        json: {},
      });
      if (a.status !== 202 || b.status !== 202) throw new Error("both must 202");
      const idA = (a.body as { resendId: string }).resendId;
      const idB = (b.body as { resendId: string }).resendId;
      if (idA === idB) throw new Error("resendIds must differ");
      const keys = adminResendEmailState.resendCalls.map((c) => c.workKey);
      if (keys.length !== 2 || keys[0] === keys[1]) throw new Error("work keys must differ");
      if (keys[0] !== orderConfirmationResendWorkKey(order.id, idA)) {
        throw new Error("work key A");
      }
      if (keys[1] !== orderConfirmationResendWorkKey(order.id, idB)) {
        throw new Error("work key B");
      }
    });

    await run("AR18", async () => {
      const orderId = "ordtest01xxxxxxxx";
      const resendId = "11111111-2222-3333-4444-555555555555";
      const auto = orderConfirmationWorkKey(orderId);
      const resend = orderConfirmationResendWorkKey(orderId, resendId);
      if (auto === resend) throw new Error("keys must differ");
      if (!auto.startsWith("order-confirmation:")) throw new Error("auto key");
      if (!resend.startsWith("order-confirmation-resend:")) throw new Error("resend key");
      const jobId = orderConfirmationResendJobId(orderId, resendId);
      if (jobId.split(":").length !== 3) throw new Error("jobId segments");
    });

    await run("AR19", async () => {
      const built = buildOrderConfirmationEmail({
        order: {
          id: "x",
          orderNumber: "N1",
          placedAt: new Date(),
          locale: "de",
          userId: "u1",
          guestEmail: null,
          paymentStatus: "PAID",
          currencyCode: "EUR",
          taxMode: "KLEINUNTERNEHMER",
          companyIsKleinunternehmer: true,
          invoiceExemptionTextSnapshot: "ku",
          sellerIdentitySnapshotJson: SELLER_SNAP,
          itemsSubtotal: "1",
          shippingTotal: "0",
          discountCoupon: "0",
          discountBonus: "0",
          grandTotal: "1",
          shippingAddressJson: {},
          billingAddressJson: {},
          legalAgbVersionId: null,
          legalAgbHash: null,
          legalWiderrufVersionId: null,
          legalWiderrufHash: null,
          legalPrivacyVersionId: null,
          legalPrivacyHash: null,
          items: [
            {
              skuSnapshot: "S",
              nameSnapshot: "P",
              quantity: 1,
              unitPriceSnapshot: "1",
              lineTotalSnapshot: "1",
            },
          ],
        },
      });
      if (built.paymentStatus !== "PENDING") throw new Error("disclosure status");
      if (!/paymentStatus=PENDING/.test(built.text)) throw new Error("text PENDING");
      if (/\bPAID\b/.test(built.text) && !/noch nicht bezahlt/.test(built.text)) {
        throw new Error("must not claim PAID");
      }
      if (/CompanySettings|live seller/i.test(built.text)) {
        throw new Error("no live CompanySettings");
      }
      if (!built.text.includes(SELLER_SNAP.legalName)) throw new Error("seller snapshot");
    });

    await run("AR20", async () => {
      adminResendEmailState.reset();
      const { order } = await createRegistered();
      const res = await call(server, "POST", pathFor(order.id), {
        bearer: admin.bearer,
        json: {},
      });
      if (res.status !== 202) throw new Error(`status ${res.status}`);
      const body = res.body as { resendId: string };
      const log = await prisma.auditLog.findFirst({
        where: {
          action: ORDER_CONFIRMATION_RESEND_AUDIT_ACTION,
          entityType: "Order",
          entityId: order.id,
          actorId: admin.userId,
        },
        orderBy: { createdAt: "desc" },
      });
      if (!log) throw new Error("audit missing");
      if (log.actorType !== "ADMIN") throw new Error("actorType");
      const after = log.afterJson as { resendId: string; guestReissued: boolean };
      if (after.resendId !== body.resendId) throw new Error("resendId");
      if (after.guestReissued !== false) throw new Error("guestReissued false");
    });
  } finally {
    await prisma.auditLog
      .deleteMany({
        where: {
          OR: [
            { action: ORDER_CONFIRMATION_RESEND_AUDIT_ACTION },
            { action: GUEST_ACCESS_REISSUE_AUDIT_ACTION },
          ],
          entityId: { in: createdOrderIds },
        },
      })
      .catch(() => undefined);
    await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
    await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status === "FAIL").length;
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exitCode = 1;
});
