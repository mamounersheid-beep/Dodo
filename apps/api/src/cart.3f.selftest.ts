/**
 * Production placeOrder Slice 3f — Cart Merge (F1–F4).
 *
 * Requires: DATABASE_URL (+ seed MAIN location + at least one Category)
 * Run (after build): node dist/cart.3f.selftest.js
 *
 * Scenarios:
 *   M1  — guest-only cart → merged into a freshly created user cart
 *   M2  — no x-guest-key → no-op, user cart unchanged, flag false
 *   M3  — same variant → qty_guest + qty_user accumulation
 *   M4  — availability cap → min(sum, available), flag true
 *   M5  — available=0 on a guest-only line → capped to zero, removed, flag true
 *   M6  — !lineSellable → excluded silently, flag false
 *   M7  — different variants → union
 *   M8  — empty guest cart → 200, guest cart deleted
 *   M9  — all lines excluded → 200, guest cart deleted, flag true (available=0 line)
 *   M10 — unknown/stale guest key → 200 no-op, nothing created or deleted
 *   M11 — repeat merge after success → stale-key no-op, no further accumulation
 *   M12 — concurrent merges of the same guest cart → applied exactly once
 *   M13 — mid-transaction failure → full rollback (no partial merge, no disposal)
 *   M14 — exact flat response shape (CartStateResponse + the F2 flag only)
 *   M15 — merge never prices: no totals, no shippingCountryCode, no side effects
 *   M16 — unauthenticated → 401, guest cart untouched
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { Prisma } from "@dodo/database";
import { Cart3bTestAppModule, cart3bEmailCalls } from "./cart.3b-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { GUEST_KEY_HEADER } from "./cart/cart.types";
import type { CartMergeResponse } from "./cart/cart.types";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

/** F4 — the merge response carries no pricing/totals layer. */
const FORBIDDEN_PRICING_KEYS = [
  "itemsSubtotal",
  "shippingTotal",
  "discountCoupon",
  "discountBonus",
  "grandTotal",
  "bonusPointsAvailable",
  "bonusPointsToRedeem",
  "lines",
  "shippingCountryCode",
  "companyIsKleinunternehmer",
  "exemptionText",
  "deliveryTime",
] as const;

const MERGE_RESPONSE_KEYS = [
  "id",
  "currencyCode",
  "identity",
  "items",
  "quantitiesReducedByAvailability",
] as const;

const ITEM_KEYS = ["variantId", "quantity", "sku", "name", "unitPrice"] as const;

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

function asMerge(body: unknown): CartMergeResponse {
  return body as CartMergeResponse;
}

function qtyOf(body: CartMergeResponse, variantId: string): number | undefined {
  return body.items.find((i) => i.variantId === variantId)?.quantity;
}

function assertNoPricing(body: unknown, label: string): void {
  const obj = body as Record<string, unknown>;
  for (const key of FORBIDDEN_PRICING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new Error(`${label}: merge response must not carry ${key}`);
    }
  }
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = [
    "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8",
    "M9", "M10", "M11", "M12", "M13", "M14", "M15", "M16",
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
  const jwt = app.get(JwtService);

  const createdCartIds: string[] = [];
  const createdUserIds: string[] = [];
  let productId = "";
  let vA = "";
  let vB = "";
  let vC = "";
  let vNoInventory = "";

  const guestKey = () => `gk_3f_${stamp}_${randomBytes(6).toString("hex")}`;
  const userEmail = () => `3f_${stamp}_${randomBytes(4).toString("hex")}@test.local`;

  /** Authenticated fixture user — created directly so the auth throttler is not exercised. */
  const authedUser = async (): Promise<{ bearer: string; userId: string }> => {
    const user = await prisma.user.create({
      data: {
        email: userEmail(),
        passwordHash: `hash_${randomBytes(8).toString("hex")}`,
        locale: "de",
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: randomBytes(16).toString("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const bearer = await jwt.signAsync({ sub: user.id, sid: session.id, roles: [] });
    return { bearer, userId: user.id };
  };

  const mkGuestCart = async (items: Array<{ variantId: string; quantity: number }>) => {
    const gk = guestKey();
    const cart = await prisma.cart.create({ data: { guestKey: gk, currencyCode: "EUR" } });
    createdCartIds.push(cart.id);
    for (const it of items) {
      await prisma.cartItem.create({ data: { cartId: cart.id, ...it } });
    }
    return { gk, cartId: cart.id };
  };

  const mkUserCart = async (
    userId: string,
    items: Array<{ variantId: string; quantity: number }>,
  ) => {
    const cart = await prisma.cart.create({ data: { userId, currencyCode: "EUR" } });
    createdCartIds.push(cart.id);
    for (const it of items) {
      await prisma.cartItem.create({ data: { cartId: cart.id, ...it } });
    }
    return cart.id;
  };

  const setOnHand = async (variantId: string, qty: number) => {
    await prisma.inventory.updateMany({ where: { variantId }, data: { quantityOnHand: qty } });
  };

  const setVariantActive = async (variantId: string, isActive: boolean) => {
    await prisma.productVariant.update({ where: { id: variantId }, data: { isActive } });
  };

  const merge = (bearer?: string, gk?: string, json?: unknown) =>
    call(server, "POST", "/v1/cart/merge", { bearer, guestKey: gk, json });

  const cartExists = async (cartId: string) =>
    (await prisma.cart.findUnique({ where: { id: cartId } })) !== null;

  const dbItems = async (cartId: string) =>
    prisma.cartItem.findMany({ where: { cartId }, orderBy: { variantId: "asc" } });

  try {
    // ── Fixtures — dedicated product/variants so seed data is never mutated ──
    const location = await prisma.location.findFirst({ where: { code: "MAIN", isActive: true } });
    if (!location) throw new Error("Active MAIN location required — seed");
    const category = await prisma.category.findFirst();
    if (!category) throw new Error("At least one Category required — seed");

    const product = await prisma.product.create({
      data: {
        categoryId: category.id,
        slug: `3f-merge-${stamp}`,
        name: `3F Merge ${stamp}`,
        description: "Slice 3f merge fixtures",
        isActive: true,
      },
    });
    productId = product.id;

    const mkVariant = async (tag: string, price: string, withInventory: boolean) => {
      const v = await prisma.productVariant.create({
        data: {
          productId,
          sku: `3F-${tag}-${stamp}`,
          name: `3F ${tag}`,
          price: new Prisma.Decimal(price),
          weightGrams: 100,
          isActive: true,
        },
      });
      if (withInventory) {
        await prisma.inventory.create({
          data: { locationId: location.id, variantId: v.id, quantityOnHand: 50 },
        });
      }
      return v.id;
    };

    vA = await mkVariant("A", "10.00", true);
    vB = await mkVariant("B", "20.00", true);
    vC = await mkVariant("C", "30.00", true);
    vNoInventory = await mkVariant("N", "40.00", false);

    cart3bEmailCalls.reset();

    // ── M1 — guest-only cart merged into a freshly created user cart ──────
    await run("M1", async () => {
      await setOnHand(vA, 50);
      const { bearer, userId } = await authedUser();
      const { gk, cartId: guestCartId } = await mkGuestCart([{ variantId: vA, quantity: 2 }]);

      const res = await merge(bearer, gk);
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asMerge(res.body);
      if (body.identity.type !== "user") throw new Error(`identity ${body.identity.type}`);
      if (body.identity.userId !== userId) throw new Error("identity userId mismatch");
      if (body.items.length !== 1) throw new Error(`items ${body.items.length}`);
      if (qtyOf(body, vA) !== 2) throw new Error(`qty ${qtyOf(body, vA)}`);
      if (body.quantitiesReducedByAvailability !== false) throw new Error("flag must be false");
      if (await cartExists(guestCartId)) throw new Error("guest cart not deleted");
      if ((await prisma.cartItem.count({ where: { cartId: guestCartId } })) !== 0) {
        throw new Error("guest CartItems survived");
      }
      const userCart = await prisma.cart.findUnique({ where: { userId } });
      if (!userCart) throw new Error("user cart not created");
      createdCartIds.push(userCart.id);
    });

    // ── M2 — no x-guest-key → no-op, user cart unchanged ─────────────────
    await run("M2", async () => {
      await setOnHand(vA, 50);
      const { bearer, userId } = await authedUser();
      const userCartId = await mkUserCart(userId, [{ variantId: vA, quantity: 3 }]);

      const res = await merge(bearer, undefined);
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asMerge(res.body);
      if (body.id !== userCartId) throw new Error("must return the user cart");
      if (qtyOf(body, vA) !== 3) throw new Error(`qty ${qtyOf(body, vA)} — must be unchanged`);
      if (body.quantitiesReducedByAvailability !== false) throw new Error("flag must be false");
      const after = await dbItems(userCartId);
      if (after.length !== 1 || after[0].quantity !== 3) throw new Error("user cart mutated");
    });

    // ── M3 — same variant accumulation ───────────────────────────────────
    await run("M3", async () => {
      await setOnHand(vA, 50);
      const { bearer, userId } = await authedUser();
      const userCartId = await mkUserCart(userId, [{ variantId: vA, quantity: 3 }]);
      const { gk, cartId: guestCartId } = await mkGuestCart([{ variantId: vA, quantity: 2 }]);

      const res = await merge(bearer, gk);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asMerge(res.body);
      if (body.id !== userCartId) throw new Error("user cart must be the surviving cart");
      if (qtyOf(body, vA) !== 5) throw new Error(`expected 5 got ${qtyOf(body, vA)}`);
      if (body.quantitiesReducedByAvailability !== false) throw new Error("flag must be false");
      if (await cartExists(guestCartId)) throw new Error("guest cart not deleted");
    });

    // ── M4 — availability cap: min(4 + 3, 5) = 5, flag true ──────────────
    await run("M4", async () => {
      await setOnHand(vA, 5);
      const { bearer, userId } = await authedUser();
      const userCartId = await mkUserCart(userId, [{ variantId: vA, quantity: 3 }]);
      const { gk, cartId: guestCartId } = await mkGuestCart([{ variantId: vA, quantity: 4 }]);

      const res = await merge(bearer, gk);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asMerge(res.body);
      if (qtyOf(body, vA) !== 5) throw new Error(`expected cap 5 got ${qtyOf(body, vA)}`);
      if (body.quantitiesReducedByAvailability !== true) throw new Error("flag must be true");
      const after = await dbItems(userCartId);
      if (after.length !== 1 || after[0].quantity !== 5) throw new Error("persisted qty != 5");
      if (await cartExists(guestCartId)) throw new Error("guest cart not deleted");
      await setOnHand(vA, 50);
    });

    // ── M5 — available=0 on a guest-only line → removed, flag true ───────
    await run("M5", async () => {
      await setOnHand(vA, 0);
      const { bearer, userId } = await authedUser();
      const { gk, cartId: guestCartId } = await mkGuestCart([{ variantId: vA, quantity: 2 }]);

      const res = await merge(bearer, gk);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asMerge(res.body);
      if (body.items.length !== 0) throw new Error(`items must be empty, got ${body.items.length}`);
      if (body.quantitiesReducedByAvailability !== true) {
        throw new Error("flag must be true for a line capped to zero");
      }
      if (await cartExists(guestCartId)) throw new Error("guest cart not deleted");
      const userCart = await prisma.cart.findUnique({ where: { userId } });
      if (!userCart) throw new Error("user cart missing");
      createdCartIds.push(userCart.id);
      if ((await dbItems(userCart.id)).length !== 0) throw new Error("zero-capped line persisted");
      await setOnHand(vA, 50);
    });

    // ── M6 — !lineSellable → excluded silently (flag stays false) ────────
    await run("M6", async () => {
      await setOnHand(vB, 50);
      await setVariantActive(vB, false);
      try {
        const { bearer, userId } = await authedUser();
        const { gk, cartId: guestCartId } = await mkGuestCart([{ variantId: vB, quantity: 2 }]);

        const res = await merge(bearer, gk);
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const body = asMerge(res.body);
        if (body.items.length !== 0) throw new Error("non-sellable line must be excluded");
        if (body.quantitiesReducedByAvailability !== false) {
          throw new Error("eligibility exclusion must stay silent");
        }
        if (await cartExists(guestCartId)) throw new Error("guest cart not deleted");
        const userCart = await prisma.cart.findUnique({ where: { userId } });
        if (userCart) createdCartIds.push(userCart.id);
      } finally {
        await setVariantActive(vB, true);
      }
    });

    // ── M7 — different variants → union ──────────────────────────────────
    await run("M7", async () => {
      await setOnHand(vA, 50);
      await setOnHand(vB, 50);
      await setOnHand(vC, 50);
      const { bearer, userId } = await authedUser();
      const userCartId = await mkUserCart(userId, [{ variantId: vC, quantity: 3 }]);
      const { gk, cartId: guestCartId } = await mkGuestCart([
        { variantId: vA, quantity: 1 },
        { variantId: vB, quantity: 2 },
      ]);

      const res = await merge(bearer, gk);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asMerge(res.body);
      if (body.items.length !== 3) throw new Error(`union expected 3 lines got ${body.items.length}`);
      if (qtyOf(body, vA) !== 1) throw new Error(`vA ${qtyOf(body, vA)}`);
      if (qtyOf(body, vB) !== 2) throw new Error(`vB ${qtyOf(body, vB)}`);
      if (qtyOf(body, vC) !== 3) throw new Error(`vC ${qtyOf(body, vC)}`);
      if (body.quantitiesReducedByAvailability !== false) throw new Error("flag must be false");
      if (await cartExists(guestCartId)) throw new Error("guest cart not deleted");
      void userCartId;
    });

    // ── M8 — empty guest cart → 200 + disposal ───────────────────────────
    await run("M8", async () => {
      await setOnHand(vA, 50);
      const { bearer, userId } = await authedUser();
      const userCartId = await mkUserCart(userId, [{ variantId: vA, quantity: 2 }]);
      const { gk, cartId: guestCartId } = await mkGuestCart([]);

      const res = await merge(bearer, gk);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asMerge(res.body);
      if (qtyOf(body, vA) !== 2) throw new Error("user cart must be unchanged");
      if (body.quantitiesReducedByAvailability !== false) throw new Error("flag must be false");
      if (await cartExists(guestCartId)) throw new Error("empty guest cart must be deleted");
      void userCartId;
    });

    // ── M9 — all lines excluded → 200 + disposal, flag true (available=0) ─
    await run("M9", async () => {
      await setOnHand(vB, 50);
      await setOnHand(vC, 0);
      await setVariantActive(vB, false);
      try {
        const { bearer, userId } = await authedUser();
        const { gk, cartId: guestCartId } = await mkGuestCart([
          { variantId: vB, quantity: 2 },
          { variantId: vC, quantity: 1 },
        ]);

        const res = await merge(bearer, gk);
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const body = asMerge(res.body);
        if (body.items.length !== 0) throw new Error("all lines must be excluded");
        // vC is eligible with available=0 → availability reduction per F2
        if (body.quantitiesReducedByAvailability !== true) {
          throw new Error("available=0 on an eligible line must raise the flag");
        }
        if (await cartExists(guestCartId)) throw new Error("guest cart not deleted");
        const userCart = await prisma.cart.findUnique({ where: { userId } });
        if (userCart) createdCartIds.push(userCart.id);
      } finally {
        await setVariantActive(vB, true);
        await setOnHand(vC, 50);
      }
    });

    // ── M10 — unknown/stale guest key → 200 no-op ────────────────────────
    await run("M10", async () => {
      await setOnHand(vA, 50);
      const { bearer, userId } = await authedUser();
      const userCartId = await mkUserCart(userId, [{ variantId: vA, quantity: 4 }]);
      const strayKey = guestKey();

      const res = await merge(bearer, strayKey);
      if (res.status !== 200) throw new Error(`status ${res.status} — stale key must be 2xx`);
      const body = asMerge(res.body);
      if (body.id !== userCartId) throw new Error("must return the user cart");
      if (qtyOf(body, vA) !== 4) throw new Error("user cart mutated");
      if (body.quantitiesReducedByAvailability !== false) throw new Error("flag must be false");
      if (await prisma.cart.findUnique({ where: { guestKey: strayKey } })) {
        throw new Error("merge must not create a cart for an unknown guest key");
      }
    });

    // ── M11 — repeat merge → stale-key no-op, no further accumulation ────
    await run("M11", async () => {
      await setOnHand(vA, 50);
      const { bearer, userId } = await authedUser();
      const userCartId = await mkUserCart(userId, [{ variantId: vA, quantity: 1 }]);
      const { gk } = await mkGuestCart([{ variantId: vA, quantity: 2 }]);

      const first = await merge(bearer, gk);
      if (first.status !== 200) throw new Error(`first status ${first.status}`);
      if (qtyOf(asMerge(first.body), vA) !== 3) throw new Error("first merge qty != 3");

      const second = await merge(bearer, gk);
      if (second.status !== 200) throw new Error(`repeat status ${second.status} — must be 2xx`);
      const body = asMerge(second.body);
      if (qtyOf(body, vA) !== 3) throw new Error(`repeat accumulated: ${qtyOf(body, vA)}`);
      if (body.quantitiesReducedByAvailability !== false) {
        throw new Error("repeat must report false");
      }
      const after = await dbItems(userCartId);
      if (after.length !== 1 || after[0].quantity !== 3) throw new Error("repeat mutated state");
    });

    // ── M12 — concurrent merges → applied exactly once ───────────────────
    await run("M12", async () => {
      await setOnHand(vA, 50);
      const { bearer, userId } = await authedUser();
      const userCartId = await mkUserCart(userId, [{ variantId: vA, quantity: 1 }]);
      const { gk, cartId: guestCartId } = await mkGuestCart([{ variantId: vA, quantity: 2 }]);

      const responses = await Promise.all(
        Array.from({ length: 4 }, () => merge(bearer, gk)),
      );
      const statuses = responses.map((r) => r.status);
      if (statuses.some((s) => s !== 200)) {
        throw new Error(`concurrent statuses ${statuses.join("/")} — all must be 2xx`);
      }
      const after = await dbItems(userCartId);
      if (after.length !== 1) throw new Error(`lines ${after.length}`);
      if (after[0].quantity !== 3) {
        throw new Error(`merge applied more than once: expected 3 got ${after[0].quantity}`);
      }
      if (await cartExists(guestCartId)) throw new Error("guest cart not deleted");
      for (const res of responses) {
        const body = asMerge(res.body);
        if (body.identity.type !== "user") throw new Error("identity must be user");
        if (qtyOf(body, vA) !== 3) throw new Error(`response qty ${qtyOf(body, vA)}`);
      }
    });

    // ── M13 — mid-transaction failure → full rollback ────────────────────
    await run("M13", async () => {
      await setOnHand(vA, 50);
      const { bearer, userId } = await authedUser();
      const userCartId = await mkUserCart(userId, [{ variantId: vC, quantity: 1 }]);
      // vNoInventory has no Inventory row → availability read fails inside the Tx
      const { gk, cartId: guestCartId } = await mkGuestCart([
        { variantId: vA, quantity: 2 },
        { variantId: vNoInventory, quantity: 1 },
      ]);

      const res = await merge(bearer, gk);
      if (res.status < 400) throw new Error(`expected failure, got ${res.status}`);

      // User cart must be untouched (no vA line added, vC intact)
      const userAfter = await dbItems(userCartId);
      if (userAfter.length !== 1) throw new Error(`partial merge applied: ${userAfter.length} lines`);
      if (userAfter[0].variantId !== vC || userAfter[0].quantity !== 1) {
        throw new Error("user cart mutated by a failed merge");
      }
      // Guest cart must not be partially disposed
      if (!(await cartExists(guestCartId))) throw new Error("guest cart disposed on failure");
      const guestAfter = await dbItems(guestCartId);
      if (guestAfter.length !== 2) {
        throw new Error(`guest items partially deleted: ${guestAfter.length}`);
      }
    });

    // ── M14 — exact flat response shape ──────────────────────────────────
    await run("M14", async () => {
      await setOnHand(vA, 50);
      const { bearer } = await authedUser();
      const { gk } = await mkGuestCart([{ variantId: vA, quantity: 1 }]);

      const res = await merge(bearer, gk);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const obj = res.body as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const expected = [...MERGE_RESPONSE_KEYS].sort();
      if (keys.join(",") !== expected.join(",")) {
        throw new Error(`response keys [${keys.join(",")}] != [${expected.join(",")}]`);
      }
      const body = asMerge(res.body);
      if (body.currencyCode !== "EUR") throw new Error(`currencyCode ${body.currencyCode}`);
      if (body.identity.type !== "user") throw new Error("identity must be user");
      if (typeof body.quantitiesReducedByAvailability !== "boolean") {
        throw new Error("flag must be a boolean");
      }
      for (const item of body.items) {
        const itemKeys = Object.keys(item as Record<string, unknown>).sort();
        const expectedItem = [...ITEM_KEYS].sort();
        if (itemKeys.join(",") !== expectedItem.join(",")) {
          throw new Error(`item keys [${itemKeys.join(",")}]`);
        }
      }
      assertNoPricing(res.body, "M14");
      const userCart = await prisma.cart.findUnique({ where: { id: body.id } });
      if (userCart) createdCartIds.push(userCart.id);
    });

    // ── M15 — merge never prices, and has no side effects ────────────────
    await run("M15", async () => {
      await setOnHand(vA, 50);
      const { bearer, userId } = await authedUser();
      const userCartId = await mkUserCart(userId, [{ variantId: vA, quantity: 1 }]);
      const { gk } = await mkGuestCart([{ variantId: vA, quantity: 1 }]);

      cart3bEmailCalls.reset();
      const before = {
        reservation: await prisma.reservation.count(),
        order: await prisma.order.count(),
        movement: await prisma.stockMovement.count(),
        couponUsage: await prisma.couponUsage.count(),
        bonusLedger: await prisma.bonusLedger.count(),
        wishlistItem: await prisma.wishlistItem.count(),
      };
      const invBefore = await prisma.inventory.findFirst({ where: { variantId: vA } });

      // A body is not part of the contract — it must be ignored, never priced.
      const res = await merge(bearer, gk, {
        shippingCountryCode: "DE",
        couponCode: "SAVE5",
        bonusPointsToRedeem: 100,
      });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      assertNoPricing(res.body, "M15");
      if (qtyOf(asMerge(res.body), vA) !== 2) throw new Error("merge did not apply");

      if ((await prisma.reservation.count()) !== before.reservation) throw new Error("Reservation written");
      if ((await prisma.order.count()) !== before.order) throw new Error("Order written");
      if ((await prisma.stockMovement.count()) !== before.movement) throw new Error("StockMovement written");
      if ((await prisma.couponUsage.count()) !== before.couponUsage) throw new Error("CouponUsage written");
      if ((await prisma.bonusLedger.count()) !== before.bonusLedger) throw new Error("BonusLedger written");
      if ((await prisma.wishlistItem.count()) !== before.wishlistItem) throw new Error("WishlistItem written");
      if (cart3bEmailCalls.auth !== 0 || cart3bEmailCalls.orderConfirmation !== 0) {
        throw new Error("Email side effect");
      }
      const invAfter = await prisma.inventory.findFirst({ where: { variantId: vA } });
      if (invAfter?.quantityOnHand !== invBefore?.quantityOnHand) {
        throw new Error("Inventory mutated by merge");
      }
      void userCartId;
    });

    // ── M16 — unauthenticated → 401, guest cart untouched ────────────────
    await run("M16", async () => {
      await setOnHand(vA, 50);
      const { gk, cartId: guestCartId } = await mkGuestCart([{ variantId: vA, quantity: 2 }]);

      const res = await merge(undefined, gk);
      if (res.status !== 401) throw new Error(`expected 401 got ${res.status}`);
      if (!(await cartExists(guestCartId))) throw new Error("guest cart disposed without auth");
      const items = await dbItems(guestCartId);
      if (items.length !== 1 || items[0].quantity !== 2) throw new Error("guest cart mutated");
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
      for (const userId of createdUserIds) {
        const cart = await prisma.cart.findUnique({ where: { userId } });
        if (cart) createdCartIds.push(cart.id);
      }
      for (const cartId of new Set(createdCartIds)) {
        await prisma.cartItem.deleteMany({ where: { cartId } });
        await prisma.cart.delete({ where: { id: cartId } }).catch(() => undefined);
      }
      for (const userId of createdUserIds) {
        await prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      }
      for (const variantId of [vA, vB, vC, vNoInventory]) {
        if (!variantId) continue;
        await prisma.cartItem.deleteMany({ where: { variantId } }).catch(() => undefined);
        await prisma.inventory.deleteMany({ where: { variantId } }).catch(() => undefined);
        await prisma.productVariant.delete({ where: { id: variantId } }).catch(() => undefined);
      }
      if (productId) {
        await prisma.product.delete({ where: { id: productId } }).catch(() => undefined);
      }
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
    console.log(`\nSlice 3f Cart Merge: ${results.length}/${ids.length} PASS`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
