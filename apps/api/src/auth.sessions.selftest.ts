/**
 * Unit 7 — Sessions List + Logout-all acceptance (Option A, test-only).
 * Scenarios S1–S7 per 10.1-auth-gdpr.md Sessions / Logout-all.
 *
 * Requires: DATABASE_URL + seed
 * Run (after build): pnpm --filter @dodo/api exec node dist/auth.sessions.selftest.js
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
import { REFRESH_COOKIE } from "./auth/auth.types";
import { PrismaService } from "./prisma/prisma.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

type HttpResult = {
  status: number;
  body: unknown;
  setCookies: string[];
};

type SessionRow = {
  id?: string;
  createdAt?: unknown;
  expiresAt?: unknown;
  revokedAt?: unknown;
  ip?: unknown;
  userAgent?: unknown;
  isCurrent?: boolean;
  refreshTokenHash?: unknown;
  [key: string]: unknown;
};

function extractCookie(setCookies: string[], name: string): string | undefined {
  for (const raw of setCookies) {
    const part = raw.split(";")[0]?.trim();
    if (part?.startsWith(`${name}=`)) return part;
  }
  return undefined;
}

function isRefreshCookieCleared(setCookies: string[]): boolean {
  for (const raw of setCookies) {
    if (!raw.toLowerCase().startsWith(`${REFRESH_COOKIE.toLowerCase()}=`)) continue;
    const value = raw.split(";")[0]?.slice(REFRESH_COOKIE.length + 1) ?? "";
    const attrs = raw.toLowerCase();
    if (
      value === "" ||
      attrs.includes("max-age=0") ||
      attrs.includes("expires=thu, 01 jan 1970")
    ) {
      return true;
    }
  }
  return false;
}

function getAccessToken(body: unknown): string {
  const t = (body as { accessToken?: string })?.accessToken;
  if (!t) throw new Error("missing accessToken");
  return t;
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

function assertNoSecrets(label: string, row: SessionRow): void {
  const banned = ["refreshTokenHash", "passwordHash", "token", "rawToken", "secret"];
  for (const key of banned) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] != null) {
      throw new Error(`${label}: leaked secret field ${key}`);
    }
  }
  const serialized = JSON.stringify(row);
  if (/refreshTokenHash|"passwordHash"/.test(serialized)) {
    throw new Error(`${label}: secret string present in payload`);
  }
}

function assertSessionShape(label: string, row: SessionRow): void {
  if (typeof row.id !== "string" || !row.id) throw new Error(`${label}: missing id`);
  if (row.createdAt == null) throw new Error(`${label}: missing createdAt`);
  if (row.expiresAt == null) throw new Error(`${label}: missing expiresAt`);
  if (!("ip" in row)) throw new Error(`${label}: missing ip key`);
  if (!("userAgent" in row)) throw new Error(`${label}: missing userAgent key`);
  if (typeof row.isCurrent !== "boolean") throw new Error(`${label}: missing isCurrent`);
  assertNoSecrets(label, row);
}

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

async function main() {
  const stamp = Date.now();
  const email = `unit7-sess-${stamp}@auth.invalid`;
  const password = "Unit7SessPass!";
  const results: Result[] = [];
  const scenarioIds = [
    "S1 unauthenticated",
    "S2 sessions list shape",
    "S3 two sessions isCurrent",
    "S4 logout-all correct password",
    "S5 logout-all wrong password",
    "S6 access after logout-all",
    "S7 auth.logout_all audit",
  ];

  console.log("Unit 7 — Sessions List + Logout-all (Option A, test-only)\n");

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
  let accessB = "";
  let refreshA = "";
  let refreshB = "";
  let userId = "";
  let sessionIdA = "";
  let sessionIdB = "";
  let auditsBefore = 0;

  try {
    const reg = await call(server, "POST", "/v1/auth/register", {
      json: { email, password, locale: "de" },
    });
    assertStatus("register", reg.status, [200, 201]);
    accessA = getAccessToken(reg.body);
    refreshA = extractCookie(reg.setCookies, REFRESH_COOKIE) ?? "";
    if (!refreshA) throw new Error("setup: missing refresh cookie A");

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    userId = user.id;

    const sessA = await prisma.session.findFirst({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: "asc" },
    });
    if (!sessA) throw new Error("setup: missing session A");
    sessionIdA = sessA.id;

    const loginB = await call(server, "POST", "/v1/auth/login", {
      json: { email, password },
    });
    assertStatus("login B", loginB.status, 200);
    accessB = getAccessToken(loginB.body);
    refreshB = extractCookie(loginB.setCookies, REFRESH_COOKIE) ?? "";
    if (!refreshB) throw new Error("setup: missing refresh cookie B");

    const sessB = await prisma.session.findFirst({
      where: { userId, revokedAt: null, id: { not: sessionIdA } },
      orderBy: { createdAt: "desc" },
    });
    if (!sessB) throw new Error("setup: missing session B");
    sessionIdB = sessB.id;

    auditsBefore = await prisma.auditLog.count({
      where: { action: "auth.logout_all", entityId: userId },
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

  await run("S1 unauthenticated", async () => {
    const list = await call(server, "GET", "/v1/me/sessions");
    assertStatus("S1 list", list.status, 401);
    const logoutAll = await call(server, "POST", "/v1/me/sessions/logout-all", {
      json: { currentPassword: password },
    });
    assertStatus("S1 logout-all", logoutAll.status, 401);
  });

  await run("S2 sessions list shape", async () => {
    const res = await call(server, "GET", "/v1/me/sessions", { bearer: accessA });
    assertStatus("S2", res.status, 200);
    if (!Array.isArray(res.body)) throw new Error(`S2: expected array, got ${typeof res.body}`);
    if (res.body.length < 1) throw new Error("S2: empty sessions list");
    for (const row of res.body as SessionRow[]) {
      assertSessionShape("S2", row);
    }
    const current = (res.body as SessionRow[]).filter((s) => s.isCurrent === true);
    if (current.length !== 1) {
      throw new Error(`S2: expected exactly one isCurrent=true, got ${current.length}`);
    }
    if (current[0]?.id !== sessionIdA) {
      throw new Error("S2: isCurrent is not the bearer session");
    }
  });

  await run("S3 two sessions isCurrent", async () => {
    const res = await call(server, "GET", "/v1/me/sessions", { bearer: accessA });
    assertStatus("S3", res.status, 200);
    if (!Array.isArray(res.body)) throw new Error("S3: expected array");
    const rows = res.body as SessionRow[];
    const ids = new Set(rows.map((r) => r.id));
    if (!ids.has(sessionIdA) || !ids.has(sessionIdB)) {
      throw new Error("S3: both sessions must appear in list");
    }
    const current = rows.filter((s) => s.isCurrent === true);
    if (current.length !== 1 || current[0]?.id !== sessionIdA) {
      throw new Error("S3: exactly one isCurrent=true for session A expected");
    }
    const b = rows.find((s) => s.id === sessionIdB);
    if (!b || b.isCurrent !== false) throw new Error("S3: session B must have isCurrent=false");
  });

  // Wrong password before successful logout-all (same order pattern as Unit 6 CP2→CP1)
  await run("S5 logout-all wrong password", async () => {
    const res = await call(server, "POST", "/v1/me/sessions/logout-all", {
      bearer: accessA,
      json: { currentPassword: "DefinitelyWrong!" },
    });
    assertStatus("S5", res.status, 401);
    const a = await prisma.session.findUniqueOrThrow({ where: { id: sessionIdA } });
    const b = await prisma.session.findUniqueOrThrow({ where: { id: sessionIdB } });
    if (a.revokedAt) throw new Error("S5: session A was revoked");
    if (b.revokedAt) throw new Error("S5: session B was revoked");
  });

  await run("S4 logout-all correct password", async () => {
    const res = await call(server, "POST", "/v1/me/sessions/logout-all", {
      bearer: accessA,
      cookie: refreshA,
      json: { currentPassword: password },
    });
    assertStatus("S4", res.status, [200, 201]);
    const body = res.body as { ok?: boolean };
    if (body.ok !== true) throw new Error(`S4: unexpected body ${JSON.stringify(res.body)}`);

    const a = await prisma.session.findUniqueOrThrow({ where: { id: sessionIdA } });
    const b = await prisma.session.findUniqueOrThrow({ where: { id: sessionIdB } });
    if (!a.revokedAt) throw new Error("S4: session A still active");
    if (!b.revokedAt) throw new Error("S4: session B still active");

    const refreshFailA = await call(server, "POST", "/v1/auth/refresh", { cookie: refreshA });
    assertStatus("S4 refresh A", refreshFailA.status, 401);
    const refreshFailB = await call(server, "POST", "/v1/auth/refresh", { cookie: refreshB });
    assertStatus("S4 refresh B", refreshFailB.status, 401);

    if (!isRefreshCookieCleared(res.setCookies)) {
      throw new Error(
        `S4: refresh cookie not cleared in Set-Cookie: ${JSON.stringify(res.setCookies)}`,
      );
    }
  });

  await run("S6 access after logout-all", async () => {
    const meA = await call(server, "GET", "/v1/auth/me", { bearer: accessA });
    assertStatus("S6 me A", meA.status, 401);
    const meB = await call(server, "GET", "/v1/auth/me", { bearer: accessB });
    assertStatus("S6 me B", meB.status, 401);
    const list = await call(server, "GET", "/v1/me/sessions", { bearer: accessA });
    assertStatus("S6 list", list.status, 401);
  });

  await run("S7 auth.logout_all audit", async () => {
    const auditsAfter = await prisma.auditLog.count({
      where: { action: "auth.logout_all", entityId: userId },
    });
    if (auditsAfter !== auditsBefore + 1) {
      throw new Error(`S7: expected +1 auth.logout_all audit (${auditsBefore} → ${auditsAfter})`);
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
