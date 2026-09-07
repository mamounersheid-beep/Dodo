/**
 * Execute G1 — grandTotal / KU layer on POST /v1/cart/recalculate.
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory + DE shipping + FreeShippingThreshold + SAVE5)
 * Run (after build): node dist/cart.g1.selftest.js
 *
 * Scenarios:
 *   G1-1 — three G1 fields always present on success
 *   G1-2 — formula without coupon/bonus: itemsSubtotal + shippingTotal
 *   G1-3 — KU=true → exemptionText = live invoiceExemptionText
 *   G1-4 — KU=false → exemptionText=null; recalculate still 200
 *   G1-5 — SAVE5: subtract discountCoupon
 *   G1-6 — Bonus: subtract discountBonus
 *   G1-7 — FREE_SHIPPING: shippingTotal 0.00, no discountCoupon from shipping
 *   G1-8 — G1 fields present; 3g may emit deliveryTime (not a G1 omit); no invented top-level transit fields
 *   G1-9 — preview has no Cart/Reservation/Order/CouponUsage/BonusLedger writes
 *   G1-10 — live CompanySettings read (exemption text change while KU=true)
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

function money(value: string | undefined): Prisma.Decimal {
  return new Prisma.Decimal(value ?? "0");
}

function expectedGrandTotal(body: CartRecalcResponse): string {
  return money(body.itemsSubtotal)
    .minus(money(body.discountCoupon))
    .minus(money(body.discountBonus))
    .plus(money(body.shippingTotal))
    .toFixed(2);
}

function assertG1Present(body: CartRecalcResponse): void {
  if (typeof body.grandTotal !== "string") throw new Error("grandTotal missing");
  if (typeof body.companyIsKleinunternehmer !== "boolean") {
    throw new Error("companyIsKleinunternehmer missing");
  }
  if (!Object.prototype.hasOwnProperty.call(body, "exemptionText")) {
    throw new Error("exemptionText missing");
  }
}

function assertNoInventedTransitFields(body: CartRecalcResponse): void {
  const obj = body as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(obj, "estimatedTransitDaysMin") ||
    Object.prototype.hasOwnProperty.call(obj, "estimatedTransitDaysMax")
  ) {
    throw new Error("transit fields must not be invented at top level");
  }
  const dt = obj.deliveryTime;
  if (dt === null) throw new Error("deliveryTime must not be null");
  if (dt !== undefined) {
    if (typeof dt !== "object" || Array.isArray(dt)) throw new Error("deliveryTime shape");
    const preview = dt as { isPreview?: unknown; disclosureLevel?: unknown };
    if (preview.isPreview !== true) throw new Error("deliveryTime.isPreview");
    if (preview.disclosureLevel !== "composite") throw new Error("deliveryTime.disclosureLevel");
  }
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = [
    "G1-1",
    "G1-2",
    "G1-3",
    "G1-4",
    "G1-5",
    "G1-6",
    "G1-7",
    "G1-8",
    "G1-9",
    "G1-10",
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
  let kuBefore = true;
  let exemptionBefore = "";
  let bonusPlusEnabledBefore = true;
  let couponsEnabledBefore = true;

  const guestKey = () => `gk_g1_${stamp}_${randomBytes(4).toString("hex")}`;
  const userEmail = () => `g1_${stamp}_${randomBytes(4).toString("hex")}@test.local`;

  const registerUser = async (): Promise<{ bearer: string; userId: string }> => {
    const email = userEmail();
    const res = await call(server, "POST", "/v1/auth/register", {
      json: { email, password: "Pass1234!", locale: "de" },
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`register ${res.status} ${JSON.stringify(res.body)}`);
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error("register: user not found in DB");
    createdUserIds.push(user.id);
    const body = res.body as { accessToken?: string };
    if (!body.accessToken) throw new Error("register: no accessToken");
    return { bearer: body.accessToken, userId: user.id };
  };

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
    kuBefore = company.isKleinunternehmer;
    exemptionBefore = company.invoiceExemptionText;
    bonusPlusEnabledBefore = company.bonusPlusEnabled;
    couponsEnabledBefore = company.couponsEnabled;

    const method = await prisma.shippingMethod.findUnique({ where: { code: "standard" } });
    const zone = await prisma.shippingZone.findFirst({ where: { countryCode: "DE" } });
    if (!method || !zone) throw new Error("DE standard shipping required");
    const rate = await prisma.shippingRate.findFirst({
      where: { zoneId: zone.id, methodId: method.id },
    });
    if (!rate) throw new Error("DE ShippingRate required");
    const thr = await prisma.freeShippingThreshold.findFirst({
      where: { countryCode: "DE", currencyCode: "EUR" },
    });
    if (!thr) throw new Error("FreeShippingThreshold required");

    await prisma.inventory.update({ where: { id: invId }, data: { quantityOnHand: 50 } });
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { isActive: true, price: new Prisma.Decimal("19.99") },
    });
    await prisma.product.update({ where: { id: productId }, data: { isActive: true } });
    await prisma.companySettings.update({
      where: { id: "default" },
      data: {
        bonusPlusEnabled: true,
        couponsEnabled: true,
        isKleinunternehmer: true,
      },
    });

    cart3bEmailCalls.reset();

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

    await run("G1-1", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await addItem(undefined, gk);
      const res = await recalc({ gk }, { shippingCountryCode: "DE" });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      assertG1Present(asRecalc(res.body));
    });

    await run("G1-2", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await addItem(undefined, gk);
      const res = await recalc({ gk }, { shippingCountryCode: "DE" });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecalc(res.body);
      if (body.discountCoupon !== undefined) throw new Error("discountCoupon must be omitted");
      if (body.discountBonus !== undefined) throw new Error("discountBonus must be omitted");
      if (body.grandTotal !== expectedGrandTotal(body)) {
        throw new Error(`grandTotal ${body.grandTotal} != ${expectedGrandTotal(body)}`);
      }
      if (money(body.grandTotal).lt(money(body.shippingTotal))) {
        throw new Error("grandTotal < shippingTotal");
      }
    });

    await run("G1-3", async () => {
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { isKleinunternehmer: true },
      });
      const live = await prisma.companySettings.findUniqueOrThrow({
        where: { id: "default" },
        select: { invoiceExemptionText: true },
      });
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await addItem(undefined, gk);
      const res = await recalc({ gk }, { shippingCountryCode: "DE" });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecalc(res.body);
      if (body.companyIsKleinunternehmer !== true) {
        throw new Error(`KU expected true got ${body.companyIsKleinunternehmer}`);
      }
      if (body.exemptionText !== live.invoiceExemptionText) {
        throw new Error("exemptionText must equal live invoiceExemptionText");
      }
    });

    await run("G1-4", async () => {
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { isKleinunternehmer: false },
      });
      try {
        const gk = guestKey();
        createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
        await addItem(undefined, gk);
        const res = await recalc({ gk }, { shippingCountryCode: "DE" });
        if (res.status !== 200) throw new Error(`KU=false must not reject recalculate: ${res.status}`);
        const body = asRecalc(res.body);
        if (body.companyIsKleinunternehmer !== false) {
          throw new Error(`KU expected false got ${body.companyIsKleinunternehmer}`);
        }
        if (body.exemptionText !== null) {
          throw new Error(`exemptionText must be null when KU=false, got ${JSON.stringify(body.exemptionText)}`);
        }
      } finally {
        await prisma.companySettings.update({
          where: { id: "default" },
          data: { isKleinunternehmer: true },
        });
      }
    });

    await run("G1-5", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await addItem(undefined, gk);
      const res = await recalc({ gk }, { shippingCountryCode: "DE", couponCode: "SAVE5" });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecalc(res.body);
      if (body.discountCoupon !== "5.00") throw new Error(`discountCoupon ${body.discountCoupon}`);
      if (body.grandTotal !== expectedGrandTotal(body)) {
        throw new Error(`grandTotal ${body.grandTotal} != ${expectedGrandTotal(body)}`);
      }
    });

    await run("G1-6", async () => {
      const { bearer, userId } = await registerUser();
      await ensureBonusAccount(userId, 500);
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { bearer })).body).id);
      await addItem(bearer);
      const res = await recalc({ bearer }, { shippingCountryCode: "DE", bonusPointsToRedeem: 100 });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecalc(res.body);
      if (body.discountBonus !== "1.00") throw new Error(`discountBonus ${body.discountBonus}`);
      if (body.grandTotal !== expectedGrandTotal(body)) {
        throw new Error(`grandTotal ${body.grandTotal} != ${expectedGrandTotal(body)}`);
      }
    });

    await run("G1-7", async () => {
      const gk = guestKey();
      const fsCode = `G1_FS_${stamp}`;
      const coupon = await prisma.coupon.create({
        data: {
          code: fsCode,
          type: CouponType.FREE_SHIPPING,
          value: new Prisma.Decimal(0),
          validFrom: new Date("2020-01-01"),
          isActive: true,
        },
      });
      createdCouponIds.push(coupon.id);
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await addItem(undefined, gk);
      const res = await recalc({ gk }, { shippingCountryCode: "DE", couponCode: fsCode });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecalc(res.body);
      if (body.shippingTotal !== "0.00") throw new Error(`shippingTotal ${body.shippingTotal}`);
      if (body.discountCoupon !== undefined) {
        throw new Error("FREE_SHIPPING must not emit discountCoupon");
      }
      if (body.grandTotal !== expectedGrandTotal(body)) {
        throw new Error(`grandTotal ${body.grandTotal} != ${expectedGrandTotal(body)}`);
      }
    });

    await run("G1-8", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await addItem(undefined, gk);
      const res = await recalc({ gk }, { shippingCountryCode: "DE" });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      assertG1Present(asRecalc(res.body));
      assertNoInventedTransitFields(asRecalc(res.body));
    });

    await run("G1-9", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await addItem(undefined, gk);
      cart3bEmailCalls.reset();
      const before = {
        couponUsage: await prisma.couponUsage.count(),
        bonusLedger: await prisma.bonusLedger.count(),
        reservation: await prisma.reservation.count(),
        order: await prisma.order.count(),
        payment: await prisma.payment.count(),
      };
      const res = await recalc({ gk }, { shippingCountryCode: "DE", couponCode: "SAVE5" });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      if ((await prisma.couponUsage.count()) !== before.couponUsage) throw new Error("CouponUsage mutated");
      if ((await prisma.bonusLedger.count()) !== before.bonusLedger) throw new Error("BonusLedger mutated");
      if ((await prisma.reservation.count()) !== before.reservation) throw new Error("Reservation mutated");
      if ((await prisma.order.count()) !== before.order) throw new Error("Order mutated");
      if ((await prisma.payment.count()) !== before.payment) throw new Error("Payment mutated");
      if (cart3bEmailCalls.auth !== 0 || cart3bEmailCalls.orderConfirmation !== 0) {
        throw new Error("Email side effect");
      }
    });

    await run("G1-10", async () => {
      const marker = `G1-live-${stamp}`;
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { isKleinunternehmer: true, invoiceExemptionText: marker },
      });
      try {
        const gk = guestKey();
        createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
        await addItem(undefined, gk);
        const res = await recalc({ gk }, { shippingCountryCode: "DE" });
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const body = asRecalc(res.body);
        if (body.companyIsKleinunternehmer !== true) throw new Error("KU expected true");
        if (body.exemptionText !== marker) {
          throw new Error(`exemptionText must be live, got ${JSON.stringify(body.exemptionText)}`);
        }
      } finally {
        await prisma.companySettings.update({
          where: { id: "default" },
          data: { invoiceExemptionText: exemptionBefore, isKleinunternehmer: true },
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
        data: {
          bonusPlusEnabled: bonusPlusEnabledBefore,
          couponsEnabled: couponsEnabledBefore,
          isKleinunternehmer: kuBefore,
          invoiceExemptionText: exemptionBefore,
        },
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
    console.log(`\nExecute G1 grandTotal/KU: ${results.length}/${ids.length} PASS`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
