/**
 * Unit 2 — Forgot/Reset Password acceptance (Option A, test-only).
 * Scenarios T1–T12 per 10.1-auth-gdpr.md
 *
 * Requires: DATABASE_URL + seed
 * Run (after build): pnpm --filter @dodo/api exec node dist/auth.forgot-reset.selftest.js
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { AuthSessionTestAppModule } from "./auth.session-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { REFRESH_COOKIE } from "./auth/auth.types";
import { PrismaService } from "./prisma/prisma.service";
import {
  clearAuthEmailCaptures,
  lastPasswordResetRawToken,
  passwordResetCaptureCount,
} from "./auth.session-test-email.capture";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

type HttpResult = {
  status: number;
  body: unknown;
  setCookies: string[];
};

const FORGOT_OK = {
  ok: true,
  message: "If an account exists for this email, instructions have been sent.",
};

function extractCookie(setCookies: string[], name: string): string | undefined {
  for (const raw of setCookies) {
    const part = raw.split(";")[0]?.trim();
    if (part?.startsWith(`${name}=`)) return part;
  }
  return undefined;
}

function call(
  server: Server,
  method: string,
  path: string,
  opts?: { bearer?: string; cookie?: string; json?: unknown },
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
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(opts?.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
          ...(opts?.cookie ? { Cookie: opts.cookie } : {}),
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
          const setCookies = res.headers["set-cookie"] ?? [];
          resolve({ status: res.statusCode ?? 0, body, setCookies });
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

function bodyEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

async function main() {
  const email = `unit2-${Date.now()}@forgot-reset.invalid`;
  const password = "Unit2OldPass!";
  const newPassword = "Unit2NewPass!";
  const results: Result[] = [];

  console.log("Unit 2 — Forgot/Reset Password (Option A, test-only)\n");

  let app;
  let prisma: PrismaService;
  try {
    app = await NestFactory.create(AuthSessionTestAppModule, { logger: ["error"] });
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
      "T1 forgot known",
      "T2 forgot unknown",
      "T3 token issued",
      "T4 invalidate prior",
      "T5 reset ok",
      "T6 login new",
      "T7 login old",
      "T8 invalid token",
      "T9 expired token",
      "T10 reuse token",
      "T11 refresh revoked",
      "T12 short password",
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

  // Setup: registered user + session before any reset (T11)
  clearAuthEmailCaptures();
  const reg = await call(server, "POST", "/v1/auth/register", {
    json: { email, password, locale: "de" },
  });
  assertStatus("setup register", reg.status, [200, 201]);

  const loginBeforeReset = await call(server, "POST", "/v1/auth/login", {
    json: { email, password },
  });
  assertStatus("setup login", loginBeforeReset.status, 200);
  const refreshCookieBeforeReset = extractCookie(loginBeforeReset.setCookies, REFRESH_COOKIE);
  if (!refreshCookieBeforeReset) throw new Error("setup: missing refresh cookie");

  let t1Body: unknown;
  let firstResetTokenId: string | undefined;
  let resetTokenForT5: string | undefined;

  await run("T1 forgot known", async () => {
    const res = await call(server, "POST", "/v1/auth/forgot-password", { json: { email } });
    assertStatus("T1", res.status, 200);
    if (!bodyEquals(res.body, FORGOT_OK)) {
      throw new Error(`T1: unexpected body ${JSON.stringify(res.body)}`);
    }
    t1Body = res.body;
  });

  await run("T2 forgot unknown", async () => {
    const res = await call(server, "POST", "/v1/auth/forgot-password", {
      json: { email: `no-such-${Date.now()}@forgot-reset.invalid` },
    });
    assertStatus("T2", res.status, 200);
    if (!bodyEquals(res.body, t1Body)) {
      throw new Error("T2: response differs from T1 (enumeration leak)");
    }
  });

  await run("T3 token issued", async () => {
    const raw = lastPasswordResetRawToken();
    if (!raw) throw new Error("T3: email stub did not capture password_reset rawToken");

    const row = await prisma.verificationToken.findFirst({
      where: { email, type: "password_reset", usedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw new Error("T3: no active password_reset token in DB");
    firstResetTokenId = row.id;
  });

  await run("T4 invalidate prior", async () => {
    if (!firstResetTokenId) throw new Error("T4: missing firstResetTokenId from T3");
    const beforeCount = passwordResetCaptureCount();

    const res = await call(server, "POST", "/v1/auth/forgot-password", { json: { email } });
    assertStatus("T4 forgot", res.status, 200);

    const first = await prisma.verificationToken.findUnique({ where: { id: firstResetTokenId } });
    if (!first?.usedAt) throw new Error("T4: prior reset token not invalidated");

    const raw = lastPasswordResetRawToken();
    if (!raw) throw new Error("T4: no new rawToken captured");
    if (passwordResetCaptureCount() <= beforeCount) {
      throw new Error("T4: expected new password_reset email capture");
    }
    resetTokenForT5 = raw;
  });

  await run("T5 reset ok", async () => {
    if (!resetTokenForT5) throw new Error("T5: missing reset token");
    const res = await call(server, "POST", "/v1/auth/reset-password", {
      json: { token: resetTokenForT5, newPassword },
    });
    assertStatus("T5", res.status, 200);
    const body = res.body as { ok?: boolean };
    if (body.ok !== true) throw new Error(`T5: unexpected body ${JSON.stringify(res.body)}`);
  });

  await run("T6 login new", async () => {
    const res = await call(server, "POST", "/v1/auth/login", { json: { email, password: newPassword } });
    assertStatus("T6", res.status, 200);
  });

  await run("T7 login old", async () => {
    const res = await call(server, "POST", "/v1/auth/login", { json: { email, password } });
    assertStatus("T7", res.status, 401);
  });

  await run("T8 invalid token", async () => {
    const res = await call(server, "POST", "/v1/auth/reset-password", {
      json: { token: "not-a-valid-reset-token", newPassword: "AnotherPass1!" },
    });
    assertStatus("T8", res.status, 400);
  });

  await run("T9 expired token", async () => {
    clearAuthEmailCaptures();
    const forgot = await call(server, "POST", "/v1/auth/forgot-password", { json: { email } });
    assertStatus("T9 forgot", forgot.status, 200);
    const raw = lastPasswordResetRawToken();
    if (!raw) throw new Error("T9: missing rawToken");

    const row = await prisma.verificationToken.findFirst({
      where: { email, type: "password_reset", usedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw new Error("T9: token row missing");

    await prisma.verificationToken.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await call(server, "POST", "/v1/auth/reset-password", {
      json: { token: raw, newPassword: "ExpiredTest1!" },
    });
    assertStatus("T9 reset", res.status, 400);
  });

  await run("T10 reuse token", async () => {
    if (!resetTokenForT5) throw new Error("T10: missing token from T5");
    const res = await call(server, "POST", "/v1/auth/reset-password", {
      json: { token: resetTokenForT5, newPassword: "ReuseTest1!" },
    });
    assertStatus("T10", res.status, 400);
  });

  await run("T11 refresh revoked", async () => {
    const res = await call(server, "POST", "/v1/auth/refresh", { cookie: refreshCookieBeforeReset });
    assertStatus("T11", res.status, 401);
  });

  await run("T12 short password", async () => {
    const forgot = await call(server, "POST", "/v1/auth/forgot-password", { json: { email } });
    assertStatus("T12 forgot", forgot.status, 200);
    const raw = lastPasswordResetRawToken();
    if (!raw) throw new Error("T12: missing rawToken");

    const res = await call(server, "POST", "/v1/auth/reset-password", {
      json: { token: raw, newPassword: "short" },
    });
    assertStatus("T12", res.status, 400);
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
