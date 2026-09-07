/**
 * Execute G3 — Order.deliveryTimeDisclosureSnapshot at placeOrder / PLACED.
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory, DE shipping, LegalPages)
 * Run (after build): node dist/orders.g3.selftest.js
 *
 * Scenarios:
 *   G3-1 — valid sources → full composite, V1 3–7, exact keys/rate/sources, in-Tx at 201
 *   G3-2 — locale captured from Order (registered en)
 *   G3-3 — processing NULL → snapshot NULL, placeOrder still 201
 *   G3-4 — invalid transit (min>max) → snapshot NULL, placeOrder still 201
 *   G3-5 — stored 0 is valid
 *   G3-6 — live rate/processing change after PLACED does not rewrite snapshot
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

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown; headers: IncomingHttpHeaders };

const IDS = ["G3-1", "G3-2", "G3-3", "G3-4", "G3-5", "G3-6"] as const;
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

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function mintCheckoutKey(): string {
  return randomBytes(32).toString("base64url");
}

function assertIdBody(body: unknown): { id: string } {
  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["id"])) {
    throw new Error(`body keys ${keys.join(",")}`);
  }
  if (typeof obj.id !== "string" || !obj.id) throw new Error("id missing");
  for (const k of ["deliveryTime", "deliveryTimeDisclosureSnapshot"]) {
    if (k in obj) throw new Error(`${k} leaked`);
  }
  return { id: obj.id };
}

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

function deAddress() {
  return {
    name: "Ada Guest",
    line1: "Musterstraße 1",
    postalCode: "10115",
    city: "Berlin",
    countryCode: "DE",
  };
}

function guestPlaceBody() {
  return {
    shippingAddressJson: deAddress(),
    billingAddressJson: deAddress(),
    paymentMethodCode: "stripe",
    acceptedAgb: true,
    acceptedWiderrufInfo: true,
    guestEmail: "guest-g3@test.local",
  };
}

function userPlaceBody() {
  return {
    shippingAddressJson: deAddress(),
    billingAddressJson: deAddress(),
    paymentMethodCode: "stripe",
    acceptedAgb: true,
    acceptedWiderrufInfo: true,
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

  const companyBefore = await prisma.companySettings.findUnique({ where: { id: "default" } });
  if (!companyBefore) throw new Error("CompanySettings default required");
  const processingMinBefore = companyBefore.orderProcessingDaysMin;
  const processingMaxBefore = companyBefore.orderProcessingDaysMax;

  const method = await prisma.shippingMethod.findFirst({
    where: { code: "standard", isActive: true },
  });
  const zone = await prisma.shippingZone.findFirst({ where: { countryCode: "DE" } });
  if (!method || !zone) throw new Error("DE standard shipping required");
  const rate = await prisma.shippingRate.findFirst({
    where: { zoneId: zone.id, methodId: method.id },
  });
  if (!rate) throw new Error("DE ShippingRate required");
  const rateId = rate.id;
  const transitMinBefore = rate.estimatedTransitDaysMin;
  const transitMaxBefore = rate.estimatedTransitDaysMax;

  const restoreSources = async () => {
    await prisma.companySettings.update({
      where: { id: "default" },
      data: {
        orderProcessingDaysMin: processingMinBefore,
        orderProcessingDaysMax: processingMaxBefore,
      },
    });
    await prisma.shippingRate.update({
      where: { id: rateId },
      data: {
        estimatedTransitDaysMin: transitMinBefore,
        estimatedTransitDaysMax: transitMaxBefore,
      },
    });
  };

  await prisma.inventory.update({
    where: { locationId_variantId: { locationId: location.id, variantId } },
    data: { quantityOnHand: Math.max(onHand, 80) },
  });
  await prisma.companySettings.update({
    where: { id: "default" },
    data: { orderProcessingDaysMin: 1, orderProcessingDaysMax: 3 },
  });
  await prisma.shippingRate.update({
    where: { id: rateId },
    data: { estimatedTransitDaysMin: 2, estimatedTransitDaysMax: 4 },
  });

  const guestKey = () => {
    const k = `gk_g3_${stamp}_${randomBytes(6).toString("hex")}`;
    createdCartGuestKeys.push(k);
    return k;
  };

  const checkoutKey = () => {
    const k = mintCheckoutKey();
    createdCheckoutKeys.push(k);
    return k;
  };

  const addCart = async (opts: { guestKey?: string; bearer?: string }) => {
    const res = await call(server, "POST", "/v1/cart/items", {
      guestKey: opts.guestKey,
      bearer: opts.bearer,
      json: { variantId, quantity: 1 },
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

  const placeGuest = (opts: { guestKey: string; checkoutKey: string; idempotencyKey: string }) =>
    call(server, "POST", "/v1/orders", {
      guestKey: opts.guestKey,
      checkoutKey: opts.checkoutKey,
      idempotencyKey: opts.idempotencyKey,
      json: guestPlaceBody(),
    });

  const track = (id: string) => {
    createdOrderIds.push(id);
    return id;
  };

  try {
    await run("G3-1", async () => {
      placeOrderEmailCalls.length = 0;
      const gk = guestKey();
      const ck = checkoutKey();
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck });
      const res = await placeGuest({
        guestKey: gk,
        checkoutKey: ck,
        idempotencyKey: `ik-g31-${stamp}`,
      });
      if (res.status !== 201) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const id = track(assertIdBody(res.body).id);
      if (placeOrderEmailCalls.length !== 1) {
        throw new Error(`email calls ${placeOrderEmailCalls.length}`);
      }
      const row = await prisma.order.findUnique({ where: { id } });
      if (row?.status !== "PLACED") throw new Error(`status ${row?.status}`);
      if (!row.shippingRateId || row.shippingRateId !== rateId) {
        throw new Error(`shippingRateId ${row?.shippingRateId}`);
      }
      if (row.shippingMethodCodeSnapshot !== "standard") {
        throw new Error(`method ${row.shippingMethodCodeSnapshot}`);
      }
      assertG3CompositeSnapshot(row.deliveryTimeDisclosureSnapshot, {
        processingMin: 1,
        processingMax: 3,
        transitMin: 2,
        transitMax: 4,
        shippingRateId: rateId,
        shippingMethodCode: "standard",
        locale: row.locale,
      });
      const snap = row.deliveryTimeDisclosureSnapshot as { labelShown: string };
      if (snap.labelShown !== `Lieferzeit: 3${EN_DASH}7 Werktage`) {
        throw new Error(`V1 label ${snap.labelShown}`);
      }
    });

    await run("G3-2", async () => {
      const email = `g3_${stamp}_${randomBytes(4).toString("hex")}@test.local`;
      const reg = await call(server, "POST", "/v1/auth/register", {
        json: { email, password: "Pass1234!", locale: "en" },
      });
      if (reg.status !== 200 && reg.status !== 201) {
        throw new Error(`register ${reg.status} ${JSON.stringify(reg.body)}`);
      }
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) throw new Error("user missing");
      createdUserIds.push(user.id);
      const bearer = (reg.body as { accessToken?: string }).accessToken;
      if (!bearer) throw new Error("no accessToken");
      const ck = checkoutKey();
      await addCart({ bearer });
      await reserve({ bearer, checkoutKey: ck });
      const res = await call(server, "POST", "/v1/orders", {
        bearer,
        checkoutKey: ck,
        idempotencyKey: `ik-g32-${stamp}`,
        json: userPlaceBody(),
      });
      if (res.status !== 201) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const id = track(assertIdBody(res.body).id);
      const row = await prisma.order.findUnique({ where: { id } });
      if (row?.locale !== "en") throw new Error(`Order.locale ${row?.locale}`);
      assertG3CompositeSnapshot(row?.deliveryTimeDisclosureSnapshot, {
        processingMin: 1,
        processingMax: 3,
        transitMin: 2,
        transitMax: 4,
        shippingRateId: rateId,
        shippingMethodCode: "standard",
        locale: "en",
      });
    });

    await run("G3-3", async () => {
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { orderProcessingDaysMin: null, orderProcessingDaysMax: null },
      });
      try {
        const gk = guestKey();
        const ck = checkoutKey();
        await addCart({ guestKey: gk });
        await reserve({ guestKey: gk, checkoutKey: ck });
        const res = await placeGuest({
          guestKey: gk,
          checkoutKey: ck,
          idempotencyKey: `ik-g33-${stamp}`,
        });
        if (res.status !== 201) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
        const id = track(assertIdBody(res.body).id);
        const row = await prisma.order.findUnique({ where: { id } });
        if (row?.status !== "PLACED") throw new Error(`status ${row?.status}`);
        if (row.deliveryTimeDisclosureSnapshot != null) {
          throw new Error("expected NULL snapshot");
        }
      } finally {
        await prisma.companySettings.update({
          where: { id: "default" },
          data: { orderProcessingDaysMin: 1, orderProcessingDaysMax: 3 },
        });
      }
    });

    await run("G3-4", async () => {
      await prisma.shippingRate.update({
        where: { id: rateId },
        data: { estimatedTransitDaysMin: 9, estimatedTransitDaysMax: 1 },
      });
      try {
        const gk = guestKey();
        const ck = checkoutKey();
        await addCart({ guestKey: gk });
        await reserve({ guestKey: gk, checkoutKey: ck });
        const res = await placeGuest({
          guestKey: gk,
          checkoutKey: ck,
          idempotencyKey: `ik-g34-${stamp}`,
        });
        if (res.status !== 201) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
        const id = track(assertIdBody(res.body).id);
        const row = await prisma.order.findUnique({ where: { id } });
        if (row?.status !== "PLACED") throw new Error(`status ${row?.status}`);
        if (row.deliveryTimeDisclosureSnapshot != null) {
          throw new Error("expected NULL snapshot");
        }
      } finally {
        await prisma.shippingRate.update({
          where: { id: rateId },
          data: { estimatedTransitDaysMin: 2, estimatedTransitDaysMax: 4 },
        });
      }
    });

    await run("G3-5", async () => {
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { orderProcessingDaysMin: 0, orderProcessingDaysMax: 0 },
      });
      await prisma.shippingRate.update({
        where: { id: rateId },
        data: { estimatedTransitDaysMin: 0, estimatedTransitDaysMax: 0 },
      });
      try {
        const gk = guestKey();
        const ck = checkoutKey();
        await addCart({ guestKey: gk });
        await reserve({ guestKey: gk, checkoutKey: ck });
        const res = await placeGuest({
          guestKey: gk,
          checkoutKey: ck,
          idempotencyKey: `ik-g35-${stamp}`,
        });
        if (res.status !== 201) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
        const id = track(assertIdBody(res.body).id);
        const row = await prisma.order.findUnique({ where: { id } });
        assertG3CompositeSnapshot(row?.deliveryTimeDisclosureSnapshot, {
          processingMin: 0,
          processingMax: 0,
          transitMin: 0,
          transitMax: 0,
          shippingRateId: rateId,
          shippingMethodCode: "standard",
          locale: row!.locale,
        });
      } finally {
        await prisma.companySettings.update({
          where: { id: "default" },
          data: { orderProcessingDaysMin: 1, orderProcessingDaysMax: 3 },
        });
        await prisma.shippingRate.update({
          where: { id: rateId },
          data: { estimatedTransitDaysMin: 2, estimatedTransitDaysMax: 4 },
        });
      }
    });

    await run("G3-6", async () => {
      const gk = guestKey();
      const ck = checkoutKey();
      await addCart({ guestKey: gk });
      await reserve({ guestKey: gk, checkoutKey: ck });
      const res = await placeGuest({
        guestKey: gk,
        checkoutKey: ck,
        idempotencyKey: `ik-g36-${stamp}`,
      });
      if (res.status !== 201) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const id = track(assertIdBody(res.body).id);
      const frozen = await prisma.order.findUnique({ where: { id } });
      const frozenSnap = frozen?.deliveryTimeDisclosureSnapshot;
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { orderProcessingDaysMin: 8, orderProcessingDaysMax: 9 },
      });
      await prisma.shippingRate.update({
        where: { id: rateId },
        data: { estimatedTransitDaysMin: 20, estimatedTransitDaysMax: 30 },
      });
      const again = await prisma.order.findUnique({ where: { id } });
      if (JSON.stringify(again?.deliveryTimeDisclosureSnapshot) !== JSON.stringify(frozenSnap)) {
        throw new Error("snapshot rewritten after live config change");
      }
      assertG3CompositeSnapshot(again?.deliveryTimeDisclosureSnapshot, {
        processingMin: 1,
        processingMax: 3,
        transitMin: 2,
        transitMax: 4,
        shippingRateId: rateId,
        shippingMethodCode: "standard",
        locale: again!.locale,
      });
    });
  } finally {
    try {
      await restoreSources();
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
    console.log(`\nG3 placeOrder snapshot: ${results.length}/${IDS.length} PASS`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
