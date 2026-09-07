/**
 * Notification Center — GET /v1/me/notifications — 10.10 §7.
 *
 * Requires: DATABASE_URL
 * Run: pnpm --filter @dodo/api test:notifications
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import cookieParser = require("cookie-parser");
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import {
  OrderStatus,
  PaymentStatus,
  RefundStatus,
  ReturnRequestStatus,
  ReturnType,
  TaxMode,
} from "@dodo/database";
import { NotificationsTestAppModule } from "./notifications-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { NOTIFICATION_TYPES } from "./notifications/notification.types";
import { encodeNotificationCursor } from "./notifications/notification-cursor";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };
type Notif = {
  id: string;
  type: string;
  title: string;
  occurredAt: string;
  deepLink: string;
  orderNumber: string;
};
type ListBody = { items: Notif[]; nextCursor: string | null };

const SELLER = {
  legalName: "NC Test UG",
  line1: "Test 1",
  postalCode: "10115",
  city: "Berlin",
  countryCode: "DE",
};

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
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

function asList(body: unknown): ListBody {
  if (!body || typeof body !== "object") {
    throw new Error(`expected list body, got ${JSON.stringify(body)}`);
  }
  const b = body as Partial<ListBody>;
  if (!Array.isArray(b.items)) {
    throw new Error(`expected items[], got ${JSON.stringify(body)}`);
  }
  return { items: b.items as Notif[], nextCursor: (b.nextCursor ?? null) as string | null };
}

function dtoKeysOk(n: Notif): boolean {
  const keys = Object.keys(n).sort();
  return (
    keys.join(",") === "deepLink,id,occurredAt,orderNumber,title,type" &&
    typeof n.id === "string" &&
    typeof n.type === "string" &&
    typeof n.title === "string" &&
    typeof n.occurredAt === "string" &&
    typeof n.deepLink === "string" &&
    typeof n.orderNumber === "string"
  );
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const pass = (id: string, note?: string) => results.push({ id, status: "PASS", note });
  const fail = (id: string, note?: string) => results.push({ id, status: "FAIL", note });

  const app = await NestFactory.create(NotificationsTestAppModule, { logger: false });
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

  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdPaymentMethodIds: string[] = [];

  const registerUser = async (locale = "de"): Promise<{ bearer: string; userId: string }> => {
    const user = await prisma.user.create({
      data: {
        email: `nc_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
        passwordHash: `hash_${randomBytes(8).toString("hex")}`,
        locale,
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: randomBytes(16).toString("hex"),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    const jwt = app.get(JwtService);
    const bearer = await jwt.signAsync({
      sub: user.id,
      sid: session.id,
      roles: ["CUSTOMER"],
    });
    return { bearer, userId: user.id };
  };

  const baseOrderData = (userId: string | null, orderNumber: string, extra: Record<string, unknown> = {}) => ({
    orderNumber,
    userId,
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
    grandTotal: "10.00",
    shippingMethodCodeSnapshot: "standard",
    shippingStandardAmountSnapshot: "0.00",
    shippingAddressJson: { line1: "NC" },
    billingAddressJson: { line1: "NC" },
    sellerIdentitySnapshotJson: SELLER,
    ...extra,
  });

  let pmId: string | null = null;
  const ensurePaymentMethod = async (): Promise<string> => {
    if (pmId) return pmId;
    const pm = await prisma.paymentMethod.upsert({
      where: { code: "nc_test_pm" },
      create: { code: "nc_test_pm", provider: "stripe", isEnabled: true, sortOrder: 99 },
      update: { isEnabled: true },
    });
    pmId = pm.id;
    createdPaymentMethodIds.push(pm.id);
    return pm.id;
  };

  try {
    // NC0 — no NC-specific @Throttle (global AppModule 120/60s only)
    {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const base = path.join(__dirname, "notifications", "notifications.controller");
      const srcPath = fs.existsSync(`${base}.js`) ? `${base}.js` : `${base}.ts`;
      const src = fs.readFileSync(srcPath, "utf8");
      if (!src.includes("@Throttle") && !src.includes("@nestjs/throttler")) {
        pass("NC0 no endpoint-specific throttle");
      } else {
        fail("NC0 no endpoint-specific throttle");
      }
    }

    // NC1 — 401 unauthenticated
    {
      const res = await call(server, "GET", "/v1/me/notifications");
      if (res.status === 401) pass("NC1 auth 401");
      else fail("NC1 auth 401", `status=${res.status}`);
    }

    // NC2 — empty list for new user
    {
      const { bearer } = await registerUser();
      const res = await call(server, "GET", "/v1/me/notifications", { bearer });
      const body = asList(res.body);
      if (res.status === 200 && body.items.length === 0 && body.nextCursor === null) {
        pass("NC2 empty 200");
      } else fail("NC2 empty 200", JSON.stringify(res.body));
    }

    const userA = await registerUser("de");
    const userB = await registerUser("en");

    // Shared timestamps for tie-break tests
    const t1 = new Date("2026-01-10T12:00:00.000Z");
    const t2 = new Date("2026-01-11T12:00:00.000Z");
    const t3 = new Date("2026-01-12T12:00:00.000Z");

    // Order A1 — placement + delivered + shipment + invoice + refund SUCCEEDED + return + CANCELLED sibling later
    const orderA1 = await prisma.order.create({
      data: {
        ...baseOrderData(userA.userId, `NC-A1-${stamp}`, {
          placedAt: t1,
          status: OrderStatus.DELIVERED,
          deliveredAt: t3,
          paymentStatus: PaymentStatus.PAID,
        }),
      },
    });
    createdOrderIds.push(orderA1.id);

    const ship = await prisma.shipment.create({
      data: {
        orderId: orderA1.id,
        carrier: "dhl",
        trackingNumber: `NC-TRK-${stamp}`,
        shippedAt: t2,
      },
    });

    const invIssued = await prisma.invoice.create({
      data: {
        orderId: orderA1.id,
        invoiceNumber: `NC-INV-${stamp}-1`,
        issuedAt: t2,
        pdfObjectKey: null,
        grandTotalSnapshot: "10.00",
        buyerSnapshotJson: { line1: "B" },
        sellerSnapshotJson: SELLER,
        status: "issued",
      },
    });

    const invCn = await prisma.invoice.create({
      data: {
        orderId: orderA1.id,
        invoiceNumber: `NC-INV-${stamp}-2`,
        issuedAt: t3,
        pdfObjectKey: null,
        grandTotalSnapshot: "10.00",
        buyerSnapshotJson: { line1: "B" },
        sellerSnapshotJson: SELLER,
        status: "cancelled_by_credit_note",
      },
    });

    const pm = await ensurePaymentMethod();
    const payment = await prisma.payment.create({
      data: {
        orderId: orderA1.id,
        paymentMethodId: pm,
        provider: "stripe",
        providerIntentId: `nc_pi_${stamp}`,
        amount: "10.00",
        currencyCode: "EUR",
        status: PaymentStatus.PAID,
      },
    });

    const refundOk = await prisma.refund.create({
      data: {
        orderId: orderA1.id,
        paymentId: payment.id,
        amount: "5.00",
        currencyCode: "EUR",
        status: RefundStatus.SUCCEEDED,
        reason: "partial",
        completedAt: t3,
        createdAt: t2,
      },
    });

    const refundPending = await prisma.refund.create({
      data: {
        orderId: orderA1.id,
        paymentId: payment.id,
        amount: "1.00",
        currencyCode: "EUR",
        status: RefundStatus.PENDING,
        reason: "pending-must-not-appear",
        createdAt: t3,
      },
    });

    const ret = await prisma.returnRequest.create({
      data: {
        orderId: orderA1.id,
        userId: userA.userId,
        type: ReturnType.WIDERRUF,
        status: ReturnRequestStatus.APPROVED,
        orderPriorStatus: OrderStatus.DELIVERED,
        returnAddressSnapshotJson: { line1: "R" },
        returnInstructionsSnapshot: "box",
        returnLocale: "de",
        createdAt: t2,
      },
    });

    // Shipment without shippedAt — must not appear
    await prisma.shipment.create({
      data: {
        orderId: orderA1.id,
        carrier: "ups",
        trackingNumber: `NC-NOSHIP-${stamp}`,
        shippedAt: null,
      },
    });

    // CANCELLED order for user A — still order_confirmed, never order_cancelled type
    const orderCancel = await prisma.order.create({
      data: {
        ...baseOrderData(userA.userId, `NC-CX-${stamp}`, {
          placedAt: new Date("2026-01-09T12:00:00.000Z"),
          status: OrderStatus.CANCELLED,
        }),
      },
    });
    createdOrderIds.push(orderCancel.id);

    // User B order — isolation
    const orderB = await prisma.order.create({
      data: {
        ...baseOrderData(userB.userId, `NC-B1-${stamp}`, {
          placedAt: t1,
        }),
      },
    });
    createdOrderIds.push(orderB.id);

    // Guest order — must not appear for A
    const orderGuest = await prisma.order.create({
      data: {
        ...baseOrderData(null, `NC-G1-${stamp}`, {
          placedAt: t1,
          guestEmail: `nc_guest_${stamp}@test.local`,
        }),
      },
    });
    createdOrderIds.push(orderGuest.id);

    // NC3 — six types present; order_cancelled absent; predicates
    {
      const res = await call(server, "GET", "/v1/me/notifications?limit=50", { bearer: userA.bearer });
      const body = asList(res.body);
      const types = new Set(body.items.map((i) => i.type));
      const ids = new Set(body.items.map((i) => i.id));
      const ok =
        res.status === 200 &&
        types.has("order_confirmed") &&
        types.has("shipped") &&
        types.has("delivered") &&
        types.has("invoice") &&
        types.has("refund") &&
        types.has("return") &&
        !types.has("order_cancelled") &&
        ids.has(`order_confirmed:${orderA1.id}`) &&
        ids.has(`order_confirmed:${orderCancel.id}`) &&
        ids.has(`shipped:${ship.id}`) &&
        ids.has(`delivered:${orderA1.id}`) &&
        ids.has(`invoice:${invIssued.id}`) &&
        ids.has(`invoice:${invCn.id}`) &&
        ids.has(`refund:${refundOk.id}`) &&
        !ids.has(`refund:${refundPending.id}`) &&
        ids.has(`return:${ret.id}`) &&
        body.items.every((i) => (NOTIFICATION_TYPES as readonly string[]).includes(i.type)) &&
        body.items.every(dtoKeysOk) &&
        !body.items.some((i) => i.orderNumber === orderB.orderNumber) &&
        !body.items.some((i) => i.orderNumber === orderGuest.orderNumber);
      if (ok) pass("NC3 six types + predicates + isolation");
      else fail("NC3 six types + predicates + isolation", JSON.stringify({ types: [...types], ids: [...ids], status: res.status }));
    }

    // NC4 — deepLinks + stable ids + de titles
    {
      const res = await call(server, "GET", "/v1/me/notifications?limit=50", { bearer: userA.bearer });
      const body = asList(res.body);
      const byType = Object.fromEntries(body.items.map((i) => [i.id, i]));
      const oc = byType[`order_confirmed:${orderA1.id}`];
      const sh = byType[`shipped:${ship.id}`];
      const inv = byType[`invoice:${invIssued.id}`];
      const rf = byType[`refund:${refundOk.id}`];
      const rt = byType[`return:${ret.id}`];
      const ok =
        oc?.deepLink === `/account/orders/${orderA1.orderNumber}` &&
        sh?.deepLink === `/account/orders/${orderA1.orderNumber}` &&
        inv?.deepLink === "/account/invoices" &&
        rf?.deepLink === `/account/orders/${orderA1.orderNumber}` &&
        rt?.deepLink === "/account/returns" &&
        oc?.title === "Ihre Bestellung wurde bestätigt";
      if (ok) pass("NC4 deepLinks + de title");
      else fail("NC4 deepLinks + de title", JSON.stringify({ oc, sh, inv }));
    }

    // NC5 — ordering + equal-timestamp tie-break (type ASC then id ASC)
    {
      const res = await call(server, "GET", "/v1/me/notifications?limit=50", { bearer: userA.bearer });
      const body = asList(res.body);
      let ordered = true;
      for (let i = 1; i < body.items.length; i++) {
        const a = body.items[i - 1]!;
        const b = body.items[i]!;
        if (a.occurredAt < b.occurredAt) {
          ordered = false;
          break;
        }
        if (a.occurredAt === b.occurredAt) {
          if (a.type > b.type || (a.type === b.type && a.id > b.id)) {
            ordered = false;
            break;
          }
        }
      }
      // At t2: invoice, refund? no refund at t2 completed is t3; at t2: shipped, return, invoice(issued)
      const atT2 = body.items.filter((i) => i.occurredAt === t2.toISOString());
      const t2Types = atT2.map((i) => i.type);
      const t2Sorted = [...t2Types].sort();
      if (ordered && t2Types.join(",") === t2Sorted.join(",")) pass("NC5 ordering + tie-break");
      else fail("NC5 ordering + tie-break", JSON.stringify({ t2Types, ordered }));
    }

    // NC6 — cross-user: B sees only own
    {
      const res = await call(server, "GET", "/v1/me/notifications", { bearer: userB.bearer });
      const body = asList(res.body);
      const ok =
        res.status === 200 &&
        body.items.length === 1 &&
        body.items[0]!.id === `order_confirmed:${orderB.id}` &&
        body.items[0]!.title === "Your order was confirmed";
      if (ok) pass("NC6 cross-user + en locale");
      else fail("NC6 cross-user + en locale", JSON.stringify(body));
    }

    // NC7 — ar locale + invalid locale fallback
    {
      await prisma.user.update({ where: { id: userA.userId }, data: { locale: "ar" } });
      const resAr = await call(server, "GET", "/v1/me/notifications?limit=1", { bearer: userA.bearer });
      const arTitle = asList(resAr.body).items[0]?.title;
      await prisma.user.update({ where: { id: userA.userId }, data: { locale: "xx" } });
      // Re-issue session still valid; AuthUser.locale loaded from DB each request
      const resXx = await call(server, "GET", "/v1/me/notifications?limit=1", { bearer: userA.bearer });
      const xxTitle = asList(resXx.body).items[0]?.title;
      await prisma.user.update({ where: { id: userA.userId }, data: { locale: "de" } });
      if (arTitle === "تم تأكيد طلبك" || (arTitle && arTitle.includes("تأكيد"))) {
        // first item may not be order_confirmed due to sort — check any ar title from map
      }
      const arOk = asList(resAr.body).items.some((i) =>
        ["تم تأكيد طلبك", "تم شحن طلبك", "تم تسليم طلبك", "تم إصدار فاتورتك", "تم تنفيذ الاسترداد", "تم استلام طلب الإرجاع"].includes(i.title),
      );
      const xxOk = asList(resXx.body).items.some((i) =>
        [
          "Ihre Bestellung wurde bestätigt",
          "Ihre Bestellung wurde versandt",
          "Ihre Bestellung wurde zugestellt",
          "Ihre Rechnung wurde ausgestellt",
          "Ihre Erstattung wurde ausgeführt",
          "Ihre Rücksendung wurde angefordert",
        ].includes(i.title),
      );
      if (arOk && xxOk) pass("NC7 ar + invalid→de");
      else fail("NC7 ar + invalid→de", JSON.stringify({ arTitle, xxTitle, arOk, xxOk }));
    }

    // NC8 — default limit 20
    {
      const bulkUser = await registerUser();
      for (let i = 0; i < 25; i++) {
        const o = await prisma.order.create({
          data: {
            ...baseOrderData(bulkUser.userId, `NC-BULK-${stamp}-${i}`, {
              placedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)),
            }),
          },
        });
        createdOrderIds.push(o.id);
      }
      const res = await call(server, "GET", "/v1/me/notifications", { bearer: bulkUser.bearer });
      const body = asList(res.body);
      if (res.status === 200 && body.items.length === 20 && typeof body.nextCursor === "string") {
        pass("NC8 default limit 20");
      } else fail("NC8 default limit 20", `len=${body.items?.length} cursor=${body.nextCursor}`);
    }

    // NC9 — max 50 + invalid limits
    {
      const { bearer } = await registerUser();
      const bad = await call(server, "GET", "/v1/me/notifications?limit=51", { bearer });
      const zero = await call(server, "GET", "/v1/me/notifications?limit=0", { bearer });
      const ok50 = await call(server, "GET", "/v1/me/notifications?limit=50", { bearer });
      if (bad.status === 400 && zero.status === 400 && ok50.status === 200) {
        pass("NC9 limit validation");
      } else fail("NC9 limit validation", `bad=${bad.status} zero=${zero.status} ok50=${ok50.status}`);
    }

    // NC10 — malformed cursor
    {
      const { bearer } = await registerUser();
      const res = await call(server, "GET", "/v1/me/notifications?cursor=not-a-cursor", { bearer });
      if (res.status === 400) pass("NC10 malformed cursor 400");
      else fail("NC10 malformed cursor 400", `status=${res.status}`);
    }

    // NC11 — cursor continuation strict keyset
    {
      const { bearer, userId } = await registerUser();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const o = await prisma.order.create({
          data: {
            ...baseOrderData(userId, `NC-CUR-${stamp}-${i}`, {
              placedAt: new Date(Date.UTC(2024, 5, 1, 12, 0, i)),
            }),
          },
        });
        createdOrderIds.push(o.id);
        ids.push(o.id);
      }
      const page1 = asList(
        (await call(server, "GET", "/v1/me/notifications?limit=2", { bearer })).body,
      );
      const page2 = asList(
        (
          await call(server, "GET", `/v1/me/notifications?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, {
            bearer,
          })
        ).body,
      );
      const page1Ids = page1.items.map((i) => i.id);
      const page2Ids = page2.items.map((i) => i.id);
      const overlap = page1Ids.some((id) => page2Ids.includes(id));
      const ok =
        page1.items.length === 2 &&
        page2.items.length === 2 &&
        !overlap &&
        page1.nextCursor != null &&
        page1.items[0]!.occurredAt >= page1.items[1]!.occurredAt &&
        page2.items[0]!.occurredAt <= page1.items[1]!.occurredAt;
      if (ok) pass("NC11 cursor continuation");
      else fail("NC11 cursor continuation", JSON.stringify({ page1Ids, page2Ids }));
    }

    // NC12 — forged cursor with foreign id still only returns owned (no leak)
    {
      const forged = encodeNotificationCursor({
        occurredAt: "2099-01-01T00:00:00.000Z",
        type: "order_confirmed",
        id: `order_confirmed:${orderB.id}`,
      });
      const res = await call(
        server,
        "GET",
        `/v1/me/notifications?cursor=${encodeURIComponent(forged)}`,
        { bearer: userA.bearer },
      );
      const body = asList(res.body);
      const ok =
        res.status === 200 &&
        !body.items.some((i) => i.orderNumber === orderB.orderNumber) &&
        !body.items.some((i) => i.id.includes(orderB.id));
      if (ok) pass("NC12 cursor cannot leak foreign orders");
      else fail("NC12 cursor cannot leak foreign orders", JSON.stringify(body.items.slice(0, 3)));
    }

    // NC13 — cardinality once per source
    {
      const res = await call(server, "GET", "/v1/me/notifications?limit=50", { bearer: userA.bearer });
      const body = asList(res.body);
      const count = (id: string) => body.items.filter((i) => i.id === id).length;
      const ok =
        count(`order_confirmed:${orderA1.id}`) === 1 &&
        count(`shipped:${ship.id}`) === 1 &&
        count(`return:${ret.id}`) === 1 &&
        count(`refund:${refundOk.id}`) === 1;
      if (ok) pass("NC13 cardinality once");
      else fail("NC13 cardinality once");
    }
  } catch (e) {
    fail("NC-FATAL", e instanceof Error ? e.message : String(e));
  } finally {
    try {
      await prisma.refund.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.returnRequest.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.shipment.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.invoice.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    } catch {
      /* best-effort cleanup */
    }
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length) {
    process.exitCode = 1;
  } else {
    console.log(`\nALL ${results.length} PASS`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
