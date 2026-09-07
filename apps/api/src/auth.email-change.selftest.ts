/**
 * Unit 9 — Email Change acceptance (Option A, test-only).
 * Scenarios E1–E9 per 10.1-auth-gdpr.md email_change flow.
 *
 * Requires: DATABASE_URL + seed
 * Run (after build): node dist/auth.email-change.selftest.js
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
  lastEmailChangeCapture,
  lastEmailChangeRawToken,
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
  const emailOld = `unit9-old-${stamp}@auth.invalid`;
  const emailReserved = `unit9-taken-${stamp}@auth.invalid`;
  const emailTargetA = `unit9-new-a-${stamp}@auth.invalid`;
  const emailTargetB = `unit9-new-b-${stamp}@auth.invalid`;
  const password = "Unit9EmailChange!";
  const results: Result[] = [];
  const scenarioIds = [
    "E1 unauthenticated",
    "E2 valid request",
    "E3 same email",
    "E4 reserved email",
    "E5 previous token invalidation",
    "E6 successful verification",
    "E7 token reuse",
    "E8 sessions remain",
    "E9 email destination",
  ];

  console.log("Unit 9 — Email Change (Option A, test-only)\n");

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

  let access = "";
  let userId = "";
  let sessionIds: string[] = [];
  let tokenA = "";
  let tokenB = "";
  let captureToA = "";
  let captureToB = "";
  let auditsBefore = 0;

  try {
    clearAuthEmailCaptures();

    const reserved = await call(server, "POST", "/v1/auth/register", {
      json: { email: emailReserved, password, locale: "de" },
    });
    assertStatus("register reserved", reserved.status, [200, 201]);

    const reg = await call(server, "POST", "/v1/auth/register", {
      json: { email: emailOld, password, locale: "de" },
    });
    assertStatus("register main", reg.status, [200, 201]);
    access = getAccessToken(reg.body);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: emailOld } });
    userId = user.id;

    // Second session — proves email_change does not revoke sessions (E8)
    const login2 = await call(server, "POST", "/v1/auth/login", {
      json: { email: emailOld, password },
    });
    assertStatus("login2", login2.status, 200);
    const access2 = getAccessToken(login2.body);

    const sessions = await prisma.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: "asc" },
    });
    if (sessions.length < 2) throw new Error("setup: need ≥2 active sessions");
    sessionIds = sessions.map((s) => s.id);

    // Keep access from session 1 (register); access2 retained only to prove E8 later via DB + me
    void access2;

    auditsBefore = await prisma.auditLog.count({
      where: { action: "email.change", entityId: userId },
    });
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

  await run("E1 unauthenticated", async () => {
    const res = await call(server, "POST", "/v1/me/email-change", {
      json: { newEmail: emailTargetA },
    });
    assertStatus("E1", res.status, 401);
  });

  await run("E3 same email", async () => {
    const res = await call(server, "POST", "/v1/me/email-change", {
      bearer: access,
      json: { newEmail: emailOld },
    });
    assertStatus("E3", res.status, 400);
  });

  await run("E4 reserved email", async () => {
    const res = await call(server, "POST", "/v1/me/email-change", {
      bearer: access,
      json: { newEmail: emailReserved },
    });
    assertStatus("E4", res.status, 409);
  });

  await run("E2 valid request", async () => {
    clearAuthEmailCaptures();
    const res = await call(server, "POST", "/v1/me/email-change", {
      bearer: access,
      json: { newEmail: emailTargetA },
    });
    assertStatus("E2", res.status, [200, 201]);

    const active = await prisma.verificationToken.findMany({
      where: { userId, type: "email_change", usedAt: null },
    });
    if (active.length !== 1) {
      throw new Error(`E2: expected 1 active email_change token, got ${active.length}`);
    }
    if (active[0]!.email !== emailTargetA) {
      throw new Error(`E2: token email=${active[0]!.email}`);
    }

    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (row.email !== emailOld) throw new Error(`E2: User.email changed early to ${row.email}`);

    tokenA = lastEmailChangeRawToken() ?? "";
    if (!tokenA) throw new Error("E2: missing captured raw token A");
    captureToA = lastEmailChangeCapture()?.to ?? "";
  });

  await run("E5 previous token invalidation", async () => {
    const res = await call(server, "POST", "/v1/me/email-change", {
      bearer: access,
      json: { newEmail: emailTargetB },
    });
    assertStatus("E5 request B", res.status, [200, 201]);

    tokenB = lastEmailChangeRawToken() ?? "";
    if (!tokenB) throw new Error("E5: missing captured raw token B");
    if (tokenB === tokenA) throw new Error("E5: token B equals token A");
    captureToB = lastEmailChangeCapture()?.to ?? "";

    const active = await prisma.verificationToken.findMany({
      where: { userId, type: "email_change", usedAt: null },
    });
    if (active.length !== 1) {
      throw new Error(`E5: expected 1 active token after second request, got ${active.length}`);
    }
    if (active[0]!.email !== emailTargetB) {
      throw new Error(`E5: active token email=${active[0]!.email}`);
    }

    const reuseA = await call(server, "POST", "/v1/auth/verify-email", {
      json: { token: tokenA },
    });
    assertStatus("E5 token A consume", reuseA.status, 400);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (row.email !== emailOld) throw new Error("E5: email changed by invalidated token A");
  });

  await run("E6 successful verification", async () => {
    const res = await call(server, "POST", "/v1/auth/verify-email", {
      json: { token: tokenB },
    });
    assertStatus("E6", res.status, [200, 201]);
    const body = res.body as { ok?: boolean; type?: string };
    if (body.ok !== true) throw new Error(`E6: unexpected body ${JSON.stringify(res.body)}`);
    if (body.type !== "email_change") throw new Error(`E6: type=${String(body.type)}`);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (row.email !== emailTargetB) throw new Error(`E6: email=${row.email}`);
    if (!row.emailVerifiedAt) throw new Error("E6: emailVerifiedAt missing");

    const tok = await prisma.verificationToken.findFirst({
      where: { userId, type: "email_change", email: emailTargetB },
      orderBy: { createdAt: "desc" },
    });
    if (!tok?.usedAt) throw new Error("E6: token B usedAt missing");

    const auditsAfter = await prisma.auditLog.count({
      where: { action: "email.change", entityId: userId },
    });
    if (auditsAfter !== auditsBefore + 1) {
      throw new Error(`E6: expected +1 email.change audit (${auditsBefore} → ${auditsAfter})`);
    }
  });

  await run("E7 token reuse", async () => {
    const res = await call(server, "POST", "/v1/auth/verify-email", {
      json: { token: tokenB },
    });
    assertStatus("E7", res.status, 400);
  });

  await run("E8 sessions remain", async () => {
    for (const id of sessionIds) {
      const s = await prisma.session.findUniqueOrThrow({ where: { id } });
      if (s.revokedAt) throw new Error(`E8: session ${id} was revoked`);
    }
    const me = await call(server, "GET", "/v1/auth/me", { bearer: access });
    assertStatus("E8 me", me.status, 200);
    const body = me.body as { email?: string };
    if (body.email !== emailTargetB) throw new Error(`E8: me.email=${String(body.email)}`);
  });

  await run("E9 email destination", async () => {
    if (!captureToA || captureToA !== emailTargetA) {
      throw new Error(`E9: capture A to=${captureToA} expected ${emailTargetA}`);
    }
    if (!captureToB || captureToB !== emailTargetB) {
      throw new Error(`E9: capture B to=${captureToB} expected ${emailTargetB}`);
    }
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
