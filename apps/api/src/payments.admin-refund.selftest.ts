/**
 * Execute W3 Admin Refund HTTP — §4e (+ §4f key / Persist reuse).
 * SoT: docs/10.9-payments-webhooks.md §4e
 *
 * Requires: DATABASE_URL (+ seed Role ADMIN/OWNER/SUPPORT)
 * Run: pnpm --filter @dodo/api test:admin-refund
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
import { RoleCode } from "@dodo/shared-types";
import {
  BonusLedgerType,
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
  TaxMode,
  ActorType,
} from "@dodo/database";
import { AdminRefundTestAppModule } from "./payments.admin-refund-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { hashPassword } from "./auth/crypto.util";
import { InMemoryRefundProviders } from "./payments/in-memory.refund-provider";
import { IDEMPOTENCY_KEY_HEADER } from "./admin-http-idempotency/admin-http-idempotency.key";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

const ADMIN_PASSWORD = "AdminRefund1!";
const IDS = [
  "AR1_create_full_succeeded",
  "AR2_list_get",
  "AR3_support_forbidden_create",
  "AR4_support_can_list",
  "AR5_wrong_password",
  "AR6_missing_confirmed",
  "AR7_idempotency_replay",
  "AR8_amount_exceeds",
  "AR9_provider_reject_failed_200",
  "AR10_retry_new_row",
  "AR11_cancel_pending",
  "AR12_r22d_via_http_succeeded",
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
  opts?: { bearer?: string; json?: unknown; idempotencyKey?: string },
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
          ...(opts?.idempotencyKey
            ? { [IDEMPOTENCY_KEY_HEADER]: opts.idempotencyKey }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            body = raw;
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

async function main(): Promise<void> {
  console.log("Focused Verification — W3 Admin Refund HTTP (§4e)\n");
  const results: Result[] = [];
  const stamp = `${Date.now()}`;

  let app;
  try {
    app = await NestFactory.create(AdminRefundTestAppModule, { logger: ["error"] });
  } catch (e) {
    console.error("NestFactory.create failed:", e);
    process.exit(1);
  }
  app.setGlobalPrefix("v1");
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0);
  const server = app.getHttpServer() as Server;
  const prisma = app.get(PrismaService);
  const jwt = app.get(JwtService);
  const mem = app.get(InMemoryRefundProviders);

  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  const paymentMethod = await prisma.paymentMethod.upsert({
    where: { code: "stripe" },
    create: { code: "stripe", provider: "stripe", isEnabled: true, sortOrder: 1 },
    update: { isEnabled: true },
  });

  const staffUser = async (code: RoleCode, password?: string) => {
    const role = await prisma.role.findUniqueOrThrow({ where: { code } });
    const user = await prisma.user.create({
      data: {
        email: `ar4e_${code}_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
        passwordHash: password
          ? await hashPassword(password)
          : `hash_${randomBytes(8).toString("hex")}`,
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

  const seedPaidOrder = async (opts?: { earn?: number; grandTotal?: string }) => {
    const grandTotal = opts?.grandTotal ?? "50.00";
    const earn = opts?.earn ?? 0;
    const user = await prisma.user.create({
      data: {
        email: `ar4e_cust_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
        passwordHash: `hash_${randomBytes(8).toString("hex")}`,
        locale: "de",
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);
    let accountId: string | null = null;
    if (earn > 0) {
      const acct = await prisma.bonusAccount.create({
        data: { userId: user.id, balanceCached: earn },
      });
      accountId = acct.id;
    }
    const order = await prisma.order.create({
      data: {
        orderNumber: `AR4E-${stamp}-${randomBytes(3).toString("hex")}`,
        userId: user.id,
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        currencyCode: "EUR",
        locale: "de",
        shippingCountryCode: "DE",
        taxMode: TaxMode.KLEINUNTERNEHMER,
        companyIsKleinunternehmer: true,
        invoiceExemptionTextSnapshot: "§19",
        itemsSubtotal: grandTotal,
        shippingTotal: "0.00",
        discountCoupon: "0.00",
        discountBonus: "0.00",
        grandTotal,
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: "0.00",
        shippingAddressJson: { line1: "AR4E" },
        billingAddressJson: { line1: "AR4E" },
        sellerIdentitySnapshotJson: {
          legalName: "AR4E UG",
          line1: "Test 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        paymentMethodCodeSnapshot: "stripe",
        bonusPointsEarned: earn > 0 ? earn : undefined,
        confirmedAt: new Date(),
      },
    });
    createdOrderIds.push(order.id);
    if (earn > 0 && accountId) {
      await prisma.bonusLedger.create({
        data: {
          accountId,
          type: BonusLedgerType.EARN,
          points: earn,
          orderId: order.id,
          idempotencyKey: `earn:${order.id}`,
          actorType: ActorType.SYSTEM,
        },
      });
    }
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        paymentMethodId: paymentMethod.id,
        provider: "stripe",
        providerIntentId: `pi_ar4e_${order.id}`,
        amount: new Prisma.Decimal(grandTotal),
        currencyCode: "EUR",
        status: PaymentStatus.PAID,
      },
    });
    return { orderId: order.id, paymentId: payment.id, userId: user.id, accountId, grandTotal };
  };

  const run = async (id: (typeof IDS)[number], fn: () => Promise<void>) => {
    try {
      mem.reset();
      await fn();
      results.push({ id, status: "PASS" });
      console.log(`  ✓ ${id}`);
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      results.push({ id, status: "FAIL", note });
      console.error(`  ✗ ${id}: ${note}`);
    }
  };

  const admin = await staffUser(RoleCode.ADMIN, ADMIN_PASSWORD);
  const support = await staffUser(RoleCode.SUPPORT);

  try {
    await run("AR1_create_full_succeeded", async () => {
      const o = await seedPaidOrder({ grandTotal: "40.00" });
      const key = `ik-ar1-${randomBytes(6).toString("hex")}`;
      const res = await call(server, "POST", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: admin.bearer,
        idempotencyKey: key,
        json: { full: true, confirmed: true, currentPassword: ADMIN_PASSWORD },
      });
      if (res.status !== 200) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
      const body = res.body as { status?: string; amount?: string; orderPaymentStatus?: string };
      if (body.status !== "SUCCEEDED") throw new Error(`status=${body.status}`);
      if (body.amount !== "40.00") throw new Error(`amount=${body.amount}`);
      if (body.orderPaymentStatus !== PaymentStatus.REFUNDED) {
        throw new Error(`paymentStatus=${body.orderPaymentStatus}`);
      }
    });

    await run("AR2_list_get", async () => {
      const o = await seedPaidOrder({ grandTotal: "25.00" });
      const key = `ik-ar2-${randomBytes(6).toString("hex")}`;
      const created = await call(server, "POST", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: admin.bearer,
        idempotencyKey: key,
        json: {
          amount: "10.00",
          confirmed: true,
          currentPassword: ADMIN_PASSWORD,
        },
      });
      if (created.status !== 200) throw new Error(`create ${created.status}`);
      const id = (created.body as { id: string }).id;
      const list = await call(server, "GET", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: admin.bearer,
      });
      if (list.status !== 200) throw new Error(`list ${list.status}`);
      const items = (list.body as { items: unknown[] }).items;
      if (!Array.isArray(items) || items.length < 1) throw new Error("items");
      const get = await call(server, "GET", `/v1/admin/refunds/${id}`, { bearer: admin.bearer });
      if (get.status !== 200) throw new Error(`get ${get.status}`);
      if ((get.body as { id: string }).id !== id) throw new Error("id mismatch");
    });

    await run("AR3_support_forbidden_create", async () => {
      const o = await seedPaidOrder();
      const res = await call(server, "POST", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: support.bearer,
        idempotencyKey: `ik-ar3-${randomBytes(6).toString("hex")}`,
        json: { full: true, confirmed: true, currentPassword: "x" },
      });
      if (res.status !== 403) throw new Error(`expected 403 got ${res.status}`);
      if (errCode(res.body) !== "FORBIDDEN") throw new Error(`code=${errCode(res.body)}`);
    });

    await run("AR4_support_can_list", async () => {
      const o = await seedPaidOrder();
      const res = await call(server, "GET", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: support.bearer,
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
    });

    await run("AR5_wrong_password", async () => {
      const o = await seedPaidOrder();
      const before = await prisma.refund.count({ where: { orderId: o.orderId } });
      const res = await call(server, "POST", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: admin.bearer,
        idempotencyKey: `ik-ar5-${randomBytes(6).toString("hex")}`,
        json: { full: true, confirmed: true, currentPassword: "WrongPass!" },
      });
      if (res.status !== 401) throw new Error(`expected 401 got ${res.status}`);
      if (errCode(res.body) !== "INVALID_PASSWORD") throw new Error(`code=${errCode(res.body)}`);
      const after = await prisma.refund.count({ where: { orderId: o.orderId } });
      if (after !== before) throw new Error("refund row created on bad password");
    });

    await run("AR6_missing_confirmed", async () => {
      const o = await seedPaidOrder();
      const res = await call(server, "POST", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: admin.bearer,
        idempotencyKey: `ik-ar6-${randomBytes(6).toString("hex")}`,
        json: { full: true, currentPassword: ADMIN_PASSWORD },
      });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
    });

    await run("AR7_idempotency_replay", async () => {
      const o = await seedPaidOrder({ grandTotal: "30.00" });
      const key = `ik-ar7-${randomBytes(6).toString("hex")}`;
      const body = { amount: "5.00", confirmed: true, currentPassword: ADMIN_PASSWORD };
      const a = await call(server, "POST", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: admin.bearer,
        idempotencyKey: key,
        json: body,
      });
      const b = await call(server, "POST", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: admin.bearer,
        idempotencyKey: key,
        json: body,
      });
      if (a.status !== 200 || b.status !== 200) throw new Error("status");
      if ((a.body as { id: string }).id !== (b.body as { id: string }).id) {
        throw new Error("replay id mismatch");
      }
      const count = await prisma.refund.count({ where: { orderId: o.orderId } });
      if (count !== 1) throw new Error(`count=${count}`);
    });

    await run("AR8_amount_exceeds", async () => {
      const o = await seedPaidOrder({ grandTotal: "10.00" });
      const res = await call(server, "POST", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: admin.bearer,
        idempotencyKey: `ik-ar8-${randomBytes(6).toString("hex")}`,
        json: { amount: "99.00", confirmed: true, currentPassword: ADMIN_PASSWORD },
      });
      if (res.status !== 409) throw new Error(`expected 409 got ${res.status}`);
      if (errCode(res.body) !== "REFUND_AMOUNT_EXCEEDS_REMAINING") {
        throw new Error(`code=${errCode(res.body)}`);
      }
    });

    await run("AR9_provider_reject_failed_200", async () => {
      mem.mode = "reject";
      const o = await seedPaidOrder({ grandTotal: "12.00" });
      const res = await call(server, "POST", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: admin.bearer,
        idempotencyKey: `ik-ar9-${randomBytes(6).toString("hex")}`,
        json: { full: true, confirmed: true, currentPassword: ADMIN_PASSWORD },
      });
      if (res.status !== 200) throw new Error(`expected 200 got ${res.status}`);
      if ((res.body as { status: string }).status !== "FAILED") {
        throw new Error(`status=${(res.body as { status: string }).status}`);
      }
    });

    await run("AR10_retry_new_row", async () => {
      mem.mode = "reject";
      const o = await seedPaidOrder({ grandTotal: "18.00" });
      const failed = await call(server, "POST", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: admin.bearer,
        idempotencyKey: `ik-ar10a-${randomBytes(6).toString("hex")}`,
        json: { full: true, confirmed: true, currentPassword: ADMIN_PASSWORD },
      });
      const failedId = (failed.body as { id: string }).id;
      mem.mode = "succeed";
      const retry = await call(server, "POST", `/v1/admin/refunds/${failedId}/retry`, {
        bearer: admin.bearer,
        idempotencyKey: `ik-ar10b-${randomBytes(6).toString("hex")}`,
        json: { confirmed: true, currentPassword: ADMIN_PASSWORD },
      });
      if (retry.status !== 200) throw new Error(`${retry.status} ${JSON.stringify(retry.body)}`);
      const newId = (retry.body as { id: string }).id;
      if (newId === failedId) throw new Error("retry must create sibling");
      if ((retry.body as { status: string }).status !== "SUCCEEDED") {
        throw new Error(`status=${(retry.body as { status: string }).status}`);
      }
    });

    await run("AR11_cancel_pending", async () => {
      mem.mode = "pending";
      const o = await seedPaidOrder({ grandTotal: "22.00" });
      // Force create to leave PENDING without providerRefundId: use pending mode but
      // in-memory pending stores an id — cancel would be unsafe. Seed PENDING manually.
      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: o.orderId } });
      const refund = await prisma.refund.create({
        data: {
          orderId: o.orderId,
          paymentId: payment.id,
          amount: new Prisma.Decimal("5.00"),
          currencyCode: "EUR",
          status: RefundStatus.PENDING,
          reason: "cancel-test",
        },
      });
      mem.reset();
      mem.mode = "succeed"; // reconcile finds nothing → pending no id → cancel safe
      const res = await call(server, "POST", `/v1/admin/refunds/${refund.id}/cancel`, {
        bearer: admin.bearer,
        idempotencyKey: `ik-ar11-${randomBytes(6).toString("hex")}`,
        json: { confirmed: true, currentPassword: ADMIN_PASSWORD },
      });
      if (res.status !== 200) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
      if ((res.body as { status: string }).status !== "CANCELLED") {
        throw new Error(`status=${(res.body as { status: string }).status}`);
      }
    });

    await run("AR12_r22d_via_http_succeeded", async () => {
      const o = await seedPaidOrder({ grandTotal: "100.00", earn: 100 });
      const res = await call(server, "POST", `/v1/admin/orders/${o.orderId}/refunds`, {
        bearer: admin.bearer,
        idempotencyKey: `ik-ar12-${randomBytes(6).toString("hex")}`,
        json: { full: true, confirmed: true, currentPassword: ADMIN_PASSWORD },
      });
      if (res.status !== 200) throw new Error(`${res.status}`);
      if ((res.body as { status: string }).status !== "SUCCEEDED") throw new Error("not succeeded");
      const claw = await prisma.bonusLedger.findFirst({
        where: {
          orderId: o.orderId,
          type: BonusLedgerType.CLAWBACK,
        },
      });
      if (!claw || claw.points !== -100) throw new Error(`clawback=${claw?.points}`);
      if (!o.accountId) throw new Error("account");
      const acct = await prisma.bonusAccount.findUniqueOrThrow({ where: { id: o.accountId } });
      if (acct.balanceCached !== 0) throw new Error(`balance=${acct.balanceCached}`);
    });
  } finally {
    await prisma.refund.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
    await prisma.payment.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
    await prisma.bonusLedger.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => undefined);
    await prisma.bonusAccount.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
    await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== IDS.length) {
    console.log(`\nAdmin refund HTTP: FAIL (${results.filter((r) => r.status === "PASS").length}/${IDS.length})`);
    process.exit(1);
  }
  console.log(`\nAdmin refund HTTP: ${results.length}/${IDS.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
