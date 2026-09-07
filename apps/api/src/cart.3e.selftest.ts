/**
 * Production placeOrder Slice 3e — Bonus+ Preview (D1–D9).
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory + DE shipping + FreeShippingThreshold)
 * Run (after build): node dist/cart.3e.selftest.js
 *
 * Scenarios:
 *   E1 — absent intent → 3d contract unchanged (no Bonus fields)
 *   E2 — Guest + intent → 403 FORBIDDEN (D2)
 *   E3 — Registered + bonusPlusEnabled=false + intent → 409 STORE_BONUS_DISABLED (D6)
 *   E4 — Registered, no BonusAccount (balance=0) + intent 100 → effectivePoints=0 → bonusPointsAvailable=0 only
 *   E5 — Registered, balance 500, goodsAfterGutschein 19.99 → maxPointsByCap=999, effectivePoints=min(100,500,999)=100
 *        → discountBonus="1.00", bonusPointsToRedeem=100, bonusPointsAvailable=500
 *   E6 — Over-ask: intent 9999, balance 200, cap 999 → effectivePoints=200 (SOFT-CAP, no error)
 *   E7 — Intent 0: effectivePoints=0 → bonusPointsAvailable emitted, no discountBonus/bonusPointsToRedeem
 *   E8 — Bonus does not change shippingTotal (D7): goods below threshold, Bonus reduces goods further → shipping still paid
 *   E9 — Free-shipping coupon + Bonus → shippingTotal stays "0.00" (D7-R5)
 *   E10 — No Cart/BonusLedger mutation from preview (D3-R5 / D6-R6 / D9-R10)
 *   E11 — Regression: absent Bonus = 3d contract (guest with coupon, no Bonus fields)
 *   E12 — bonusPlusEnabled=false + absent intent → store gate not triggered (D6-R2)
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
import { Cart3bTestAppModule, cart3bEmailCalls } from "./cart.3b-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { GUEST_KEY_HEADER } from "./cart/cart.types";
import type { CartStateResponse } from "./cart/cart.types";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

/** G1-R17 — grandTotal/KU are now required on success; only assert presence. */

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
  opts?: { bearer?: string; guestKey?: string; json?: unknown },
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

/** G1-R17 — layer is present; 3e still does not own these fields. */
function assertG1Present(body: CartRecalcResponse): void {
  if (typeof body.grandTotal !== "string") throw new Error("G1 grandTotal missing");
  if (typeof body.companyIsKleinunternehmer !== "boolean") {
    throw new Error("G1 companyIsKleinunternehmer missing");
  }
  if (!Object.prototype.hasOwnProperty.call(body, "exemptionText")) {
    throw new Error("G1 exemptionText missing");
  }
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = [
    "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11", "E12",
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
  const createdUserIds: string[] = [];
  const createdCouponIds: string[] = [];
  const createdBonusAccountIds: string[] = [];
  let variantId = "";
  let productId = "";
  let invId = "";
  let onHandBefore = 0;
  let priceBefore: Prisma.Decimal | null = null;
  let bonusPlusEnabledBefore = true;
  let couponsEnabledBefore = true;
  let dbRatePrice = "";

  const guestKey = () => `gk_3e_${stamp}_${randomBytes(4).toString("hex")}`;
  const userEmail = () => `3e_${stamp}_${randomBytes(4).toString("hex")}@test.local`;

  /** Register a new user, return bearer token + userId. */
  const registerUser = async (): Promise<{ bearer: string; userId: string }> => {
    const email = userEmail();
    const res = await call(server, "POST", "/v1/auth/register", {
      json: { email, password: "Pass1234!", locale: "de" },
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`register ${res.status} ${JSON.stringify(res.body)}`);
    }
    const body = res.body as { accessToken?: string; user?: { id?: string }; id?: string };
    const bearer = body.accessToken ?? "";
    if (!bearer) throw new Error("register: no accessToken");
    // find the user from DB (email unique)
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error("register: user not found in DB");
    createdUserIds.push(user.id);
    return { bearer, userId: user.id };
  };

  /** Upsert a BonusAccount with a given cached balance. */
  const ensureBonusAccount = async (userId: string, balance: number): Promise<string> => {
    const existing = await prisma.bonusAccount.findUnique({ where: { userId } });
    if (existing) {
      await prisma.bonusAccount.update({
        where: { id: existing.id },
        data: { balanceCached: balance },
      });
      return existing.id;
    }
    const acct = await prisma.bonusAccount.create({
      data: { userId, balanceCached: balance },
    });
    createdBonusAccountIds.push(acct.id);
    return acct.id;
  };

  const mkCoupon = async (data: {
    code: string;
    type: CouponType;
    value: number | string;
  }) => {
    const row = await prisma.coupon.create({
      data: {
        code: data.code,
        type: data.type,
        value: new Prisma.Decimal(data.value),
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });
    createdCouponIds.push(row.id);
    return row;
  };

  try {
    // ── Seed verification ───────────────────────────────────────────────
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
    bonusPlusEnabledBefore = company.bonusPlusEnabled;
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

    // Set up: 50 stock, variant active, price 19.99, bonusPlusEnabled=true, couponsEnabled=true
    await prisma.inventory.update({ where: { id: invId }, data: { quantityOnHand: 50 } });
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { isActive: true, price: new Prisma.Decimal("19.99") },
    });
    await prisma.product.update({ where: { id: productId }, data: { isActive: true } });
    await prisma.companySettings.update({
      where: { id: "default" },
      data: { bonusPlusEnabled: true, couponsEnabled: true },
    });

    cart3bEmailCalls.reset();

    // Helpers
    const addItem = (bearer?: string, gk?: string, qty = 1) =>
      call(server, "POST", "/v1/cart/items", {
        bearer,
        guestKey: gk,
        json: { variantId, quantity: qty },
      });

    const recalc = (
      opts: { bearer?: string; gk?: string },
      body: Record<string, unknown>,
    ) =>
      call(server, "POST", "/v1/cart/recalculate", {
        bearer: opts.bearer,
        guestKey: opts.gk,
        json: body,
      });

    // ── E1 — absent intent → 3d contract (no Bonus fields) ─────────────
    await run("E1", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await addItem(undefined, gk);
      const res = await recalc({ gk }, { shippingCountryCode: "DE" });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecalc(res.body);
      const obj = body as Record<string, unknown>;
      if (obj["bonusPointsAvailable"] !== undefined) throw new Error("bonusPointsAvailable must be absent");
      if (obj["bonusPointsToRedeem"] !== undefined) throw new Error("bonusPointsToRedeem must be absent");
      if (obj["discountBonus"] !== undefined) throw new Error("discountBonus must be absent");
      assertG1Present(body);
    });

    // ── E2 — Guest + intent → 403 FORBIDDEN ────────────────────────────
    await run("E2", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await addItem(undefined, gk);
      const res = await recalc({ gk }, { shippingCountryCode: "DE", bonusPointsToRedeem: 100 });
      if (res.status !== 403) throw new Error(`expected 403 got ${res.status}`);
      if (errCode(res.body) !== "FORBIDDEN") throw new Error(`code=${errCode(res.body)}`);
    });

    // ── E3 — Registered + bonusPlusEnabled=false + intent → 409 STORE_BONUS_DISABLED ──
    await run("E3", async () => {
      const { bearer, userId } = await registerUser();
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { bonusPlusEnabled: false },
      });
      try {
        // Get/create registered cart then add item
        const cartRes = await call(server, "GET", "/v1/cart", { bearer });
        createdCartIds.push(asCart(cartRes.body).id);
        await addItem(bearer, undefined, 1);
        const res = await recalc({ bearer }, { shippingCountryCode: "DE", bonusPointsToRedeem: 100 });
        if (res.status !== 409) throw new Error(`expected 409 got ${res.status} ${JSON.stringify(res.body)}`);
        if (errCode(res.body) !== "STORE_BONUS_DISABLED") {
          throw new Error(`code=${errCode(res.body)}`);
        }
        void userId;
      } finally {
        await prisma.companySettings.update({
          where: { id: "default" },
          data: { bonusPlusEnabled: true },
        });
      }
    });

    // ── E4 — No BonusAccount (balance=0): effectivePoints=0 → only bonusPointsAvailable emitted ──
    await run("E4", async () => {
      const { bearer, userId } = await registerUser();
      // Ensure no bonus account (or set to 0)
      await ensureBonusAccount(userId, 0);
      const cartRes = await call(server, "GET", "/v1/cart", { bearer });
      createdCartIds.push(asCart(cartRes.body).id);
      await addItem(bearer, undefined, 1);
      const res = await recalc({ bearer }, { shippingCountryCode: "DE", bonusPointsToRedeem: 100 });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecalc(res.body);
      const obj = body as Record<string, unknown>;
      if (body.bonusPointsAvailable !== 0) throw new Error(`bonusPointsAvailable expected 0 got ${body.bonusPointsAvailable}`);
      if (obj["discountBonus"] !== undefined) throw new Error("discountBonus must be absent when effectivePoints=0");
      if (obj["bonusPointsToRedeem"] !== undefined) throw new Error("bonusPointsToRedeem must be absent when effectivePoints=0");
      assertG1Present(body);
    });

    // ── E5 — Happy path: balance 500, intent 100, goodsAfterGutschein 19.99 ──────
    // maxPointsByCap = FLOOR(19.99 × 50) = FLOOR(999.5) = 999
    // effectivePoints = min(100, 500, 999) = 100
    // discountBonus = "1.00", bonusPointsToRedeem = 100, bonusPointsAvailable = 500
    await run("E5", async () => {
      const { bearer, userId } = await registerUser();
      await ensureBonusAccount(userId, 500);
      const cartRes = await call(server, "GET", "/v1/cart", { bearer });
      createdCartIds.push(asCart(cartRes.body).id);
      await addItem(bearer, undefined, 1);
      const res = await recalc({ bearer }, { shippingCountryCode: "DE", bonusPointsToRedeem: 100 });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecalc(res.body);
      if (body.discountBonus !== "1.00") throw new Error(`discountBonus expected 1.00 got ${body.discountBonus}`);
      if (body.bonusPointsToRedeem !== 100) throw new Error(`bonusPointsToRedeem expected 100 got ${body.bonusPointsToRedeem}`);
      if (body.bonusPointsAvailable !== 500) throw new Error(`bonusPointsAvailable expected 500 got ${body.bonusPointsAvailable}`);
      if (body.itemsSubtotal !== "19.99") throw new Error(`itemsSubtotal ${body.itemsSubtotal}`);
      assertG1Present(body);
    });

    // ── E6 — Over-ask SOFT-CAP: intent 9999, balance 200, cap 999 → effectivePoints=200 ──
    await run("E6", async () => {
      const { bearer, userId } = await registerUser();
      await ensureBonusAccount(userId, 200);
      const cartRes = await call(server, "GET", "/v1/cart", { bearer });
      createdCartIds.push(asCart(cartRes.body).id);
      await addItem(bearer, undefined, 1); // goods=19.99
      // maxPointsByCap = FLOOR(19.99×50)=999; effectivePoints=min(9999,200,999)=200
      const res = await recalc({ bearer }, { shippingCountryCode: "DE", bonusPointsToRedeem: 9999 });
      if (res.status !== 200) throw new Error(`status ${res.status} — over-ask must not error`);
      const body = asRecalc(res.body);
      if (body.bonusPointsToRedeem !== 200) throw new Error(`effectivePoints expected 200 got ${body.bonusPointsToRedeem}`);
      if (body.discountBonus !== "2.00") throw new Error(`discountBonus expected 2.00 got ${body.discountBonus}`);
      if (body.bonusPointsAvailable !== 200) throw new Error(`bonusPointsAvailable expected 200 got ${body.bonusPointsAvailable}`);
    });

    // ── E7 — Intent 0: effectivePoints=0 → bonusPointsAvailable emitted, no discount ──
    await run("E7", async () => {
      const { bearer, userId } = await registerUser();
      await ensureBonusAccount(userId, 300);
      const cartRes = await call(server, "GET", "/v1/cart", { bearer });
      createdCartIds.push(asCart(cartRes.body).id);
      await addItem(bearer, undefined, 1);
      const res = await recalc({ bearer }, { shippingCountryCode: "DE", bonusPointsToRedeem: 0 });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecalc(res.body);
      const obj = body as Record<string, unknown>;
      if (body.bonusPointsAvailable !== 300) throw new Error(`bonusPointsAvailable expected 300 got ${body.bonusPointsAvailable}`);
      if (obj["discountBonus"] !== undefined) throw new Error("discountBonus must be absent (intent=0)");
      if (obj["bonusPointsToRedeem"] !== undefined) throw new Error("bonusPointsToRedeem must be absent (effectivePoints=0)");
    });

    // ── E8 — Bonus does not change shippingTotal (D7) ──────────────────
    // goods=19.99 < threshold → paid shipping. Bonus of 100pts=1 EUR still → paid shipping.
    await run("E8", async () => {
      const { bearer, userId } = await registerUser();
      await ensureBonusAccount(userId, 500);
      const cartRes = await call(server, "GET", "/v1/cart", { bearer });
      createdCartIds.push(asCart(cartRes.body).id);
      await addItem(bearer, undefined, 1);
      const res = await recalc({ bearer }, { shippingCountryCode: "DE", bonusPointsToRedeem: 100 });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecalc(res.body);
      // goods-after-gutschein=19.99 < threshold → paid regardless of Bonus
      if (body.shippingTotal !== dbRatePrice) {
        throw new Error(`shippingTotal must be paid=${dbRatePrice}, got ${body.shippingTotal}`);
      }
      // Bonus discount is present
      if (body.discountBonus !== "1.00") throw new Error(`discountBonus ${body.discountBonus}`);
    });

    // ── E9 — FREE_SHIPPING coupon + Bonus → shippingTotal stays "0.00" (D7-R5) ──
    await run("E9", async () => {
      const { bearer, userId } = await registerUser();
      await ensureBonusAccount(userId, 500);
      const fsCode = `3E_FS_${stamp}`;
      await mkCoupon({ code: fsCode, type: CouponType.FREE_SHIPPING, value: "0" });
      const cartRes = await call(server, "GET", "/v1/cart", { bearer });
      createdCartIds.push(asCart(cartRes.body).id);
      await addItem(bearer, undefined, 1);
      const res = await recalc(
        { bearer },
        { shippingCountryCode: "DE", couponCode: fsCode, bonusPointsToRedeem: 100 },
      );
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecalc(res.body);
      if (body.shippingTotal !== "0.00") throw new Error(`FREE_SHIPPING + Bonus: shippingTotal must be 0.00, got ${body.shippingTotal}`);
      if (body.discountBonus !== "1.00") throw new Error(`discountBonus ${body.discountBonus}`);
    });

    // ── E10 — No Cart/BonusLedger mutation from preview ────────────────
    await run("E10", async () => {
      const { bearer, userId } = await registerUser();
      const acctId = await ensureBonusAccount(userId, 200);
      const cartRes = await call(server, "GET", "/v1/cart", { bearer });
      createdCartIds.push(asCart(cartRes.body).id);
      await addItem(bearer, undefined, 1);

      cart3bEmailCalls.reset();
      const ledgerBefore = await prisma.bonusLedger.count();
      const reservBefore = await prisma.reservation.count();
      const orderBefore = await prisma.order.count();
      const acctBefore = await prisma.bonusAccount.findUnique({ where: { id: acctId } });

      const res = await recalc({ bearer }, { shippingCountryCode: "DE", bonusPointsToRedeem: 100 });
      if (res.status !== 200) throw new Error(`status ${res.status}`);

      // No BonusLedger written
      const ledgerAfter = await prisma.bonusLedger.count();
      if (ledgerAfter !== ledgerBefore) throw new Error("BonusLedger mutated");
      // No BonusAccount balance change
      const acctAfter = await prisma.bonusAccount.findUnique({ where: { id: acctId } });
      if (acctAfter?.balanceCached !== acctBefore?.balanceCached) {
        throw new Error(`BonusAccount.balanceCached changed ${acctBefore?.balanceCached} → ${acctAfter?.balanceCached}`);
      }
      // No Reservation / Order side effects
      if ((await prisma.reservation.count()) !== reservBefore) throw new Error("Reservation mutated");
      if ((await prisma.order.count()) !== orderBefore) throw new Error("Order mutated");
      if (cart3bEmailCalls.auth !== 0 || cart3bEmailCalls.orderConfirmation !== 0) {
        throw new Error("Email side effect");
      }
    });

    // ── E11 — Regression: guest + coupon, no Bonus field, 3d shape intact ──
    await run("E11", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await addItem(undefined, gk);
      // SAVE5 must exist in seed (same as 3d harness)
      const res = await recalc({ gk }, { shippingCountryCode: "DE", couponCode: "SAVE5" });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecalc(res.body);
      const obj = body as Record<string, unknown>;
      if (obj["bonusPointsAvailable"] !== undefined) throw new Error("bonusPointsAvailable must be absent");
      if (obj["bonusPointsToRedeem"] !== undefined) throw new Error("bonusPointsToRedeem must be absent");
      if (obj["discountBonus"] !== undefined) throw new Error("discountBonus must be absent");
      if (body.discountCoupon !== "5.00") throw new Error(`discountCoupon ${body.discountCoupon}`);
      assertG1Present(body);
    });

    // ── E12 — bonusPlusEnabled=false + absent intent → no gate (D6-R2) ──
    await run("E12", async () => {
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { bonusPlusEnabled: false },
      });
      try {
        const gk = guestKey();
        createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
        await addItem(undefined, gk);
        const res = await recalc({ gk }, { shippingCountryCode: "DE" });
        if (res.status !== 200) throw new Error(`status ${res.status} — absent intent must not trigger bonus gate`);
        const body = asRecalc(res.body);
        const obj = body as Record<string, unknown>;
        if (obj["bonusPointsAvailable"] !== undefined) throw new Error("bonusPointsAvailable must be absent");
        if (obj["discountBonus"] !== undefined) throw new Error("discountBonus must be absent");
      } finally {
        await prisma.companySettings.update({
          where: { id: "default" },
          data: { bonusPlusEnabled: true },
        });
      }
    });
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
      for (const id of createdBonusAccountIds) {
        await prisma.bonusAccount.delete({ where: { id } }).catch(() => undefined);
      }
      // Registered users created by tests (cleanup cart first already done above)
      for (const userId of createdUserIds) {
        await prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      }
      if (invId) {
        await prisma.inventory.update({ where: { id: invId }, data: { quantityOnHand: onHandBefore } });
      }
      if (variantId && priceBefore) {
        await prisma.productVariant.update({
          where: { id: variantId },
          data: { isActive: true, price: priceBefore },
        });
      }
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { bonusPlusEnabled: bonusPlusEnabledBefore, couponsEnabled: couponsEnabledBefore },
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
    console.log(`\nSlice 3e Bonus+ preview: ${results.length}/${ids.length} PASS`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
