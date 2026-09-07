/**
 * Production placeOrder Slice 3a — Cart Persistence + Sellability/Stock Gates.
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory + variant)
 * Run (after build): node dist/cart.3a.selftest.js
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { Cart3aTestAppModule } from "./cart.3a-test.module";
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

function errCode(body: unknown): string | undefined {
  return (body as { code?: string })?.code;
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = [
    "C1",
    "C2",
    "C3",
    "C4",
    "C5",
    "C6",
    "C7",
    "C8",
    "C9",
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

  const app = await NestFactory.create(Cart3aTestAppModule, { logger: false });
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
  const createdCartIds: string[] = [];
  let variantId = "";
  let locationId = "";
  let onHandBefore = 0;
  let variantActiveBefore = true;
  let productId = "";
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
    variantActiveBefore = inv.variant.isActive;
    productId = inv.variant.productId;
    productActiveBefore = inv.variant.product.isActive;

    await prisma.inventory.update({
      where: { id: inv.id },
      data: { quantityOnHand: 5 },
    });
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { isActive: true },
    });
    await prisma.product.update({
      where: { id: productId },
      data: { isActive: true },
    });

    reservationCountBefore = await prisma.reservation.count();
    orderCountBefore = await prisma.order.count();
    paymentCountBefore = await prisma.payment.count();

    const register = async (email: string) => {
      const res = await call(server, "POST", "/v1/auth/register", {
        json: { email, password: "TestPass123!", name: "Cart3a", locale: "de" },
      });
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
      }
      const accessToken = (res.body as { accessToken?: string }).accessToken;
      const userId = (res.body as { user?: { id?: string } }).user?.id;
      if (!accessToken || !userId) throw new Error("register missing token/user");
      createdUserIds.push(userId);
      return { accessToken, userId };
    };

    await run("C1", async () => {
      const { accessToken, userId } = await register(`cart3a-reg-${stamp}@test.invalid`);
      const get1 = await call(server, "GET", "/v1/cart", { bearer: accessToken });
      if (get1.status !== 200) throw new Error(`GET cart ${get1.status}`);
      const c1 = asCart(get1.body);
      if (c1.identity.type !== "user" || c1.identity.userId !== userId) {
        throw new Error("registered identity mismatch");
      }
      if (c1.currencyCode !== "EUR") throw new Error("currency");
      createdCartIds.push(c1.id);

      const add = await call(server, "POST", "/v1/cart/items", {
        bearer: accessToken,
        json: { variantId, quantity: 2 },
      });
      if (add.status !== 200 && add.status !== 201) {
        throw new Error(`add ${add.status} ${JSON.stringify(add.body)}`);
      }
      const c2 = asCart(add.body);
      if (c2.items.length !== 1 || c2.items[0].quantity !== 2) {
        throw new Error("add qty");
      }

      const upd = await call(server, "PATCH", `/v1/cart/items/${variantId}`, {
        bearer: accessToken,
        json: { quantity: 3 },
      });
      if (upd.status !== 200) throw new Error(`update ${upd.status}`);
      if (asCart(upd.body).items[0].quantity !== 3) throw new Error("update qty");

      const del = await call(server, "DELETE", `/v1/cart/items/${variantId}`, {
        bearer: accessToken,
      });
      if (del.status !== 200) throw new Error(`delete ${del.status}`);
      if (asCart(del.body).items.length !== 0) throw new Error("delete leftover");
    });

    await run("C2", async () => {
      const guestKey = `gk_test_${stamp}_${randomBytes(4).toString("hex")}`;
      const get1 = await call(server, "GET", "/v1/cart", { guestKey });
      if (get1.status !== 200) throw new Error(`guest GET ${get1.status}`);
      const c1 = asCart(get1.body);
      if (c1.identity.type !== "guest" || c1.identity.guestKey !== guestKey) {
        throw new Error("guest identity");
      }
      createdCartIds.push(c1.id);

      const add = await call(server, "POST", "/v1/cart/items", {
        guestKey,
        json: { variantId, quantity: 1 },
      });
      if (add.status !== 200 && add.status !== 201) {
        throw new Error(`guest add ${add.status} ${JSON.stringify(add.body)}`);
      }
      if (asCart(add.body).items[0].quantity !== 1) throw new Error("guest qty");

      const del = await call(server, "DELETE", `/v1/cart/items/${variantId}`, { guestKey });
      if (del.status !== 200) throw new Error(`guest delete ${del.status}`);
    });

    await run("C3", async () => {
      const guestKey = `gk_dup_${stamp}_${randomBytes(4).toString("hex")}`;
      await call(server, "GET", "/v1/cart", { guestKey });
      await call(server, "POST", "/v1/cart/items", {
        guestKey,
        json: { variantId, quantity: 1 },
      });
      const add2 = await call(server, "POST", "/v1/cart/items", {
        guestKey,
        json: { variantId, quantity: 2 },
      });
      const cart = asCart(add2.body);
      if (cart.items.length !== 1) throw new Error("duplicate must be one row");
      if (cart.items[0].quantity !== 3) throw new Error(`accum expected 3 got ${cart.items[0].quantity}`);
      const rows = await prisma.cartItem.count({
        where: { cartId: cart.id, variantId },
      });
      if (rows !== 1) throw new Error("DB duplicate rows");
      await call(server, "DELETE", `/v1/cart/items/${variantId}`, { guestKey });
    });

    await run("C4", async () => {
      const guestKey = `gk_inact_${stamp}_${randomBytes(4).toString("hex")}`;
      await call(server, "GET", "/v1/cart", { guestKey });
      await prisma.productVariant.update({
        where: { id: variantId },
        data: { isActive: false },
      });
      try {
        const res = await call(server, "POST", "/v1/cart/items", {
          guestKey,
          json: { variantId, quantity: 1 },
        });
        if (res.status === 200 || res.status === 201) {
          throw new Error("inactive variant should be rejected");
        }
        if (res.status !== 404) {
          throw new Error(`expected 404 for inactive, got ${res.status}`);
        }
      } finally {
        await prisma.productVariant.update({
          where: { id: variantId },
          data: { isActive: true },
        });
      }

      await prisma.product.update({ where: { id: productId }, data: { isActive: false } });
      try {
        const res = await call(server, "POST", "/v1/cart/items", {
          guestKey,
          json: { variantId, quantity: 1 },
        });
        if (res.status === 200 || res.status === 201) {
          throw new Error("inactive product should be rejected");
        }
        if (res.status !== 404) {
          throw new Error(`expected 404 for inactive product, got ${res.status}`);
        }
      } finally {
        await prisma.product.update({ where: { id: productId }, data: { isActive: true } });
      }
    });

    await run("C5", async () => {
      const guestKey = `gk_oos_${stamp}_${randomBytes(4).toString("hex")}`;
      await call(server, "GET", "/v1/cart", { guestKey });
      const res = await call(server, "POST", "/v1/cart/items", {
        guestKey,
        json: { variantId, quantity: 99 },
      });
      if (res.status !== 409) throw new Error(`expected 409 got ${res.status}`);
      if (errCode(res.body) !== "STOCK_LIMIT_EXCEEDED") {
        throw new Error(`code=${errCode(res.body)}`);
      }
      const available = (res.body as { available?: number }).available;
      if (typeof available !== "number" || available !== 5) {
        throw new Error(`available expected 5 got ${available}`);
      }
    });

    await run("C6", async () => {
      const guestKey = `gk_ok_${stamp}_${randomBytes(4).toString("hex")}`;
      const res = await call(server, "POST", "/v1/cart/items", {
        guestKey,
        json: { variantId, quantity: 2 },
      });
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(`valid add ${res.status} ${JSON.stringify(res.body)}`);
      }
      const cart = asCart(res.body);
      createdCartIds.push(cart.id);
      if (cart.items[0].quantity !== 2) throw new Error("valid qty");
      await call(server, "DELETE", `/v1/cart/items/${variantId}`, { guestKey });
    });

    await run("C7", async () => {
      const guestKey = `gk_qty_${stamp}_${randomBytes(4).toString("hex")}`;
      await call(server, "GET", "/v1/cart", { guestKey });
      const res = await call(server, "POST", "/v1/cart/items", {
        guestKey,
        json: { variantId, quantity: 0 },
      });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
    });

    await run("C8", async () => {
      const reservations = await prisma.reservation.count();
      const orders = await prisma.order.count();
      const payments = await prisma.payment.count();
      if (reservations !== reservationCountBefore) {
        throw new Error("Reservation side effect");
      }
      if (orders !== orderCountBefore) throw new Error("Order side effect");
      if (payments !== paymentCountBefore) throw new Error("Payment side effect");
    });

    await run("C9", async () => {
      // mint guest key path: GET without header creates cart with new guestKey
      const res = await call(server, "GET", "/v1/cart");
      if (res.status !== 200) throw new Error(`mint GET ${res.status}`);
      const cart = asCart(res.body);
      if (cart.identity.type !== "guest" || !cart.identity.guestKey.startsWith("gk_")) {
        throw new Error("minted guestKey missing");
      }
      createdCartIds.push(cart.id);
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
      // leftover carts by guest from failed runs — best effort by users
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
      if (variantId) {
        await prisma.productVariant.update({
          where: { id: variantId },
          data: { isActive: variantActiveBefore },
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
  console.log("\nSlice 3a Cart Persistence + Gates: ALL PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
