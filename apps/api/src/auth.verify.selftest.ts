/**
 * Unit 3 — Email Verification acceptance (Option A, test-only).
 * Scenarios per 10.1-auth-gdpr.md Verify Email + Resend Verification.
 *
 * Requires: DATABASE_URL + seed
 * Run (after build): pnpm --filter @dodo/api exec node dist/auth.verify.selftest.js
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { AuthVerifyTestAppModule } from "./auth.verify-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import {
  clearAuthEmailCaptures,
  emailVerifyCaptureCount,
  lastEmailVerifyRawToken,
} from "./auth.session-test-email.capture";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

type HttpResult = {
  status: number;
  body: unknown;
  setCookies: string[];
};

function getAccessToken(body: unknown): string {
  const t = (body as { accessToken?: string })?.accessToken;
  if (!t) throw new Error("missing accessToken");
  return t;
}

function call(
  server: Server,
  method: string,
  path: string,
  opts?: { bearer?: string; json?: unknown },
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
          resolve({
            status: res.statusCode ?? 0,
            body,
            setCookies: res.headers["set-cookie"] ?? [],
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assertStatus(label: string, got: number, expected: number | number[]): void {
  const ok = Array.isArray(expected) ? expected.includes(got) : got === expected;
  if (!ok) {
    throw new Error(`${label}: expected HTTP ${JSON.stringify(expected)}, got ${got}`);
  }
}

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

async function main() {
  const stamp = Date.now();
  const emailA = `unit3-a-${stamp}@verify.invalid`;
  const emailB = `unit3-b-${stamp}@verify.invalid`;
  const emailC = `unit3-c-${stamp}@verify.invalid`;
  const password = "Unit3VerifyPass!";
  const results: Result[] = [];

  console.log("Unit 3 — Email Verification (Option A, test-only)\n");

  let app;
  let prisma: PrismaService;
  try {
    app = await NestFactory.create(AuthVerifyTestAppModule, { logger: ["error"] });
    app.setGlobalPrefix("v1");
    app.use(cookieParser());
    app.enableCors({ origin: true, credentials: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of [
      "V1 register issues verify email",
      "V2 verify ok",
      "V3 reuse token",
      "V4 invalid token",
      "V5 expired token",
      "V6 resend unverified",
      "V7 resend already verified",
      "V8 resend unauthenticated",
      "V9 resend rate limit",
      "V10 newsletter DOI separate",
    ]) {
      results.push({ id, status: "BLOCKED", note: msg });
      console.error(`  ⊘ ${id}: BLOCKED`);
    }
    printSummary(results);
    process.exit(2);
  }

  const server = app.getHttpServer() as Server;
  const run = async (id: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ id, status: "PASS" });
      console.log(`  ✓ ${id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id, status: "FAIL", note: msg });
      console.error(`  ✗ ${id}: ${msg}`);
    }
  };

  let accessA = "";
  let verifyTokenA = "";
  let userIdA = "";

  clearAuthEmailCaptures();
  await run("V1 register issues verify email", async () => {
    const res = await call(server, "POST", "/v1/auth/register", {
      json: { email: emailA, password, locale: "de" },
    });
    assertStatus("V1 register", res.status, [200, 201]);
    accessA = getAccessToken(res.body);
    const raw = lastEmailVerifyRawToken();
    if (!raw) throw new Error("V1: no email_verify capture after register");
    verifyTokenA = raw;
    const user = await prisma.user.findUnique({ where: { email: emailA } });
    if (!user) throw new Error("V1: user missing");
    if (user.emailVerifiedAt) throw new Error("V1: expected unverified after register");
    userIdA = user.id;
    const tok = await prisma.verificationToken.findFirst({
      where: { userId: user.id, type: "email_verify", usedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!tok) throw new Error("V1: no active email_verify token in DB");
  });

  await run("V2 verify ok", async () => {
    const res = await call(server, "POST", "/v1/auth/verify-email", {
      json: { token: verifyTokenA },
    });
    assertStatus("V2", res.status, 200);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userIdA } });
    if (!user.emailVerifiedAt) throw new Error("V2: emailVerifiedAt not set");
    const tok = await prisma.verificationToken.findFirst({
      where: { userId: userIdA, type: "email_verify" },
      orderBy: { createdAt: "desc" },
    });
    if (!tok?.usedAt) throw new Error("V2: token not marked used");
  });

  await run("V3 reuse token", async () => {
    const res = await call(server, "POST", "/v1/auth/verify-email", {
      json: { token: verifyTokenA },
    });
    assertStatus("V3", res.status, 400);
  });

  await run("V4 invalid token", async () => {
    const res = await call(server, "POST", "/v1/auth/verify-email", {
      json: { token: "not-a-valid-email-verify-token" },
    });
    assertStatus("V4", res.status, 400);
  });

  await run("V5 expired token", async () => {
    clearAuthEmailCaptures();
    const reg = await call(server, "POST", "/v1/auth/register", {
      json: { email: emailB, password, locale: "de" },
    });
    assertStatus("V5 register", reg.status, [200, 201]);
    const raw = lastEmailVerifyRawToken();
    if (!raw) throw new Error("V5: missing rawToken");
    const user = await prisma.user.findUniqueOrThrow({ where: { email: emailB } });
    const row = await prisma.verificationToken.findFirst({
      where: { userId: user.id, type: "email_verify", usedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw new Error("V5: token row missing");
    await prisma.verificationToken.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const res = await call(server, "POST", "/v1/auth/verify-email", { json: { token: raw } });
    assertStatus("V5", res.status, 400);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (after.emailVerifiedAt) throw new Error("V5: should remain unverified");
  });

  await run("V6 resend unverified", async () => {
    clearAuthEmailCaptures();
    const reg = await call(server, "POST", "/v1/auth/register", {
      json: { email: emailC, password, locale: "de" },
    });
    assertStatus("V6 register", reg.status, [200, 201]);
    const access = getAccessToken(reg.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: emailC } });
    const prior = await prisma.verificationToken.findFirst({
      where: { userId: user.id, type: "email_verify", usedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!prior) throw new Error("V6: prior token missing");
    const beforeCount = emailVerifyCaptureCount();

    const res = await call(server, "POST", "/v1/me/resend-verification", { bearer: access });
    assertStatus("V6 resend", res.status, 200);

    const priorAfter = await prisma.verificationToken.findUniqueOrThrow({ where: { id: prior.id } });
    if (!priorAfter.usedAt) throw new Error("V6: prior unused token not invalidated");

    const neu = await prisma.verificationToken.findFirst({
      where: { userId: user.id, type: "email_verify", usedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!neu) throw new Error("V6: no new active email_verify token");
    if (neu.id === prior.id) throw new Error("V6: expected a new token id");

    if (emailVerifyCaptureCount() <= beforeCount) {
      throw new Error("V6: expected new email_verify send after resend");
    }
    if (!lastEmailVerifyRawToken()) throw new Error("V6: missing captured rawToken");
  });

  await run("V7 resend already verified", async () => {
    clearAuthEmailCaptures();
    const before = emailVerifyCaptureCount();
    const res = await call(server, "POST", "/v1/me/resend-verification", { bearer: accessA });
    assertStatus("V7", res.status, 200);
    const body = res.body as { ok?: boolean; message?: string };
    if (!body.ok) throw new Error("V7: expected ok");
    if (emailVerifyCaptureCount() !== before) {
      throw new Error("V7: must not send another verification email");
    }
  });

  await run("V8 resend unauthenticated", async () => {
    const res = await call(server, "POST", "/v1/me/resend-verification");
    assertStatus("V8", res.status, 401);
  });

  await run("V9 resend rate limit", async () => {
    // Fresh app: Throttler storage is in-memory and shared across routes for same IP.
    // Isolate so prior V1–V8 traffic does not pollute the 3/hour resend budget.
    const rlApp = await NestFactory.create(AuthVerifyTestAppModule, { logger: ["error"] });
    rlApp.setGlobalPrefix("v1");
    rlApp.use(cookieParser());
    rlApp.enableCors({ origin: true, credentials: true });
    rlApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    rlApp.useGlobalFilters(new AllExceptionsFilter());
    await rlApp.init();
    await rlApp.listen(0);
    const rlServer = rlApp.getHttpServer() as Server;

    try {
      // Contract: strict N/hour — production @Throttle limit 3 / 3_600_000ms
      const emailR = `unit3-rl-${stamp}@verify.invalid`;
      const reg = await call(rlServer, "POST", "/v1/auth/register", {
        json: { email: emailR, password, locale: "de" },
      });
      assertStatus("V9 register", reg.status, [200, 201]);
      const access = getAccessToken(reg.body);

      const r1 = await call(rlServer, "POST", "/v1/me/resend-verification", { bearer: access });
      assertStatus("V9 r1", r1.status, 200);
      const r2 = await call(rlServer, "POST", "/v1/me/resend-verification", { bearer: access });
      assertStatus("V9 r2", r2.status, 200);
      const r3 = await call(rlServer, "POST", "/v1/me/resend-verification", { bearer: access });
      assertStatus("V9 r3", r3.status, 200);
      const r4 = await call(rlServer, "POST", "/v1/me/resend-verification", { bearer: access });
      assertStatus("V9 r4 throttled", r4.status, 429);
    } finally {
      await rlApp.close();
    }
  });

  await run("V10 newsletter DOI separate", async () => {
    // email_verify tokens must not use newsletter/DOI template names
    const types = await prisma.verificationToken.findMany({
      where: { email: { in: [emailA, emailB, emailC] } },
      select: { type: true },
    });
    for (const t of types) {
      if (t.type !== "email_verify" && t.type !== "email_change" && t.type !== "password_reset") {
        throw new Error(`V10: unexpected token type ${t.type}`);
      }
      if (t.type.includes("newsletter") || t.type.includes("doi")) {
        throw new Error("V10: newsletter/DOI must stay separate from email_verify");
      }
    }
  });

  await app.close();
  printSummary(results);

  const failed = results.filter((r) => r.status === "FAIL");
  const blocked = results.filter((r) => r.status === "BLOCKED");
  if (failed.length > 0) process.exit(1);
  if (blocked.length > 0) process.exit(2);
}

main().catch((e) => {
  console.error("BLOCKED:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
