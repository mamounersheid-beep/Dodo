/**
 * Production placeOrder Slice 3d — Coupon Preview (B1–B4).
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory + DE shipping + FreeShippingThreshold + SAVE5)
 * Run (after build): node dist/cart.3d.selftest.js
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { CouponType, Prisma } from "@dodo/database";
import type { CartRecalcResponse } from "@dodo/shared-types";
import { Cart3bTestAppModule } from "./cart.3b-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { GUEST_KEY_HEADER } from "./cart/cart.types";
import type { CartStateResponse } from "./cart/cart.types";
import { cart3bEmailCalls } from "./cart.3b-test.module";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

type HttpResult = { status: number; body: unknown };

const DEFERRED_BONUS_KU = [
  "discountBonus",
  "bonusPointsAvailable",
  "bonusPointsToRedeem",
] as const;

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
  opts?: { guestKey?: string; json?: unknown },
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
          ...(opts?.guestKey ? { [GUEST_KEY_HEADER]: opts.guestKey } : {}),
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

function asCart(body: unknown): CartStateResponse {
  return body as CartStateResponse;
}

function asRecalc(body: unknown): CartRecalcResponse {
  return body as CartRecalcResponse;
}

function errCode(body: unknown): string | undefined {
  return (body as { code?: string })?.code;
}

function assertNoBonusKu(body: CartRecalcResponse): void {
  const obj = body as Record<string, unknown>;
  for (const key of DEFERRED_BONUS_KU) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      throw new Error(`deferred fabricated: ${key}`);
    }
  }
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = [
    "D1",
    "D2",
    "D3",
    "D4",
    "D5",
    "D6",
    "D7",
    "D8",
    "D9",
    "D10",
    "D11",
  ] as const;

  const run = async (id: (typeof ids)[number], fn: () => Promise<void>) => {
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

  const app = await NestFactory.create(Cart3bTestAppModule, { logger: false });
  app.setGlobalPrefix("v1");
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0);
  const server = app.getHttpServer() as Server;
  const prisma = app.get(PrismaService);

  const createdCartIds: string[] = [];
  const createdCouponIds: string[] = [];
  let variantId = "";
  let productId = "";
  let invId = "";
  let onHandBefore = 0;
  let priceBefore: Prisma.Decimal | null = null;
  let couponsEnabledBefore = true;
  let dbRatePrice = "";

  const guestKey = () => `gk_3d_${stamp}_${randomBytes(4).toString("hex")}`;

  const recalc = (gk: string, body: Record<string, unknown>) =>
    call(server, "POST", "/v1/cart/recalculate", { guestKey: gk, json: body });

  const mkCoupon = async (data: {
    code: string;
    type: CouponType;
    value: number | string;
    minOrderAmount?: number | string | null;
    usageLimitGlobal?: number | null;
    validFrom?: Date;
    validTo?: Date | null;
    isActive?: boolean;
  }) => {
    const row = await prisma.coupon.create({
      data: {
        code: data.code,
        type: data.type,
        value: new Prisma.Decimal(data.value),
        minOrderAmount:
          data.minOrderAmount == null ? null : new Prisma.Decimal(data.minOrderAmount),
        usageLimitGlobal: data.usageLimitGlobal ?? null,
        validFrom: data.validFrom ?? new Date("2020-01-01"),
        validTo: data.validTo === undefined ? null : data.validTo,
        isActive: data.isActive ?? true,
      },
    });
    createdCouponIds.push(row.id);
    return row;
  };

  try {
    const inv = await prisma.inventory.findFirst({
      include: { location: true, variant: { include: { product: true } } },
    });
    if (!inv || inv.location.code !== "MAIN") {
      throw new Error("MAIN inventory + variant required — seed");
    }
    invId = inv.id;
    variantId = inv.variantId;
    productId = inv.variant.productId;
    onHandBefore = inv.quantityOnHand;
    priceBefore = inv.variant.price;

    const company = await prisma.companySettings.findUnique({ where: { id: "default" } });
    if (!company) throw new Error("CompanySettings default required");
    couponsEnabledBefore = company.couponsEnabled;

    const method = await prisma.shippingMethod.findUnique({ where: { code: "standard" } });
    const zone = await prisma.shippingZone.findFirst({ where: { countryCode: "DE" } });
    if (!method || !zone) throw new Error("DE standard shipping required");
    const rate = await prisma.shippingRate.findFirst({
      where: { zoneId: zone.id, methodId: method.id },
    });
    if (!rate) throw new Error("DE ShippingRate required");
    dbRatePrice = new Prisma.Decimal(rate.price).toFixed(2);

    const thr = await prisma.freeShippingThreshold.findFirst({
      where: { countryCode: "DE", currencyCode: "EUR" },
    });
    if (!thr) throw new Error("FreeShippingThreshold required");

    await prisma.inventory.update({
      where: { id: inv.id },
      data: { quantityOnHand: 50 },
    });
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { isActive: true, price: new Prisma.Decimal("19.99") },
    });
    await prisma.product.update({ where: { id: productId }, data: { isActive: true } });
    await prisma.companySettings.update({
      where: { id: "default" },
      data: { couponsEnabled: true },
    });

    const save5 = await prisma.coupon.findUnique({ where: { code: "SAVE5" } });
    if (!save5 || save5.type !== CouponType.FIXED) {
      throw new Error("SAVE5 FIXED seed required");
    }

    cart3bEmailCalls.reset();
    const usageBefore = await prisma.couponUsage.count();
    const reservationBefore = await prisma.reservation.count();
    const orderBefore = await prisma.order.count();

    // D1 — no coupon / empty / whitespace → 3c shape
    await run("D1", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      for (const couponCode of [undefined, "", "   "] as const) {
        const json: Record<string, unknown> = { shippingCountryCode: "DE" };
        if (couponCode !== undefined) json.couponCode = couponCode;
        const res = await recalc(gk, json);
        if (res.status !== 200) throw new Error(`status ${res.status} for ${JSON.stringify(couponCode)}`);
        const body = asRecalc(res.body);
        if (body.itemsSubtotal !== "19.99") throw new Error(`subtotal ${body.itemsSubtotal}`);
        if (body.shippingTotal !== dbRatePrice) throw new Error(`ship ${body.shippingTotal}`);
        if (body.discountCoupon !== undefined) throw new Error("discountCoupon must be absent");
        assertNoBonusKu(body);
      }
    });

    // D2 — SAVE5 FIXED applicable
    await run("D2", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      const res = await recalc(gk, { shippingCountryCode: "DE", couponCode: "SAVE5" });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecalc(res.body);
      if (body.itemsSubtotal !== "19.99") throw new Error(`subtotal ${body.itemsSubtotal}`);
      if (body.discountCoupon !== "5.00") throw new Error(`discount ${body.discountCoupon}`);
      // 14.99 < 70 → paid
      if (body.shippingTotal !== dbRatePrice) throw new Error(`ship ${body.shippingTotal}`);
      assertNoBonusKu(body);
    });

    // D3 — after coupon still under threshold → paid; trim ok; case-sensitive fail
    await run("D3", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 2 },
      });
      const trimmed = await recalc(gk, { shippingCountryCode: "DE", couponCode: "  SAVE5  " });
      if (trimmed.status !== 200) throw new Error(`trim status ${trimmed.status}`);
      if (asRecalc(trimmed.body).discountCoupon !== "5.00") throw new Error("trim failed");
      // 39.98 - 5 = 34.98 < 70
      if (asRecalc(trimmed.body).shippingTotal !== dbRatePrice) {
        throw new Error(`expected paid got ${asRecalc(trimmed.body).shippingTotal}`);
      }
      const badCase = await recalc(gk, { shippingCountryCode: "DE", couponCode: "save5" });
      if (badCase.status !== 400 || errCode(badCase.body) !== "INVALID_COUPON") {
        throw new Error(`case-sensitive expected 400 INVALID_COUPON got ${badCase.status} ${errCode(badCase.body)}`);
      }
    });

    // D4 — coupon drops goods under threshold that was free without coupon
    await run("D4", async () => {
      const code = `3D_DROP_${stamp}`;
      await mkCoupon({ code, type: CouponType.FIXED, value: "25" });
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      // 19.99 × 4 = 79.96 ≥ 70 free without coupon
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 4 },
      });
      const noC = await recalc(gk, { shippingCountryCode: "DE" });
      if (asRecalc(noC.body).shippingTotal !== "0.00") throw new Error("expected free without coupon");
      // 79.96 - 25 = 54.96 < 70 → paid
      const withC = await recalc(gk, { shippingCountryCode: "DE", couponCode: code });
      if (withC.status !== 200) throw new Error(`status ${withC.status}`);
      const body = asRecalc(withC.body);
      if (body.discountCoupon !== "25.00") throw new Error(`discount ${body.discountCoupon}`);
      if (body.shippingTotal !== dbRatePrice) {
        throw new Error(`expected paid after coupon got ${body.shippingTotal}`);
      }
    });

    // D5 — FREE_SHIPPING override under threshold
    await run("D5", async () => {
      const code = `3D_FS_${stamp}`;
      await mkCoupon({ code, type: CouponType.FREE_SHIPPING, value: "0" });
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      const res = await recalc(gk, { shippingCountryCode: "DE", couponCode: code });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecalc(res.body);
      if (body.shippingTotal !== "0.00") throw new Error(`ship ${body.shippingTotal}`);
      if (body.discountCoupon !== undefined) throw new Error("FREE_SHIPPING must omit discountCoupon");
      assertNoBonusKu(body);
    });

    // D6 — PERCENT HALF_UP + FIXED oversize cap
    await run("D6", async () => {
      const pctCode = `3D_PCT_${stamp}`;
      await mkCoupon({ code: pctCode, type: CouponType.PERCENT, value: "10" });
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      // 19.99 × 10% = 1.999 → HALF_UP 2.00
      const pct = await recalc(gk, { shippingCountryCode: "DE", couponCode: pctCode });
      if (pct.status !== 200) throw new Error(`pct ${pct.status}`);
      if (asRecalc(pct.body).discountCoupon !== "2.00") {
        throw new Error(`PERCENT HALF_UP expected 2.00 got ${asRecalc(pct.body).discountCoupon}`);
      }

      const capCode = `3D_CAP_${stamp}`;
      await mkCoupon({ code: capCode, type: CouponType.FIXED, value: "999" });
      const cap = await recalc(gk, { shippingCountryCode: "DE", couponCode: capCode });
      if (cap.status !== 200) throw new Error(`cap ${cap.status}`);
      if (asRecalc(cap.body).discountCoupon !== "19.99") {
        throw new Error(`FIXED cap expected 19.99 got ${asRecalc(cap.body).discountCoupon}`);
      }
      // goods-after = 0 < threshold → paid shipping (B4 threshold basis)
      if (asRecalc(cap.body).shippingTotal !== dbRatePrice) {
        throw new Error(`cap shipping ${asRecalc(cap.body).shippingTotal}`);
      }
    });

    // D7 — invalid: unknown / inactive / expired / not-yet-valid / minOrder
    await run("D7", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });

      const inactive = await mkCoupon({
        code: `3D_INACT_${stamp}`,
        type: CouponType.FIXED,
        value: "1",
        isActive: false,
      });
      const expired = await mkCoupon({
        code: `3D_EXP_${stamp}`,
        type: CouponType.FIXED,
        value: "1",
        validFrom: new Date("2020-01-01"),
        validTo: new Date("2021-01-01"),
      });
      const future = await mkCoupon({
        code: `3D_FUT_${stamp}`,
        type: CouponType.FIXED,
        value: "1",
        validFrom: new Date("2099-01-01"),
      });
      const minOrd = await mkCoupon({
        code: `3D_MIN_${stamp}`,
        type: CouponType.FIXED,
        value: "1",
        minOrderAmount: "50",
      });

      for (const code of [
        "NO_SUCH_COUPON_3D",
        inactive.code,
        expired.code,
        future.code,
        minOrd.code,
      ]) {
        const res = await recalc(gk, { shippingCountryCode: "DE", couponCode: code });
        if (res.status !== 400 || errCode(res.body) !== "INVALID_COUPON") {
          throw new Error(`${code} → ${res.status} ${errCode(res.body)}`);
        }
      }
    });

    // D8 — exhausted global quota
    await run("D8", async () => {
      const code = `3D_QUOTA_${stamp}`;
      const c = await mkCoupon({
        code,
        type: CouponType.FIXED,
        value: "1",
        usageLimitGlobal: 0,
      });
      // usageLimitGlobal 0 → any activeUsage >= 0 fails; count is 0 so 0 >= 0 → reject
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      const res = await recalc(gk, { shippingCountryCode: "DE", couponCode: code });
      if (res.status !== 400 || errCode(res.body) !== "INVALID_COUPON") {
        throw new Error(`quota ${res.status} ${errCode(res.body)}`);
      }
      void c;
    });

    // D9 — couponsEnabled=false → 409
    await run("D9", async () => {
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { couponsEnabled: false },
      });
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      const res = await recalc(gk, { shippingCountryCode: "DE", couponCode: "SAVE5" });
      if (res.status !== 409 || errCode(res.body) !== "STORE_COUPONS_DISABLED") {
        throw new Error(`expected 409 STORE_COUPONS_DISABLED got ${res.status} ${errCode(res.body)}`);
      }
      // absent coupon still works (3c)
      const ok = await recalc(gk, { shippingCountryCode: "DE" });
      if (ok.status !== 200) throw new Error(`no-coupon should work got ${ok.status}`);
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { couponsEnabled: true },
      });
    });

    // D10 — no CouponUsage / Reservation / Order / Email side effects
    await run("D10", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      cart3bEmailCalls.reset();
      const beforeUsage = await prisma.couponUsage.count();
      const beforeRes = await prisma.reservation.count();
      const beforeOrd = await prisma.order.count();
      const res = await recalc(gk, { shippingCountryCode: "DE", couponCode: "SAVE5" });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      if ((await prisma.couponUsage.count()) !== beforeUsage) throw new Error("CouponUsage mutated");
      if ((await prisma.reservation.count()) !== beforeRes) throw new Error("Reservation mutated");
      if ((await prisma.order.count()) !== beforeOrd) throw new Error("Order mutated");
      if (cart3bEmailCalls.auth !== 0 || cart3bEmailCalls.orderConfirmation !== 0) {
        throw new Error("Email side effect");
      }
      // cart unchanged
      const state = asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body);
      if (state.items.length !== 1 || state.items[0].quantity !== 1) {
        throw new Error("cart mutated");
      }
    });

    // D11 — regression: sellability/stock still reject; 3c keys without coupon
    await run("D11", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 2 },
      });
      const res = await recalc(gk, { shippingCountryCode: "DE" });
      if (res.status !== 200) throw new Error(`recalc ${res.status}`);
      const keys = Object.keys(res.body as object).sort();
      const expected = [
        "companyIsKleinunternehmer",
        "currencyCode",
        "exemptionText",
        "grandTotal",
        "itemsSubtotal",
        "lines",
        "shippingTotal",
      ].sort();
      const allowed = new Set([...expected, "deliveryTime"]);
      const missing = expected.filter((k) => !keys.includes(k));
      const unexpected = keys.filter((k) => !allowed.has(k));
      if (missing.length || unexpected.length) {
        throw new Error(`3c keys ${keys.join(",")}`);
      }
      await prisma.productVariant.update({
        where: { id: variantId },
        data: { isActive: false },
      });
      const fail = await recalc(gk, { shippingCountryCode: "DE", couponCode: "SAVE5" });
      if (fail.status === 200) throw new Error("inactive variant must reject");
      await prisma.productVariant.update({
        where: { id: variantId },
        data: { isActive: true },
      });
    });

    void usageBefore;
    void reservationBefore;
    void orderBefore;
  } catch (e) {
    for (const id of ids) {
      if (!results.some((r) => r.id === id)) {
        results.push({
          id,
          status: "BLOCKED",
          note: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    try {
      for (const cartId of createdCartIds) {
        await prisma.cartItem.deleteMany({ where: { cartId } });
        await prisma.cart.delete({ where: { id: cartId } }).catch(() => undefined);
      }
      for (const id of createdCouponIds) {
        await prisma.coupon.delete({ where: { id } }).catch(() => undefined);
      }
      if (invId) {
        await prisma.inventory.update({
          where: { id: invId },
          data: { quantityOnHand: onHandBefore },
        });
      }
      if (variantId && priceBefore) {
        await prisma.productVariant.update({
          where: { id: variantId },
          data: { isActive: true, price: priceBefore },
        });
      }
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { couponsEnabled: couponsEnabledBefore },
      });
    } catch {
      /* best-effort cleanup */
    }
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    process.exitCode = 1;
  } else {
    console.log(`\nSlice 3d coupon preview: ${results.length}/${ids.length} PASS`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
