/**
 * G2 checkoutKey issuance — POST /v1/orders/checkout-key only.
 *
 * Requires: DATABASE_URL (+ seeded roles)
 * Run (after build): node dist/orders.checkout-key.selftest.js
 *
 * Scenarios:
 *   I1  — registered JWT → 200 exact { checkoutKey }
 *   I2  — guest x-guest-key → 200
 *   I3  — neither identity → 400
 *   I4  — invalid JWT → 401
 *   I5  — empty body {} → 200
 *   I6  — unexpected body fields → 400
 *   I7  — key format: unpadded base64url, 32 decoded bytes, no prefix
 *   I8  — repeated issuance → independent keys
 *   I9  — no Reservation / Order persist
 *   I10 — x-checkout-key ignored (still issues a new key)
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import type { CheckoutKeyIssueResponse } from "@dodo/shared-types";
import { OrdersCheckoutKeyTestAppModule } from "./orders.checkout-key-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { GUEST_KEY_HEADER } from "./cart/cart.types";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

const CHECKOUT_KEY_HEADER = "x-checkout-key";
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

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
          ...(opts?.checkoutKey ? { [CHECKOUT_KEY_HEADER]: opts.checkoutKey } : {}),
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
  return (body as { code?: string })?.code;
}

function assertIssued(body: unknown): CheckoutKeyIssueResponse {
  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["checkoutKey"])) {
    throw new Error(`response keys ${keys.join(",")}`);
  }
  if (typeof obj.checkoutKey !== "string" || !obj.checkoutKey) {
    throw new Error("checkoutKey missing");
  }
  return { checkoutKey: obj.checkoutKey };
}

function assertKeyFormat(key: string): void {
  if (key.includes("=")) throw new Error("padded base64url forbidden");
  if (key.includes("+") || key.includes("/")) throw new Error("standard base64 forbidden");
  if (!BASE64URL_RE.test(key)) throw new Error("not unpadded base64url");
  if (key.startsWith("gk_") || key.includes(".")) throw new Error("prefix/JWT-like forbidden");
  const raw = Buffer.from(key, "base64url");
  if (raw.length !== 32) throw new Error(`decoded length ${raw.length}, expected 32`);
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = [
    "I1",
    "I2",
    "I3",
    "I4",
    "I5",
    "I6",
    "I7",
    "I8",
    "I9",
    "I10",
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

  const app = await NestFactory.create(OrdersCheckoutKeyTestAppModule, { logger: false });
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
  const guestKey = () => `gk_ck_${stamp}_${randomBytes(4).toString("hex")}`;
  const userEmail = () => `ck_${stamp}_${randomBytes(4).toString("hex")}@test.local`;

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

  const issue = (opts?: {
    bearer?: string;
    guestKey?: string;
    checkoutKey?: string;
    json?: unknown;
    sendJson?: boolean;
  }) => call(server, "POST", "/v1/orders/checkout-key", opts);

  try {
    await run("I1", async () => {
      const { bearer } = await registerUser();
      const res = await issue({ bearer });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      assertKeyFormat(assertIssued(res.body).checkoutKey);
    });

    await run("I2", async () => {
      const res = await issue({ guestKey: guestKey() });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      assertKeyFormat(assertIssued(res.body).checkoutKey);
    });

    await run("I3", async () => {
      const res = await issue();
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
      if (errCode(res.body) !== "VALIDATION_ERROR") {
        throw new Error(`code=${errCode(res.body)}`);
      }
    });

    await run("I4", async () => {
      const res = await issue({ bearer: "not-a-jwt" });
      if (res.status !== 401) throw new Error(`expected 401 got ${res.status}`);
      if (errCode(res.body) !== "UNAUTHORIZED") throw new Error(`code=${errCode(res.body)}`);
    });

    await run("I5", async () => {
      const res = await issue({ guestKey: guestKey(), json: {} });
      if (res.status !== 200) throw new Error(`empty body {} status ${res.status}`);
      assertIssued(res.body);
    });

    await run("I6", async () => {
      const extra = await issue({
        guestKey: guestKey(),
        json: { checkoutKey: "invented", guestKey: "nope" },
      });
      if (extra.status !== 400) throw new Error(`expected 400 got ${extra.status}`);
      // Existing ValidationPipe / forbidNonWhitelisted shape (code is often "Bad Request").
    });

    await run("I7", async () => {
      const res = await issue({ guestKey: guestKey() });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const { checkoutKey } = assertIssued(res.body);
      assertKeyFormat(checkoutKey);
      if (checkoutKey.length !== 43) throw new Error(`encoded length ${checkoutKey.length}`);
    });

    await run("I8", async () => {
      const gk = guestKey();
      const a = await issue({ guestKey: gk });
      const b = await issue({ guestKey: gk });
      if (a.status !== 200 || b.status !== 200) throw new Error("repeat must succeed");
      const ka = assertIssued(a.body).checkoutKey;
      const kb = assertIssued(b.body).checkoutKey;
      if (ka === kb) throw new Error("repeat issued the same key");
    });

    await run("I9", async () => {
      const before = {
        reservation: await prisma.reservation.count(),
        order: await prisma.order.count(),
        cart: await prisma.cart.count(),
      };
      const res = await issue({ guestKey: guestKey() });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      if ((await prisma.reservation.count()) !== before.reservation) {
        throw new Error("Reservation mutated");
      }
      if ((await prisma.order.count()) !== before.order) throw new Error("Order mutated");
      if ((await prisma.cart.count()) !== before.cart) throw new Error("Cart mutated");
    });

    await run("I10", async () => {
      const res = await issue({
        guestKey: guestKey(),
        checkoutKey: "should-be-ignored",
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const { checkoutKey } = assertIssued(res.body);
      if (checkoutKey === "should-be-ignored") {
        throw new Error("x-checkout-key must not be consumed as issuance");
      }
      assertKeyFormat(checkoutKey);
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
        await prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      }
    } catch {
      /* best-effort */
    }
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    process.exitCode = 1;
  } else {
    console.log(`\nG2 checkoutKey issuance: ${results.length}/${ids.length} PASS`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
