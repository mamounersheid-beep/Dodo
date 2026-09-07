/**
 * Production placeOrder Slice 3c — Shipping DE + Free Shipping.
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory + DE shipping + FreeShippingThreshold)
 * Run (after build): node dist/cart.3c.selftest.js
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { Prisma } from "@dodo/database";
import type { CartRecalcResponse } from "@dodo/shared-types";
import { Cart3bTestAppModule } from "./cart.3b-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { GUEST_KEY_HEADER } from "./cart/cart.types";
import type { CartStateResponse } from "./cart/cart.types";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

type HttpResult = {
  status: number;
  body: unknown;
};

const DEFERRED_ABSENT = [
  "discountCoupon",
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

function assertDeferredAbsent(body: CartRecalcResponse): void {
  const obj = body as Record<string, unknown>;
  for (const key of DEFERRED_ABSENT) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      throw new Error(`deferred fabricated: ${key}=${JSON.stringify(obj[key])}`);
    }
  }
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"] as const;

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
  let variantId = "";
  let productId = "";
  let locationId = "";
  let onHandBefore = 0;
  let priceBefore: Prisma.Decimal | null = null;
  let variantActiveBefore = true;
  let productActiveBefore = true;
  let methodId = "";
  let methodActiveBefore = true;
  let rateId = "";
  let ratePriceBefore: Prisma.Decimal | null = null;
  let thresholdAmountBefore: Prisma.Decimal | null = null;

  const guestKey = () => `gk_3c_${stamp}_${randomBytes(4).toString("hex")}`;

  const recalc = (gk: string, country?: string | null) => {
    if (country === null) {
      return call(server, "POST", "/v1/cart/recalculate", { guestKey: gk, json: {} });
    }
    if (country === undefined) {
      return call(server, "POST", "/v1/cart/recalculate", { guestKey: gk });
    }
    return call(server, "POST", "/v1/cart/recalculate", {
      guestKey: gk,
      json: { shippingCountryCode: country },
    });
  };

  try {
    const inv = await prisma.inventory.findFirst({
      include: { location: true, variant: { include: { product: true } } },
    });
    if (!inv || inv.location.code !== "MAIN") {
      throw new Error("MAIN inventory + variant required — seed");
    }
    variantId = inv.variantId;
    locationId = inv.locationId;
    onHandBefore = inv.quantityOnHand;
    priceBefore = inv.variant.price;
    variantActiveBefore = inv.variant.isActive;
    productId = inv.variant.productId;
    productActiveBefore = inv.variant.product.isActive;

    const method = await prisma.shippingMethod.findUnique({ where: { code: "standard" } });
    if (!method) throw new Error("standard ShippingMethod required — seed");
    methodId = method.id;
    methodActiveBefore = method.isActive;

    const zone = await prisma.shippingZone.findFirst({ where: { countryCode: "DE" } });
    if (!zone) throw new Error("DE ShippingZone required — seed");
    const rate = await prisma.shippingRate.findFirst({
      where: { zoneId: zone.id, methodId: method.id },
    });
    if (!rate) throw new Error("DE standard ShippingRate required — seed");
    rateId = rate.id;
    ratePriceBefore = rate.price;

    const thr = await prisma.freeShippingThreshold.findFirst({
      where: { countryCode: "DE", currencyCode: "EUR" },
    });
    if (!thr) throw new Error("FreeShippingThreshold DE/EUR required — seed");
    thresholdAmountBefore = thr.minOrderAmount;

    await prisma.inventory.update({
      where: { id: inv.id },
      data: { quantityOnHand: 50 },
    });
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { isActive: true, price: new Prisma.Decimal("19.99") },
    });
    await prisma.product.update({ where: { id: productId }, data: { isActive: true } });
    await prisma.shippingMethod.update({
      where: { id: methodId },
      data: { isActive: true },
    });
    // Known DB price for S7 — must not appear as code literal dependency beyond reading DB
    await prisma.shippingRate.update({
      where: { id: rateId },
      data: { price: new Prisma.Decimal("4.90") },
    });
    await prisma.freeShippingThreshold.update({
      where: { id: thr.id },
      data: { minOrderAmount: new Prisma.Decimal("70.00") },
    });

    const dbRatePrice = (
      await prisma.shippingRate.findUniqueOrThrow({ where: { id: rateId } })
    ).price.toFixed(2);
    const dbThreshold = (
      await prisma.freeShippingThreshold.findFirstOrThrow({
        where: { countryCode: "DE", currencyCode: "EUR" },
      })
    ).minOrderAmount.toFixed(2);

    // S1 — DE + standard + below threshold → paid Rate price
    await run("S1", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      const res = await recalc(gk, "DE");
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecalc(res.body);
      if (body.itemsSubtotal !== "19.99") throw new Error(`subtotal ${body.itemsSubtotal}`);
      if (body.shippingTotal !== dbRatePrice) {
        throw new Error(`shippingTotal=${body.shippingTotal} expected DB ${dbRatePrice}`);
      }
    });

    // S2 — at/above threshold → 0.00
    await run("S2", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      // 19.99 × 4 = 79.96 ≥ 70
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 4 },
      });
      const res = await recalc(gk, "DE");
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecalc(res.body);
      if (body.itemsSubtotal !== "79.96") throw new Error(`subtotal ${body.itemsSubtotal}`);
      if (body.shippingTotal !== "0.00") throw new Error(`shipping=${body.shippingTotal}`);
      if (dbThreshold !== "70.00") throw new Error("test assumes threshold 70 from DB");
    });

    // S3 — below threshold → paid (explicit)
    await run("S3", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 2 },
      });
      const res = await recalc(gk, "DE");
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecalc(res.body);
      if (body.itemsSubtotal !== "39.98") throw new Error(`subtotal ${body.itemsSubtotal}`);
      if (body.shippingTotal !== dbRatePrice) {
        throw new Error(`expected paid ${dbRatePrice} got ${body.shippingTotal}`);
      }
    });

    // S4 — missing country
    await run("S4", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      const noBody = await recalc(gk, undefined);
      if (noBody.status !== 400) throw new Error(`no body expected 400 got ${noBody.status}`);
      const empty = await recalc(gk, null);
      if (empty.status !== 400) throw new Error(`empty expected 400 got ${empty.status}`);
    });

    // S5 — non-DE
    await run("S5", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      const res = await recalc(gk, "FR");
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
      if (errCode(res.body) !== "SHIPPING_COUNTRY_NOT_SUPPORTED") {
        throw new Error(`code=${errCode(res.body)}`);
      }
    });

    // S6 — inactive method / missing matching rate
    await run("S6", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      await prisma.shippingMethod.update({
        where: { id: methodId },
        data: { isActive: false },
      });
      try {
        const res = await recalc(gk, "DE");
        if (res.status === 200) throw new Error("inactive method should reject");
        if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
        if (errCode(res.body) !== "SHIPPING_RATE_UNAVAILABLE") {
          throw new Error(`code=${errCode(res.body)}`);
        }
      } finally {
        await prisma.shippingMethod.update({
          where: { id: methodId },
          data: { isActive: true },
        });
      }
    });

    // S7 — rate price from DB (mutate DB price, assert response follows)
    await run("S7", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      const altered = new Prisma.Decimal("6.55");
      await prisma.shippingRate.update({
        where: { id: rateId },
        data: { price: altered },
      });
      try {
        const res = await recalc(gk, "DE");
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const ship = asRecalc(res.body).shippingTotal;
        if (ship !== "6.55") throw new Error(`expected 6.55 from DB got ${ship}`);
        // Prove value tracks DB mutation (not a fixed engine constant).
        const live = (
          await prisma.shippingRate.findUniqueOrThrow({ where: { id: rateId } })
        ).price.toFixed(2);
        if (ship !== live) throw new Error(`response ${ship} != live DB ${live}`);
      } finally {
        await prisma.shippingRate.update({
          where: { id: rateId },
          data: { price: new Prisma.Decimal("4.90") },
        });
      }
    });

    // S8 — cart unchanged on shipping reject
    await run("S8", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 2 },
      });
      const before = asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body);
      const fail = await recalc(gk, "AT");
      if (fail.status === 200) throw new Error("should reject AT");
      const after = asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body);
      if (after.items.length !== before.items.length) throw new Error("item count changed");
      if (after.items[0].quantity !== 2) throw new Error("qty mutated");
    });

    // S9 — deferred fields absent
    await run("S9", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      const res = await recalc(gk, "DE");
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      assertDeferredAbsent(asRecalc(res.body));
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
        throw new Error(`keys ${keys.join(",")}`);
      }
    });

    // S10 — 3b regression with shippingCountryCode
    await run("S10", async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      const add = await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 2 },
      });
      if (add.status !== 200 && add.status !== 201) throw new Error(`add ${add.status}`);
      const state = asCart(add.body);
      if ((state as unknown as { shippingTotal?: unknown }).shippingTotal !== undefined) {
        throw new Error("CartState must not expose shippingTotal");
      }
      const res = await recalc(gk, "DE");
      if (res.status !== 200) throw new Error(`recalc ${res.status}`);
      const body = asRecalc(res.body);
      if (body.lines.length !== 1 || body.lines[0].lineTotal !== "39.98") {
        throw new Error("merchandise regression");
      }
      if (typeof body.shippingTotal !== "string") throw new Error("shippingTotal required");
      const oos = await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 99 },
      });
      if (oos.status !== 409) throw new Error(`stock gate ${oos.status}`);
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
      if (variantId && priceBefore) {
        await prisma.productVariant.update({
          where: { id: variantId },
          data: { isActive: variantActiveBefore, price: priceBefore },
        });
      }
      if (productId) {
        await prisma.product.update({
          where: { id: productId },
          data: { isActive: productActiveBefore },
        });
      }
      if (locationId && variantId) {
        await prisma.inventory.update({
          where: { locationId_variantId: { locationId, variantId } },
          data: { quantityOnHand: onHandBefore },
        });
      }
      if (methodId) {
        await prisma.shippingMethod.update({
          where: { id: methodId },
          data: { isActive: methodActiveBefore },
        });
      }
      if (rateId && ratePriceBefore) {
        await prisma.shippingRate.update({
          where: { id: rateId },
          data: { price: ratePriceBefore },
        });
      }
      if (thresholdAmountBefore) {
        const t = await prisma.freeShippingThreshold.findFirst({
          where: { countryCode: "DE", currencyCode: "EUR" },
        });
        if (t) {
          await prisma.freeShippingThreshold.update({
            where: { id: t.id },
            data: { minOrderAmount: thresholdAmountBefore },
          });
        }
      }
    } catch (restoreErr) {
      console.error("restore failed", restoreErr);
    }
    await app.close();
  }

  printSummary(results);
  const failed = results.some((r) => r.status !== "PASS");
  if (failed || results.length !== ids.length) process.exit(1);
  console.log("\nSlice 3c Shipping DE + Free Shipping: ALL PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
