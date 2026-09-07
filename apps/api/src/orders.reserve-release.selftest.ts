/**
 * Production HTTP reserve/release consume — POST /v1/orders/reserve|release.
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory + roles)
 * Run (after build): node dist/orders.reserve-release.selftest.js
 *
 * Scenarios:
 *   RR1  — guest + key → reserve 200 exact shape
 *   RR2  — JWT + key → reserve 200
 *   RR3  — neither identity → 400
 *   RR4  — invalid JWT → 401
 *   RR5  — missing x-checkout-key → 400
 *   RR6  — blank x-checkout-key → 400
 *   RR7  — malformed x-checkout-key → 400
 *   RR8  — repeated reserve same key/variant → 200 same shape, one row
 *   RR9  — insufficient stock → 409
 *   RR10 — release → 200 { releasedCount }
 *   RR11 — release zero active → 200 releasedCount 0
 *   RR12 — release extra body → 400
 *   RR13 — reserve body checkoutKey forbidden → 400
 *   RR14 — no Order/Payment/CouponUsage/BonusLedger/email side effects
 *   RR15 — response never includes checkoutKey
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import type { ReleaseResponse, ReserveResponse } from "@dodo/shared-types";
import { OrdersReserveReleaseTestAppModule } from "./orders.reserve-release-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { GUEST_KEY_HEADER } from "./cart/cart.types";
import { CHECKOUT_KEY_HEADER } from "./orders/checkout-key.transport";

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
  opts?: {
    bearer?: string;
    guestKey?: string;
    checkoutKey?: string;
    json?: unknown;
    sendJson?: boolean;
  },
): Promise<HttpResult> {
  const addr = server.address() as AddressInfo;
  const sendJson = opts?.sendJson === true || opts?.json !== undefined;
  const payload = sendJson ? JSON.stringify(opts?.json ?? {}) : undefined;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          ...(payload !== undefined
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          ...(opts?.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
          ...(opts?.guestKey ? { [GUEST_KEY_HEADER]: opts.guestKey } : {}),
          ...(opts?.checkoutKey !== undefined
            ? { [CHECKOUT_KEY_HEADER]: opts.checkoutKey }
            : {}),
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
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function errCode(body: unknown): string | undefined {
  return (body as { code?: string; error?: string })?.code
    ?? (body as { error?: string })?.error;
}

function mintCheckoutKey(): string {
  return randomBytes(32).toString("base64url");
}

function assertReserve(body: unknown): ReserveResponse {
  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify(["availableAfter", "expiresAt", "quantity", "reservationId"])
  ) {
    throw new Error(`reserve keys ${keys.join(",")}`);
  }
  if (typeof obj.reservationId !== "string" || !obj.reservationId) {
    throw new Error("reservationId");
  }
  if (typeof obj.quantity !== "number") throw new Error("quantity");
  if (typeof obj.expiresAt !== "string" || Number.isNaN(Date.parse(obj.expiresAt))) {
    throw new Error("expiresAt");
  }
  if (typeof obj.availableAfter !== "number") throw new Error("availableAfter");
  if ("checkoutKey" in obj) throw new Error("checkoutKey leaked");
  return obj as unknown as ReserveResponse;
}

function assertRelease(body: unknown): ReleaseResponse {
  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["releasedCount"])) {
    throw new Error(`release keys ${keys.join(",")}`);
  }
  if (typeof obj.releasedCount !== "number") throw new Error("releasedCount");
  if ("checkoutKey" in obj) throw new Error("checkoutKey leaked");
  return { releasedCount: obj.releasedCount };
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = [
    "RR1",
    "RR2",
    "RR3",
    "RR4",
    "RR5",
    "RR6",
    "RR7",
    "RR8",
    "RR9",
    "RR10",
    "RR11",
    "RR12",
    "RR13",
    "RR14",
    "RR15",
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

  const app = await NestFactory.create(OrdersReserveReleaseTestAppModule, { logger: false });
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
  const createdReservationIds: string[] = [];
  const guestKey = () => `gk_rr_${stamp}_${randomBytes(4).toString("hex")}`;
  const userEmail = () => `rr_${stamp}_${randomBytes(4).toString("hex")}@test.local`;

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

  // Ensure enough headroom for tests
  await prisma.inventory.update({
    where: { locationId_variantId: { locationId: location.id, variantId } },
    data: { quantityOnHand: Math.max(onHand, 50) },
  });

  const registerUser = async (): Promise<{ bearer: string; userId: string }> => {
    const email = userEmail();
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

  const reserve = (opts: {
    bearer?: string;
    guestKey?: string;
    checkoutKey?: string;
    json?: unknown;
    sendJson?: boolean;
  }) => call(server, "POST", "/v1/orders/reserve", opts);

  const release = (opts: {
    bearer?: string;
    guestKey?: string;
    checkoutKey?: string;
    json?: unknown;
    sendJson?: boolean;
  }) => call(server, "POST", "/v1/orders/release", opts);

  try {
    await run("RR1", async () => {
      const key = mintCheckoutKey();
      const res = await reserve({
        guestKey: guestKey(),
        checkoutKey: key,
        json: { variantId, quantity: 2 },
      });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = assertReserve(res.body);
      if (body.quantity !== 2) throw new Error(`quantity ${body.quantity}`);
      createdReservationIds.push(body.reservationId);
    });

    await run("RR2", async () => {
      const { bearer } = await registerUser();
      const key = mintCheckoutKey();
      const res = await reserve({
        bearer,
        checkoutKey: key,
        json: { variantId, quantity: 1 },
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      createdReservationIds.push(assertReserve(res.body).reservationId);
    });

    await run("RR3", async () => {
      const res = await reserve({
        checkoutKey: mintCheckoutKey(),
        json: { variantId, quantity: 1 },
      });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
      if (errCode(res.body) !== "VALIDATION_ERROR") {
        throw new Error(`code=${errCode(res.body)}`);
      }
    });

    await run("RR4", async () => {
      const res = await reserve({
        bearer: "not-a-jwt",
        checkoutKey: mintCheckoutKey(),
        json: { variantId, quantity: 1 },
      });
      if (res.status !== 401) throw new Error(`expected 401 got ${res.status}`);
    });

    await run("RR5", async () => {
      const res = await reserve({
        guestKey: guestKey(),
        json: { variantId, quantity: 1 },
      });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
    });

    await run("RR6", async () => {
      const res = await reserve({
        guestKey: guestKey(),
        checkoutKey: "   ",
        json: { variantId, quantity: 1 },
      });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
    });

    await run("RR7", async () => {
      const res = await reserve({
        guestKey: guestKey(),
        checkoutKey: "not-valid!!",
        json: { variantId, quantity: 1 },
      });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
    });

    await run("RR8", async () => {
      const key = mintCheckoutKey();
      const gk = guestKey();
      const a = await reserve({
        guestKey: gk,
        checkoutKey: key,
        json: { variantId, quantity: 1 },
      });
      const b = await reserve({
        guestKey: gk,
        checkoutKey: key,
        json: { variantId, quantity: 3 },
      });
      if (a.status !== 200 || b.status !== 200) {
        throw new Error(`repeat status a=${a.status} b=${b.status}`);
      }
      const ra = assertReserve(a.body);
      const rb = assertReserve(b.body);
      if (ra.reservationId !== rb.reservationId) throw new Error("expected same reservation row");
      if (rb.quantity !== 3) throw new Error(`quantity ${rb.quantity}`);
      createdReservationIds.push(rb.reservationId);
      const rows = await prisma.reservation.count({
        where: { checkoutKey: key, variantId, locationId: location.id },
      });
      if (rows !== 1) throw new Error(`row count ${rows}`);
    });

    await run("RR9", async () => {
      const key = mintCheckoutKey();
      const avail = await prisma.inventory.findUnique({
        where: { locationId_variantId: { locationId: location.id, variantId } },
      });
      const onHandNow = avail?.quantityOnHand ?? 0;
      const res = await reserve({
        guestKey: guestKey(),
        checkoutKey: key,
        json: { variantId, quantity: onHandNow + 100 },
      });
      if (res.status !== 409) throw new Error(`expected 409 got ${res.status}`);
      if (errCode(res.body) !== "INSUFFICIENT_STOCK") {
        throw new Error(`code=${errCode(res.body)}`);
      }
    });

    await run("RR10", async () => {
      const key = mintCheckoutKey();
      const gk = guestKey();
      const r = await reserve({
        guestKey: gk,
        checkoutKey: key,
        json: { variantId, quantity: 1 },
      });
      if (r.status !== 200) throw new Error(`reserve ${r.status}`);
      createdReservationIds.push(assertReserve(r.body).reservationId);
      const rel = await release({ guestKey: gk, checkoutKey: key, json: {} });
      if (rel.status !== 200) throw new Error(`release ${rel.status}`);
      const body = assertRelease(rel.body);
      if (body.releasedCount < 1) throw new Error(`releasedCount ${body.releasedCount}`);
    });

    await run("RR11", async () => {
      const rel = await release({
        guestKey: guestKey(),
        checkoutKey: mintCheckoutKey(),
        json: {},
      });
      if (rel.status !== 200) throw new Error(`status ${rel.status}`);
      const body = assertRelease(rel.body);
      if (body.releasedCount !== 0) throw new Error(`expected 0 got ${body.releasedCount}`);
    });

    await run("RR12", async () => {
      const rel = await release({
        guestKey: guestKey(),
        checkoutKey: mintCheckoutKey(),
        json: { checkoutKey: "nope" },
      });
      if (rel.status !== 400) throw new Error(`expected 400 got ${rel.status}`);
    });

    await run("RR13", async () => {
      const res = await reserve({
        guestKey: guestKey(),
        checkoutKey: mintCheckoutKey(),
        json: { variantId, quantity: 1, checkoutKey: "body-forbidden" },
      });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
    });

    await run("RR14", async () => {
      const before = {
        order: await prisma.order.count(),
        payment: await prisma.payment.count(),
        couponUsage: await prisma.couponUsage.count(),
        bonusLedger: await prisma.bonusLedger.count(),
      };
      const key = mintCheckoutKey();
      const gk = guestKey();
      const r = await reserve({
        guestKey: gk,
        checkoutKey: key,
        json: { variantId, quantity: 1 },
      });
      if (r.status !== 200) throw new Error(`reserve ${r.status}`);
      createdReservationIds.push(assertReserve(r.body).reservationId);
      await release({ guestKey: gk, checkoutKey: key, json: {} });
      if ((await prisma.order.count()) !== before.order) throw new Error("Order mutated");
      if ((await prisma.payment.count()) !== before.payment) throw new Error("Payment mutated");
      if ((await prisma.couponUsage.count()) !== before.couponUsage) {
        throw new Error("CouponUsage mutated");
      }
      if ((await prisma.bonusLedger.count()) !== before.bonusLedger) {
        throw new Error("BonusLedger mutated");
      }
    });

    await run("RR15", async () => {
      const key = mintCheckoutKey();
      const gk = guestKey();
      const r = await reserve({
        guestKey: gk,
        checkoutKey: key,
        json: { variantId, quantity: 1 },
      });
      assertReserve(r.body);
      createdReservationIds.push((r.body as ReserveResponse).reservationId);
      const rel = await release({ guestKey: gk, checkoutKey: key, json: {} });
      assertRelease(rel.body);
      const text = JSON.stringify(r.body) + JSON.stringify(rel.body);
      if (text.includes(key)) throw new Error("raw checkoutKey appeared in response");
    });
  } finally {
    try {
      if (createdReservationIds.length) {
        await prisma.reservation.deleteMany({
          where: { id: { in: createdReservationIds } },
        });
      }

      for (const userId of createdUserIds) {
        await prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
        await prisma.userRole.deleteMany({ where: { userId } }).catch(() => undefined);
        await prisma.bonusAccount.deleteMany({ where: { userId } }).catch(() => undefined);
        await prisma.cart.deleteMany({ where: { userId } }).catch(() => undefined);
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
  if (failed > 0 || results.length !== ids.length) {
    process.exitCode = 1;
  } else {
    console.log(`\nreserve/release HTTP: ${results.length}/${ids.length} PASS`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
