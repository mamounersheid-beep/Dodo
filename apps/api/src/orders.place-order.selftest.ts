/**
 * Production placeOrder core Tx — POST /v1/orders.
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory, DE shipping, LegalPages, SAVE5)
 * Run (after build): node dist/orders.place-order.selftest.js
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { OrdersPlaceOrderTestAppModule, placeOrderEmailCalls } from "./orders.place-order-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { GUEST_KEY_HEADER } from "./cart/cart.types";
import { CHECKOUT_KEY_HEADER } from "./orders/checkout-key.transport";
import { UNPAID_ORDER_TTL_MS } from "./inventory/inventory.constants";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown; headers: IncomingHttpHeaders };

const IDS = [
  "PO1",
  "PO2",
  "PO3",
  "PO4",
  "PO5",
  "PO6",
  "PO7",
  "PO8",
  "PO9",
  "PO10",
  "PO11",
  "PO12",
  "PO13",
] as const;

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function mintCheckoutKey(): string {
  return randomBytes(32).toString("base64url");
}

function errCode(body: unknown): string | undefined {
  return (body as { code?: string; error?: string })?.code
    ?? (body as { error?: string })?.error;
}

const EN_DASH = "\u2013";
const G3_SNAPSHOT_KEYS = [
  "disclosureLevel",
  "labelShown",
  "lieferzeitDaysMax",
  "lieferzeitDaysMin",
  "locale",
  "processingDaysMax",
  "processingDaysMin",
  "shippingMethodCode",
  "shippingRateId",
  "sources",
  "transitDaysMax",
  "transitDaysMin",
] as const;

function assertG3CompositeSnapshot(
  raw: unknown,
  expected: {
    processingMin: number;
    processingMax: number;
    transitMin: number;
    transitMax: number;
    shippingRateId: string;
    shippingMethodCode: string;
    locale: string;
  },
): void {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("G3 snapshot missing");
  }
  const snap = raw as Record<string, unknown>;
  const keys = Object.keys(snap).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...G3_SNAPSHOT_KEYS])) {
    throw new Error(`G3 keys ${keys.join(",")}`);
  }
  if (snap.disclosureLevel !== "composite") throw new Error("disclosureLevel");
  if ("isPreview" in snap) throw new Error("isPreview forbidden");
  if ("deliveryTimeDaysMin" in snap || "deliveryTimeDaysMax" in snap) {
    throw new Error("3g deliveryTimeDays* forbidden");
  }
  const lieferMin = expected.processingMin + expected.transitMin;
  const lieferMax = expected.processingMax + expected.transitMax;
  if (snap.processingDaysMin !== expected.processingMin) throw new Error("processingDaysMin");
  if (snap.processingDaysMax !== expected.processingMax) throw new Error("processingDaysMax");
  if (snap.transitDaysMin !== expected.transitMin) throw new Error("transitDaysMin");
  if (snap.transitDaysMax !== expected.transitMax) throw new Error("transitDaysMax");
  if (snap.lieferzeitDaysMin !== lieferMin) throw new Error("lieferzeitDaysMin");
  if (snap.lieferzeitDaysMax !== lieferMax) throw new Error("lieferzeitDaysMax");
  if (snap.labelShown !== `Lieferzeit: ${lieferMin}${EN_DASH}${lieferMax} Werktage`) {
    throw new Error(`labelShown ${String(snap.labelShown)}`);
  }
  if (snap.locale !== expected.locale) throw new Error(`locale ${String(snap.locale)}`);
  if (snap.shippingRateId !== expected.shippingRateId) throw new Error("shippingRateId");
  if (snap.shippingMethodCode !== expected.shippingMethodCode) throw new Error("shippingMethodCode");
  const sources = snap.sources as Record<string, unknown> | undefined;
  if (!sources || Object.keys(sources).sort().join(",") !== "processing,transit") {
    throw new Error("sources keys");
  }
  if (sources.processing !== "CompanySettings.orderProcessingDaysMin/Max") {
    throw new Error("sources.processing");
  }
  if (sources.transit !== "ShippingRate.estimatedTransitDaysMin/Max") {
    throw new Error("sources.transit");
  }
}

function assertIdBody(body: unknown): { id: string } {
  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["id"])) {
    throw new Error(`body keys ${keys.join(",")}`);
  }
  if (typeof obj.id !== "string" || !obj.id) throw new Error("id missing");
  const forbidden = [
    "orderNumber",
    "checkoutKey",
    "guestAccessToken",
    "guestToken",
    "clientSecret",
    "paymentIntent",
    "deliveryTime",
    "deliveryTimeDisclosureSnapshot",
  ];
  for (const k of forbidden) {
    if (k in obj) throw new Error(`${k} leaked`);
  }
  return { id: obj.id };
}

function deAddress() {
  return {
    name: "Ada Guest",
    line1: "Musterstraße 1",
    postalCode: "10115",
    city: "Berlin",
    countryCode: "DE",
  };
}

function placeBody(over: Record<string, unknown> = {}) {
  return {
    shippingAddressJson: deAddress(),
    billingAddressJson: deAddress(),
    paymentMethodCode: "stripe",
    acceptedAgb: true,
    acceptedWiderrufInfo: true,
    guestEmail: "guest-po@test.local",
    ...over,
  };
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
    json?: unknown;
  },
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
          ...(opts?.guestKey ? { [GUEST_KEY_HEADER]: opts.guestKey } : {}),
          ...(opts?.checkoutKey ? { [CHECKOUT_KEY_HEADER]: opts.checkoutKey } : {}),
          ...(opts?.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
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

  const app = await NestFactory.create(OrdersPlaceOrderTestAppModule, { logger: false });
  app.setGlobalPrefix("v1");
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0);
  const server = app.getHttpServer() as Server;
  const prisma = app.get(PrismaService);

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
  const onHand = inv.quantityOnHand;
  await prisma.inventory.update({
    where: { locationId_variantId: { locationId: location.id, variantId } },
    data: { quantityOnHand: Math.max(onHand, 80) },
  });

  const guestKey = () => {
    const k = `gk_po_${stamp}_${randomBytes(6).toString("hex")}`;
    createdCartGuestKeys.push(k);
    return k;
  };

  const checkoutKey = () => {
    const k = mintCheckoutKey();
    createdCheckoutKeys.push(k);
    return k;
  };

  const registerUser = async (): Promise<{ bearer: string; userId: string }> => {
    const email = `po_${stamp}_${randomBytes(4).toString("hex")}@test.local`;
    const res = await call(server, "POST", "/v1/auth/register", {
      json: { email, password: "Pass1234!", locale: "de" },
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`register ${res.status} ${JSON.stringify(res.body)}`);
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error("register: user not found");
    createdUserIds.push(user.id);
    const body = res.body as { accessToken?: string };
    if (!body.accessToken) throw new Error("register: no accessToken");
    return { bearer: body.accessToken, userId: user.id };
  };

  const addCart = async (opts: { guestKey?: string; bearer?: string; qty?: number }) => {
    const res = await call(server, "POST", "/v1/cart/items", {
      guestKey: opts.guestKey,
      bearer: opts.bearer,
      json: { variantId, quantity: opts.qty ?? 1 },
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`cart add ${res.status} ${JSON.stringify(res.body)}`);
    }
  };

  const reserve = async (opts: { guestKey?: string; bearer?: string; checkoutKey: string }) => {
    const res = await call(server, "POST", "/v1/orders/reserve", {
      guestKey: opts.guestKey,
      bearer: opts.bearer,
      checkoutKey: opts.checkoutKey,
      json: { variantId, quantity: 1 },
    });
    if (res.status !== 200) {
      throw new Error(`reserve ${res.status} ${JSON.stringify(res.body)}`);
    }
  };

  const place = (opts: {
    guestKey?: string;
    bearer?: string;
    checkoutKey: string;
    idempotencyKey: string;
    json?: Record<string, unknown>;
  }) =>
    call(server, "POST", "/v1/orders", {
      guestKey: opts.guestKey,
      bearer: opts.bearer,
      checkoutKey: opts.checkoutKey,
      idempotencyKey: opts.idempotencyKey,
      json: opts.json ?? placeBody(),
    });

  const track = (id: string) => {
    createdOrderIds.push(id);
    return id;
  };

  try {
    await run("PO1", async () => {
      placeOrderEmailCalls.length = 0;
      const gk = guestKey();
      const ck = checkoutKey();
      const ik = `ik-po1-${stamp}`;
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck });
      const res = await place({ guestKey: gk, checkoutKey: ck, idempotencyKey: ik });
      if (res.status !== 201) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const { id } = assertIdBody(res.body);
      track(id);
      if (res.headers.location) throw new Error("Location header present");
      if (placeOrderEmailCalls.length !== 1) {
        throw new Error(`email calls ${placeOrderEmailCalls.length}`);
      }
      if (placeOrderEmailCalls[0]?.orderId !== id) throw new Error("email orderId");
      const row = await prisma.order.findUnique({ where: { id } });
      if (row?.status !== "PLACED") throw new Error(`status ${row?.status}`);
      if (row?.paymentStatus !== "PENDING") throw new Error(`paymentStatus ${row?.paymentStatus}`);
      if ((await prisma.payment.count({ where: { orderId: id } })) !== 0) {
        throw new Error("Payment created in placeOrder slice");
      }
    });

    await run("PO2", async () => {
      const gk = guestKey();
      const ck1 = checkoutKey();
      const ik = `ik-po2-${stamp}`;
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck1 });
      const first = await place({ guestKey: gk, checkoutKey: ck1, idempotencyKey: ik });
      if (first.status !== 201) throw new Error(`first ${first.status}`);
      const id = track(assertIdBody(first.body).id);
      const before = {
        orders: await prisma.order.count({ where: { guestKey: gk } }),
        usages: await prisma.couponUsage.count({ where: { orderId: id } }),
        bound: await prisma.reservation.count({ where: { orderId: id } }),
      };
      const ck2 = checkoutKey();
      const replay = await place({ guestKey: gk, checkoutKey: ck2, idempotencyKey: ik });
      if (replay.status !== 201) throw new Error(`replay ${replay.status}`);
      if (assertIdBody(replay.body).id !== id) throw new Error("replay id differs");
      if ((await prisma.order.count({ where: { guestKey: gk } })) !== before.orders) {
        throw new Error("duplicate order on replay");
      }
      if ((await prisma.couponUsage.count({ where: { orderId: id } })) !== before.usages) {
        throw new Error("duplicate coupon usage");
      }
      if ((await prisma.reservation.count({ where: { orderId: id } })) !== before.bound) {
        throw new Error("second bind");
      }
    });

    await run("PO3", async () => {
      const gk = guestKey();
      const ck = checkoutKey();
      const ik = `ik-po3-${stamp}`;
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck });
      const first = await place({
        guestKey: gk,
        checkoutKey: ck,
        idempotencyKey: ik,
        json: placeBody({ guestEmail: "a-po3@test.local" }),
      });
      track(assertIdBody(first.body).id);
      const mismatch = await place({
        guestKey: gk,
        checkoutKey: checkoutKey(),
        idempotencyKey: ik,
        json: placeBody({ guestEmail: "b-po3@test.local" }),
      });
      if (mismatch.status !== 409) throw new Error(`expected 409 got ${mismatch.status}`);
      if (errCode(mismatch.body) !== "IDEMPOTENCY_PAYLOAD_MISMATCH") {
        throw new Error(`code=${errCode(mismatch.body)}`);
      }
    });

    await run("PO4", async () => {
      const ik = `ik-po4-${stamp}`;
      const a = guestKey();
      const b = guestKey();
      const cka = checkoutKey();
      const ckb = checkoutKey();
      await addCart({ guestKey: a });
      await addCart({ guestKey: b });
      await reserve({ guestKey: a, checkoutKey: cka });
      await reserve({ guestKey: b, checkoutKey: ckb });
      const ra = await place({ guestKey: a, checkoutKey: cka, idempotencyKey: ik });
      const rb = await place({
        guestKey: b,
        checkoutKey: ckb,
        idempotencyKey: ik,
        json: placeBody({ guestEmail: "po4-b@test.local" }),
      });
      const ida = track(assertIdBody(ra.body).id);
      const idb = track(assertIdBody(rb.body).id);
      if (ida === idb) throw new Error("same order across identities");
    });

    await run("PO5", async () => {
      const ik = `ik-po5-${stamp}`;
      const gk = guestKey();
      const { bearer } = await registerUser();
      const ckg = checkoutKey();
      const cku = checkoutKey();
      await addCart({ guestKey: gk });
      await addCart({ bearer });
      await reserve({ guestKey: gk, checkoutKey: ckg });
      await reserve({ bearer, checkoutKey: cku });
      const guest = await place({ guestKey: gk, checkoutKey: ckg, idempotencyKey: ik });
      const user = await place({
        bearer,
        checkoutKey: cku,
        idempotencyKey: ik,
        json: {
          shippingAddressJson: deAddress(),
          billingAddressJson: deAddress(),
          paymentMethodCode: "stripe",
          acceptedAgb: true,
          acceptedWiderrufInfo: true,
        },
      });
      const gid = track(assertIdBody(guest.body).id);
      const uid = track(assertIdBody(user.body).id);
      if (gid === uid) throw new Error("guest/registered collided");
    });

    await run("PO6", async () => {
      const gk = guestKey();
      const ck = checkoutKey();
      const ik = `ik-po6-${stamp}`;
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck });
      const absent = await place({
        guestKey: gk,
        checkoutKey: ck,
        idempotencyKey: ik,
        json: placeBody(),
      });
      const id = track(assertIdBody(absent.body).id);
      const row = await prisma.order.findUnique({ where: { id } });
      if (row?.bonusPointsToRedeem !== null) {
        throw new Error(`absent stored as ${row?.bonusPointsToRedeem}`);
      }
      const zero = await place({
        guestKey: gk,
        checkoutKey: checkoutKey(),
        idempotencyKey: ik,
        json: placeBody({ bonusPointsToRedeem: 0 }),
      });
      if (zero.status !== 409) throw new Error(`expected 409 for 0 vs absent, got ${zero.status}`);
    });

    await run("PO7", async () => {
      const gk = guestKey();
      const ck = checkoutKey();
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck });
      const res = await place({
        guestKey: gk,
        checkoutKey: ck,
        idempotencyKey: `ik-po7-${stamp}`,
      });
      const id = track(assertIdBody(res.body).id);
      const row = await prisma.order.findUnique({ where: { id } });
      if (row?.guestKey !== gk) throw new Error(`guestKey ${row?.guestKey}`);
      if (row?.userId !== null) throw new Error("registered userId on guest order");
      if (!row?.guestAccessTokenHash) throw new Error("guest hash missing");
    });

    await run("PO8", async () => {
      const gk = guestKey();
      const ck = checkoutKey();
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck });
      const before = Date.now();
      const res = await place({
        guestKey: gk,
        checkoutKey: ck,
        idempotencyKey: `ik-po8-${stamp}`,
      });
      const id = track(assertIdBody(res.body).id);
      const bound = await prisma.reservation.findMany({ where: { orderId: id } });
      if (bound.length < 1) throw new Error("no bound reservation");
      for (const row of bound) {
        if (row.checkoutKey !== null) throw new Error("checkoutKey not cleared");
        const ttl = row.expiresAt.getTime() - before;
        if (ttl < UNPAID_ORDER_TTL_MS - 5_000 || ttl > UNPAID_ORDER_TTL_MS + 15_000) {
          throw new Error(`bind TTL ${ttl}`);
        }
      }
    });

    await run("PO9", async () => {
      const gk = guestKey();
      const ck = checkoutKey();
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck });
      const res = await place({
        guestKey: gk,
        checkoutKey: ck,
        idempotencyKey: `ik-po9-${stamp}`,
        json: placeBody({ couponCode: "SAVE5" }),
      });
      const id = track(assertIdBody(res.body).id);
      const usages = await prisma.couponUsage.findMany({ where: { orderId: id } });
      if (usages.length !== 1) throw new Error(`usages ${usages.length}`);
      if (usages[0]!.releasedAt !== null) throw new Error("releasedAt set");
      if (usages[0]!.userId !== null) throw new Error("guest usage should have null userId");
      const ledgers = await prisma.bonusLedger.count({ where: { orderId: id } });
      if (ledgers !== 0) throw new Error("Bonus REDEEM at PLACED");
    });

    await run("PO10", async () => {
      const gk = guestKey();
      const ck = checkoutKey();
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck });
      const res = await place({
        guestKey: gk,
        checkoutKey: ck,
        idempotencyKey: `ik-po10-${stamp}`,
      });
      const id = track(assertIdBody(res.body).id);
      const row = await prisma.order.findUnique({ where: { id } });
      if (!row?.legalAgbVersionId || !row.legalAgbHash) throw new Error("agb evidence");
      if (!row.legalWiderrufVersionId || !row.legalWiderrufHash) throw new Error("widerruf evidence");
      if (!row.legalPrivacyVersionId || !row.legalPrivacyHash) throw new Error("privacy evidence");
      if (!row.acceptedAgbAt || !row.acceptedWiderrufInfoAt) throw new Error("accepted timestamps");
    });

    await run("PO11", async () => {
      const company = await prisma.companySettings.findUnique({ where: { id: "default" } });
      if (!company) throw new Error("company missing");
      const gk = guestKey();
      const ck = checkoutKey();
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck });
      const res = await place({
        guestKey: gk,
        checkoutKey: ck,
        idempotencyKey: `ik-po11-${stamp}`,
      });
      const id = track(assertIdBody(res.body).id);
      const row = await prisma.order.findUnique({ where: { id } });
      const snap = row?.sellerIdentitySnapshotJson as Record<string, unknown> | null;
      if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
        throw new Error("seller snapshot missing");
      }
      const expectedKeys = [
        "legalName",
        "line1",
        "postalCode",
        "city",
        "countryCode",
        "supportEmail",
        "supportPhone",
      ];
      const actualKeys = Object.keys(snap).sort();
      if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort())) {
        throw new Error(`seller snapshot keys ${actualKeys.join(",")}`);
      }
      if (snap.legalName !== company.legalName) throw new Error("seller legalName");
      if (snap.line1 !== company.line1) throw new Error("seller line1");
      if (snap.postalCode !== company.postalCode) throw new Error("seller postalCode");
      if (snap.city !== company.city) throw new Error("seller city");
      if (snap.countryCode !== company.countryCode) throw new Error("seller countryCode");
      if (snap.supportEmail !== company.supportEmail) throw new Error("seller supportEmail");
      if (snap.supportPhone !== company.supportPhone) throw new Error("seller supportPhone");
      if (company.orderProcessingDaysMin == null || company.orderProcessingDaysMax == null) {
        throw new Error("V1 processing days missing");
      }
      if (!row?.shippingRateId || !row.shippingMethodCodeSnapshot) {
        throw new Error("shipping identity missing");
      }
      const rate = await prisma.shippingRate.findUniqueOrThrow({
        where: { id: row.shippingRateId },
      });
      assertG3CompositeSnapshot(row.deliveryTimeDisclosureSnapshot, {
        processingMin: company.orderProcessingDaysMin,
        processingMax: company.orderProcessingDaysMax,
        transitMin: rate.estimatedTransitDaysMin,
        transitMax: rate.estimatedTransitDaysMax,
        shippingRateId: row.shippingRateId,
        shippingMethodCode: row.shippingMethodCodeSnapshot,
        locale: row.locale,
      });
    });

    await run("PO12", async () => {
      const gk = guestKey();
      const ck = checkoutKey();
      const ik = `ik-po12-${stamp}`;
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck });
      const [a, b] = await Promise.all([
        place({ guestKey: gk, checkoutKey: ck, idempotencyKey: ik }),
        place({ guestKey: gk, checkoutKey: ck, idempotencyKey: ik }),
      ]);
      if (a.status !== 201 || b.status !== 201) {
        throw new Error(`concurrent ${a.status}/${b.status}`);
      }
      const ida = assertIdBody(a.body).id;
      const idb = assertIdBody(b.body).id;
      if (ida !== idb) throw new Error("concurrent created two orders");
      track(ida);
      const count = await prisma.order.count({
        where: { guestKey: gk, idempotencyKey: ik },
      });
      if (count !== 1) throw new Error(`orders ${count}`);
    });

    await run("PO13", async () => {
      const gk = guestKey();
      const ck = checkoutKey();
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck });
      const res = await place({
        guestKey: gk,
        checkoutKey: ck,
        idempotencyKey: `ik-po13-${stamp}`,
      });
      if (res.status !== 201) throw new Error(`status ${res.status}`);
      const id = track(assertIdBody(res.body).id);
      if (res.headers.location || res.headers.Location) {
        throw new Error("Location header set");
      }
      const payments = await prisma.payment.findMany({ where: { orderId: id } });
      if (payments.length !== 0) throw new Error(`Payment rows ${payments.length}`);
      // No separate PaymentIntent model. Intent persistence, if any, is Payment.providerIntentId.
      if (payments.some((p) => p.providerIntentId != null)) {
        throw new Error("providerIntentId persisted");
      }
    });
  } finally {
    try {
      if (createdOrderIds.length) {
        await prisma.couponUsage.deleteMany({
          where: { orderId: { in: createdOrderIds } },
        });
        await prisma.reservation.deleteMany({
          where: { orderId: { in: createdOrderIds } },
        });
        await prisma.orderItem.deleteMany({
          where: { orderId: { in: createdOrderIds } },
        });
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      }
      if (createdCheckoutKeys.length) {
        await prisma.reservation.deleteMany({
          where: { checkoutKey: { in: createdCheckoutKeys } },
        });
      }
      for (const gk of createdCartGuestKeys) {
        const cart = await prisma.cart.findUnique({ where: { guestKey: gk } });
        if (cart) {
          await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
          await prisma.cart.delete({ where: { id: cart.id } }).catch(() => undefined);
        }
      }
      for (const userId of createdUserIds) {
        await prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
        await prisma.userRole.deleteMany({ where: { userId } }).catch(() => undefined);
        await prisma.bonusAccount.deleteMany({ where: { userId } }).catch(() => undefined);
        const cart = await prisma.cart.findUnique({ where: { userId } });
        if (cart) {
          await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
          await prisma.cart.delete({ where: { id: cart.id } }).catch(() => undefined);
        }
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      }
      await prisma.inventory.update({
        where: { locationId_variantId: { locationId: location.id, variantId } },
        data: { quantityOnHand: onHand },
      });
    } catch (cleanupErr) {
      console.error("cleanup warning:", cleanupErr);
    }
    await app.close().catch(() => undefined);
  }

  printSummary(results);
  const failed = results.filter((r) => r.status === "FAIL").length;
  if (failed > 0 || results.length !== IDS.length) {
    process.exitCode = 1;
  } else {
    console.log(`\nplaceOrder core: ${results.length}/${IDS.length} PASS`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
