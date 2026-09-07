/**
 * Gap C — GDPR Anonymize · VerificationToken invalidation (Option A, test-only).
 * Paper Decision 2026-09-03: usedAt on all active VerificationTokens in anonymize transaction.
 *
 * Requires: DATABASE_URL + seed
 * Run (after build): pnpm --filter @dodo/api exec node dist/auth.gdpr-anonymize-tokens.selftest.js
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { AuthVerifyTestAppModule } from "./auth.verify-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { hashToken } from "./auth/crypto.util";
import {
  clearAuthEmailCaptures,
  passwordResetCaptureCount,
  emailVerifyCaptureCount,
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
  opts?: { bearer?: string; json?: unknown; cookie?: string },
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

async function issueRawToken(
  prisma: PrismaService,
  params: { userId: string; email: string; type: string },
): Promise<{ id: string; raw: string }> {
  const raw = randomBytes(32).toString("base64url");
  const row = await prisma.verificationToken.create({
    data: {
      userId: params.userId,
      email: params.email,
      type: params.type,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { id: row.id, raw };
}

async function main() {
  const stamp = Date.now();
  const emailA = `gap-c-a-${stamp}@gdpr.invalid`;
  const emailB = `gap-c-b-${stamp}@gdpr.invalid`;
  const password = "GapCAnonymizePass!";
  const results: Result[] = [];
  const scenarioIds = [
    "G-VT1 multi-type active tokens pre-anonymize",
    "G-VT2 all own tokens usedAt after anonymize",
    "G-VT3 other-user tokens untouched",
    "G-VT4 prior raw token cannot consume / mutate user",
    "G-VT5 no new token via protected/forgot flows",
    "G-VT6 sessions revoked + anonymize core intact",
  ];

  console.log("Gap C — GDPR Anonymize · VerificationToken invalidation (Option A)\n");

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
    for (const id of scenarioIds) {
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
  let userIdA = "";
  let userIdB = "";
  let ownTokenIds: string[] = [];
  let otherTokenId = "";
  let rawVerify = "";
  let rawReset = "";
  let rawChange = "";
  let anonymizeAt: Date | null = null;
  let sessionIdsBefore: string[] = [];

  try {
    const regA = await call(server, "POST", "/v1/auth/register", {
      json: { email: emailA, password, locale: "de" },
    });
    assertStatus("register A", regA.status, [200, 201]);
    accessA = getAccessToken(regA.body);
    const userA = await prisma.user.findUniqueOrThrow({ where: { email: emailA } });
    userIdA = userA.id;

    const regB = await call(server, "POST", "/v1/auth/register", {
      json: { email: emailB, password, locale: "de" },
    });
    assertStatus("register B", regB.status, [200, 201]);
    userIdB = (await prisma.user.findUniqueOrThrow({ where: { email: emailB } })).id;

    // Invalidate any register-issued verify tokens so we control fixtures
    await prisma.verificationToken.updateMany({
      where: { userId: userIdA, usedAt: null },
      data: { usedAt: new Date() },
    });

    const tVerify = await issueRawToken(prisma, {
      userId: userIdA,
      email: emailA,
      type: "email_verify",
    });
    const tReset = await issueRawToken(prisma, {
      userId: userIdA,
      email: emailA,
      type: "password_reset",
    });
    const tChange = await issueRawToken(prisma, {
      userId: userIdA,
      email: `new-${emailA}`,
      type: "email_change",
    });
    ownTokenIds = [tVerify.id, tReset.id, tChange.id];
    rawVerify = tVerify.raw;
    rawReset = tReset.raw;
    rawChange = tChange.raw;

    const other = await issueRawToken(prisma, {
      userId: userIdB,
      email: emailB,
      type: "email_verify",
    });
    otherTokenId = other.id;

    sessionIdsBefore = (
      await prisma.session.findMany({
        where: { userId: userIdA, revokedAt: null },
        select: { id: true },
      })
    ).map((s) => s.id);
    if (sessionIdsBefore.length < 1) throw new Error("setup: expected active session for A");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of scenarioIds) {
      results.push({ id, status: "BLOCKED", note: msg });
      console.error(`  ⊘ ${id}: BLOCKED`);
    }
    printSummary(results);
    await app.close().catch(() => undefined);
    process.exit(2);
  }

  await run("G-VT1 multi-type active tokens pre-anonymize", async () => {
    const active = await prisma.verificationToken.findMany({
      where: { userId: userIdA, usedAt: null },
    });
    const types = new Set(active.map((t) => t.type));
    for (const need of ["email_verify", "password_reset", "email_change"]) {
      if (!types.has(need)) throw new Error(`missing active type ${need}`);
    }
    if (active.length < 3) throw new Error(`expected ≥3 active own tokens, got ${active.length}`);
  });

  // Anonymize once for remaining scenarios
  try {
    const res = await call(server, "POST", "/v1/me/gdpr/anonymize", {
      bearer: accessA,
      json: { password },
    });
    assertStatus("anonymize", res.status, [200, 201]);
    const body = res.body as { status?: string; anonymizedAt?: string };
    if (body.status !== "done") throw new Error(`anonymize status=${String(body.status)}`);
    if (!body.anonymizedAt) throw new Error("missing anonymizedAt");
    anonymizeAt = new Date(body.anonymizedAt);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of scenarioIds.slice(1)) {
      results.push({ id, status: "BLOCKED", note: `anonymize failed: ${msg}` });
      console.error(`  ⊘ ${id}: BLOCKED`);
    }
    printSummary(results);
    await app.close().catch(() => undefined);
    process.exit(2);
  }

  await run("G-VT2 all own tokens usedAt after anonymize", async () => {
    const rows = await prisma.verificationToken.findMany({
      where: { id: { in: ownTokenIds } },
    });
    if (rows.length !== 3) throw new Error(`expected 3 own token rows, got ${rows.length}`);
    for (const row of rows) {
      if (!row.usedAt) throw new Error(`token ${row.id} (${row.type}) still usedAt=null`);
      if (!anonymizeAt) throw new Error("anonymizeAt unset");
      const delta = Math.abs(row.usedAt.getTime() - anonymizeAt.getTime());
      if (delta > 5_000) {
        throw new Error(`usedAt not aligned with anonymize timestamp for ${row.type}`);
      }
    }
    const stillActive = await prisma.verificationToken.count({
      where: { userId: userIdA, usedAt: null },
    });
    if (stillActive !== 0) throw new Error(`still ${stillActive} active tokens for user A`);
  });

  await run("G-VT3 other-user tokens untouched", async () => {
    const other = await prisma.verificationToken.findUniqueOrThrow({ where: { id: otherTokenId } });
    if (other.usedAt !== null) throw new Error("other-user token was invalidated");
    if (other.userId !== userIdB) throw new Error("other-user token userId changed");
  });

  await run("G-VT4 prior raw token cannot consume / mutate user", async () => {
    const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: userIdA } });
    if (!userBefore.anonymizedAt) throw new Error("expected anonymized user");
    const emailBefore = userBefore.email;
    const verifiedBefore = userBefore.emailVerifiedAt;

    const verifyRes = await call(server, "POST", "/v1/auth/verify-email", {
      json: { token: rawVerify },
    });
    assertStatus("verify after anonymize", verifyRes.status, 400);

    const resetRes = await call(server, "POST", "/v1/auth/reset-password", {
      json: { token: rawReset, newPassword: "ShouldNotApplyPass1!" },
    });
    assertStatus("reset after anonymize", resetRes.status, 400);

    const changeRes = await call(server, "POST", "/v1/auth/verify-email", {
      json: { token: rawChange },
    });
    assertStatus("email_change consume after anonymize", changeRes.status, 400);

    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: userIdA } });
    if (userAfter.email !== emailBefore) throw new Error("email mutated via stale token");
    if (String(userAfter.emailVerifiedAt) !== String(verifiedBefore)) {
      throw new Error("emailVerifiedAt mutated via stale token");
    }
  });

  await run("G-VT5 no new token via protected/forgot flows", async () => {
    clearAuthEmailCaptures();
    const countBefore = await prisma.verificationToken.count({ where: { userId: userIdA } });

    const resend = await call(server, "POST", "/v1/me/resend-verification", {
      bearer: accessA,
    });
    assertStatus("resend after anonymize", resend.status, 401);

    const forgotOld = await call(server, "POST", "/v1/auth/forgot-password", {
      json: { email: emailA },
    });
    assertStatus("forgot old email", forgotOld.status, 200);

    const anonymizedEmail = `deleted-${userIdA}@anonymized.invalid`;
    const forgotAnon = await call(server, "POST", "/v1/auth/forgot-password", {
      json: { email: anonymizedEmail },
    });
    assertStatus("forgot anonymized email", forgotAnon.status, 200);

    const countAfter = await prisma.verificationToken.count({ where: { userId: userIdA } });
    if (countAfter !== countBefore) {
      throw new Error(`new VerificationToken rows created (${countBefore} → ${countAfter})`);
    }
    if (passwordResetCaptureCount() !== 0) {
      throw new Error("password_reset email was sent after anonymize");
    }
    if (emailVerifyCaptureCount() !== 0) {
      throw new Error("email_verify email was sent after anonymize");
    }
  });

  await run("G-VT6 sessions revoked + anonymize core intact", async () => {
    const sessions = await prisma.session.findMany({
      where: { id: { in: sessionIdsBefore } },
    });
    for (const s of sessions) {
      if (!s.revokedAt) throw new Error(`session ${s.id} not revoked`);
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userIdA } });
    if (!user.anonymizedAt || !user.deletedAt) throw new Error("anonymize markers missing");
    if (!user.email.startsWith("deleted-") || !user.email.endsWith("@anonymized.invalid")) {
      throw new Error(`unexpected anonymized email: ${user.email}`);
    }
    if (user.name !== null || user.companyName !== null || user.vatId !== null) {
      throw new Error("PII fields not cleared");
    }

    const me = await call(server, "GET", "/v1/auth/me", { bearer: accessA });
    assertStatus("me after anonymize", me.status, 401);

    const login = await call(server, "POST", "/v1/auth/login", {
      json: { email: emailA, password },
    });
    assertStatus("login old credentials", login.status, 401);
  });

  printSummary(results);
  await app.close().catch(() => undefined);

  const failed = results.some((r) => r.status !== "PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
