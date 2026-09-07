/**
 * Production placeOrder Slice 3b — Server Recalculation Core (merchandise).
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory + variant)
 * Run (after build): node dist/cart.3b.selftest.js
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
import { Cart3bTestAppModule, cart3bEmailCalls } from "./cart.3b-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { GUEST_KEY_HEADER } from "./cart/cart.types";
import type { CartStateResponse } from "./cart/cart.types";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

type HttpResult = {
  status: number;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
};

const DEFERRED_KEYS = [
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
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
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

function assertNoDeferredFabricated(recalc: CartRecalcResponse): void {
  const obj = recalc as Record<string, unknown>;
  for (const key of DEFERRED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      throw new Error(`deferred field fabricated: ${key}=${JSON.stringify(obj[key])}`);
    }
  }
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"] as const;

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
  let variantId = "";
  let variant2Id = "";
  let productId = "";
  let locationId = "";
  let onHandBefore = 0;
  let priceBefore: Prisma.Decimal | null = null;
  let variantActiveBefore = true;
  let productActiveBefore = true;
  let reservationCountBefore = 0;
  let orderCountBefore = 0;
  let paymentCountBefore = 0;

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

    await prisma.inventory.update({
      where: { id: inv.id },
      data: { quantityOnHand: 10 },
    });
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { isActive: true, price: new Prisma.Decimal("19.99") },
    });
    await prisma.product.update({
      where: { id: productId },
      data: { isActive: true },
    });

    // Second sellable variant for mixed-line scenarios (ephemeral)
    const v2 = await prisma.productVariant.create({
      data: {
        productId,
        sku: `SKU-3B-${stamp}`,
        name: "3b-extra",
        price: new Prisma.Decimal("5.50"),
        weightGrams: 100,
        isActive: true,
      },
    });
    variant2Id = v2.id;
    await prisma.inventory.create({
      data: {
        locationId,
        variantId: variant2Id,
        quantityOnHand: 10,
      },
    });

    reservationCountBefore = await prisma.reservation.count();
    orderCountBefore = await prisma.order.count();
    paymentCountBefore = await prisma.payment.count();
    cart3bEmailCalls.reset();

    const guestKey = () => `gk_3b_${stamp}_${randomBytes(4).toString("hex")}`;

    // R1 — valid cart merchandise calculation
    await run("R1", async () => {
      const gk = guestKey();
      const created = await call(server, "GET", "/v1/cart", { guestKey: gk });
      createdCartIds.push(asCart(created.body).id);
      const add = await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 2 },
      });
      if (add.status !== 200 && add.status !== 201) {
        throw new Error(`add ${add.status} ${JSON.stringify(add.body)}`);
      }
      const recalc = await call(server, "POST", "/v1/cart/recalculate", { guestKey: gk, json: { shippingCountryCode: "DE" } });
      if (recalc.status !== 200) {
        throw new Error(`recalc ${recalc.status} ${JSON.stringify(recalc.body)}`);
      }
      const body = asRecalc(recalc.body);
      if (body.currencyCode !== "EUR") throw new Error("currency");
      if (body.lines.length !== 1) throw new Error("lines length");
      if (body.lines[0].variantId !== variantId) throw new Error("variantId");
      if (body.lines[0].quantity !== 2) throw new Error("qty");
      if (body.lines[0].unitPrice !== "19.99") throw new Error(`unitPrice=${body.lines[0].unitPrice}`);
      if (body.lines[0].lineTotal !== "39.98") throw new Error(`lineTotal=${body.lines[0].lineTotal}`);
      if (body.itemsSubtotal !== "39.98") throw new Error(`subtotal=${body.itemsSubtotal}`);
    });

    // R2 — Decimal line totals / subtotal (multi-line)
    await run("R2", async () => {
      const gk = guestKey();
      const created = await call(server, "GET", "/v1/cart", { guestKey: gk });
      createdCartIds.push(asCart(created.body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 3 },
      });
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId: variant2Id, quantity: 2 },
      });
      const recalc = await call(server, "POST", "/v1/cart/recalculate", { guestKey: gk, json: { shippingCountryCode: "DE" } });
      if (recalc.status !== 200) {
        throw new Error(`recalc ${recalc.status} ${JSON.stringify(recalc.body)}`);
      }
      const body = asRecalc(recalc.body);
      // 19.99×3 = 59.97; 5.50×2 = 11.00; sum = 70.97
      const byVariant = new Map(body.lines.map((l) => [l.variantId, l]));
      const a = byVariant.get(variantId);
      const b = byVariant.get(variant2Id);
      if (!a || a.lineTotal !== "59.97") throw new Error(`lineA=${a?.lineTotal}`);
      if (!b || b.lineTotal !== "11.00") throw new Error(`lineB=${b?.lineTotal}`);
      if (body.itemsSubtotal !== "70.97") throw new Error(`subtotal=${body.itemsSubtotal}`);
    });

    // R3 — inactive product/variant rejection (Catalog semantics)
    await run("R3", async () => {
      const gk = guestKey();
      const created = await call(server, "GET", "/v1/cart", { guestKey: gk });
      createdCartIds.push(asCart(created.body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      await prisma.productVariant.update({
        where: { id: variantId },
        data: { isActive: false },
      });
      try {
        const recalc = await call(server, "POST", "/v1/cart/recalculate", { guestKey: gk, json: { shippingCountryCode: "DE" } });
        if (recalc.status === 200) throw new Error("inactive variant should reject");
        if (recalc.status !== 404) {
          throw new Error(`expected 404 got ${recalc.status}`);
        }
        if (errCode(recalc.body) !== "NOT_FOUND") {
          throw new Error(`code=${errCode(recalc.body)}`);
        }
      } finally {
        await prisma.productVariant.update({
          where: { id: variantId },
          data: { isActive: true },
        });
      }

      await prisma.product.update({ where: { id: productId }, data: { isActive: false } });
      try {
        const recalc = await call(server, "POST", "/v1/cart/recalculate", { guestKey: gk, json: { shippingCountryCode: "DE" } });
        if (recalc.status === 200) throw new Error("inactive product should reject");
        if (recalc.status !== 404) {
          throw new Error(`expected 404 product got ${recalc.status}`);
        }
      } finally {
        await prisma.product.update({ where: { id: productId }, data: { isActive: true } });
      }
    });

    // R4 — insufficient stock + available
    await run("R4", async () => {
      const gk = guestKey();
      const created = await call(server, "GET", "/v1/cart", { guestKey: gk });
      createdCartIds.push(asCart(created.body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 2 },
      });
      // Drop available below cart qty without removing cart line
      await prisma.inventory.update({
        where: { locationId_variantId: { locationId, variantId } },
        data: { quantityOnHand: 1 },
      });
      try {
        const recalc = await call(server, "POST", "/v1/cart/recalculate", { guestKey: gk, json: { shippingCountryCode: "DE" } });
        if (recalc.status !== 409) throw new Error(`expected 409 got ${recalc.status}`);
        if (errCode(recalc.body) !== "STOCK_LIMIT_EXCEEDED") {
          throw new Error(`code=${errCode(recalc.body)}`);
        }
        const available = (recalc.body as { available?: number }).available;
        if (available !== 1) throw new Error(`available=${available}`);
      } finally {
        await prisma.inventory.update({
          where: { locationId_variantId: { locationId, variantId } },
          data: { quantityOnHand: 10 },
        });
      }
    });

    // R5 — mixed valid + invalid → whole operation rejected
    await run("R5", async () => {
      const gk = guestKey();
      const created = await call(server, "GET", "/v1/cart", { guestKey: gk });
      const cartId = asCart(created.body).id;
      createdCartIds.push(cartId);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId: variant2Id, quantity: 1 },
      });
      await prisma.productVariant.update({
        where: { id: variant2Id },
        data: { isActive: false },
      });
      try {
        const recalc = await call(server, "POST", "/v1/cart/recalculate", { guestKey: gk, json: { shippingCountryCode: "DE" } });
        if (recalc.status === 200) throw new Error("mixed cart must reject entirely");
        if (recalc.status !== 404) throw new Error(`expected 404 got ${recalc.status}`);
        const after = await call(server, "GET", "/v1/cart", { guestKey: gk });
        const items = asCart(after.body).items;
        if (items.length !== 2) throw new Error(`cart mutated items=${items.length}`);
      } finally {
        await prisma.productVariant.update({
          where: { id: variant2Id },
          data: { isActive: true },
        });
      }
    });

    // R6 — no cart mutation on failed recalculate (stock path)
    await run("R6", async () => {
      const gk = guestKey();
      const created = await call(server, "GET", "/v1/cart", { guestKey: gk });
      createdCartIds.push(asCart(created.body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 3 },
      });
      const before = asCart(
        (await call(server, "GET", "/v1/cart", { guestKey: gk })).body,
      );
      await prisma.inventory.update({
        where: { locationId_variantId: { locationId, variantId } },
        data: { quantityOnHand: 1 },
      });
      try {
        const recalc = await call(server, "POST", "/v1/cart/recalculate", { guestKey: gk, json: { shippingCountryCode: "DE" } });
        if (recalc.status === 200) throw new Error("should fail stock");
        const after = asCart(
          (await call(server, "GET", "/v1/cart", { guestKey: gk })).body,
        );
        if (after.items.length !== before.items.length) throw new Error("item count changed");
        if (after.items[0].quantity !== 3) throw new Error("qty changed");
        if (after.items[0].variantId !== variantId) throw new Error("variant removed");
      } finally {
        await prisma.inventory.update({
          where: { locationId_variantId: { locationId, variantId } },
          data: { quantityOnHand: 10 },
        });
      }
    });

    // R7 — no Reservation / Order / Payment / Email side effects from recalculate
    await run("R7", async () => {
      const gk = guestKey();
      const created = await call(server, "GET", "/v1/cart", { guestKey: gk });
      createdCartIds.push(asCart(created.body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      const emailAuthBefore = cart3bEmailCalls.auth;
      const emailOcBefore = cart3bEmailCalls.orderConfirmation;
      const recalc = await call(server, "POST", "/v1/cart/recalculate", { guestKey: gk, json: { shippingCountryCode: "DE" } });
      if (recalc.status !== 200) throw new Error(`recalc ${recalc.status}`);
      if ((await prisma.reservation.count()) !== reservationCountBefore) {
        throw new Error("Reservation side effect");
      }
      if ((await prisma.order.count()) !== orderCountBefore) throw new Error("Order side effect");
      if ((await prisma.payment.count()) !== paymentCountBefore) {
        throw new Error("Payment side effect");
      }
      if (cart3bEmailCalls.auth !== emailAuthBefore) throw new Error("Auth email side effect");
      if (cart3bEmailCalls.orderConfirmation !== emailOcBefore) {
        throw new Error("Order confirmation email side effect");
      }
    });

    // R8 — deferred fields not fabricated
    await run("R8", async () => {
      const gk = guestKey();
      const created = await call(server, "GET", "/v1/cart", { guestKey: gk });
      createdCartIds.push(asCart(created.body).id);
      await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      const recalc = await call(server, "POST", "/v1/cart/recalculate", { guestKey: gk, json: { shippingCountryCode: "DE" } });
      if (recalc.status !== 200) throw new Error(`recalc ${recalc.status}`);
      assertNoDeferredFabricated(asRecalc(recalc.body));
      const keys = Object.keys(recalc.body as object).sort();
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
        throw new Error(`unexpected keys ${keys.join(",")}`);
      }
      if (typeof asRecalc(recalc.body).shippingTotal !== "string") {
        throw new Error("shippingTotal missing after 3c");
      }
    });

    // R9 — 3a regression (add/update gates still work; CartState ≠ full totals)
    await run("R9", async () => {
      const gk = guestKey();
      const get1 = await call(server, "GET", "/v1/cart", { guestKey: gk });
      if (get1.status !== 200) throw new Error(`GET ${get1.status}`);
      createdCartIds.push(asCart(get1.body).id);
      const add = await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 1 },
      });
      if (add.status !== 200 && add.status !== 201) throw new Error(`add ${add.status}`);
      const state = asCart(add.body);
      if (!("items" in state) || "lines" in (state as object)) {
        // CartStateResponse uses items, not lines
      }
      if ((state as unknown as { lines?: unknown }).lines !== undefined) {
        throw new Error("CartState must not expose recalc lines");
      }
      if ((state as unknown as { itemsSubtotal?: unknown }).itemsSubtotal !== undefined) {
        throw new Error("CartState must not expose itemsSubtotal");
      }
      const oos = await call(server, "POST", "/v1/cart/items", {
        guestKey: gk,
        json: { variantId, quantity: 99 },
      });
      if (oos.status !== 409) throw new Error(`3a stock gate ${oos.status}`);
      if (errCode(oos.body) !== "STOCK_LIMIT_EXCEEDED") {
        throw new Error(`3a code=${errCode(oos.body)}`);
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
      for (const userId of createdUserIds) {
        const cart = await prisma.cart.findUnique({ where: { userId } });
        if (cart) {
          await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
          await prisma.cart.delete({ where: { id: cart.id } }).catch(() => undefined);
        }
        await prisma.session.deleteMany({ where: { userId } });
        await prisma.userRole.deleteMany({ where: { userId } });
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      }
      if (variant2Id) {
        await prisma.cartItem.deleteMany({ where: { variantId: variant2Id } });
        await prisma.inventory.deleteMany({ where: { variantId: variant2Id } });
        await prisma.productVariant.delete({ where: { id: variant2Id } }).catch(() => undefined);
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
    } catch (restoreErr) {
      console.error("restore failed", restoreErr);
    }
    await app.close();
  }

  printSummary(results);
  const failed = results.some((r) => r.status !== "PASS");
  if (failed || results.length !== ids.length) process.exit(1);
  console.log("\nSlice 3b Server Recalculation Core: ALL PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
