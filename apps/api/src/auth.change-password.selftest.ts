/**
 * Unit 6 — Change Password acceptance (Option A, test-only).
 * Scenarios CP1–CP7 per 10.1-auth-gdpr.md Change Password.
 *
 * Requires: DATABASE_URL + seed
 * Run (after build): pnpm --filter @dodo/api exec node dist/auth.change-password.selftest.js
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

function extractCookie(setCookies: string[], name: string): string | undefined {
  for (const raw of setCookies) {
    const part = raw.split(";")[0]?.trim();
    if (part?.startsWith(`${name}=`)) return part;
  }
  return undefined;
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

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

async function main() {
  const stamp = Date.now();
  const email = `unit6-cp-${stamp}@auth.invalid`;
  const oldPassword = "Unit6OldPass!";
  const newPassword = "Unit6NewPass!";
  const results: Result[] = [];
  const scenarioIds = [
    "CP1 correct currentPassword",
    "CP2 wrong currentPassword",
    "CP3 current session remains",
    "CP4 other sessions revoked",
    "CP5 login new/old",
    "CP6 password.change audit",
    "CP7 unauthenticated",
  ];

  console.log("Unit 6 — Change Password (Option A, test-only)\n");

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
  let refreshB = "";
  let userId = "";
  let sessionIdA = "";
  let sessionIdB = "";
  let auditsBefore = 0;

  try {
    const reg = await call(server, "POST", "/v1/auth/register", {
      json: { email, password: oldPassword, locale: "de" },
    });
    assertStatus("register", reg.status, [200, 201]);
    accessA = getAccessToken(reg.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    userId = user.id;

    // Session A = register session
    const sessA = await prisma.session.findFirst({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: "asc" },
    });
    if (!sessA) throw new Error("setup: missing session A");
    sessionIdA = sessA.id;

    // Session B = second login (other session to revoke)
    const loginB = await call(server, "POST", "/v1/auth/login", {
      json: { email, password: oldPassword },
    });
    assertStatus("login B", loginB.status, 200);
    refreshB = extractCookie(loginB.setCookies, REFRESH_COOKIE) ?? "";
    if (!refreshB) throw new Error("setup: missing refresh cookie for session B");
    const sessB = await prisma.session.findFirst({
      where: { userId, revokedAt: null, id: { not: sessionIdA } },
      orderBy: { createdAt: "desc" },
    });
    if (!sessB) throw new Error("setup: missing session B");
    sessionIdB = sessB.id;

    auditsBefore = await prisma.auditLog.count({
      where: { action: "password.change", entityId: userId },
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

  await run("CP2 wrong currentPassword", async () => {
    const res = await call(server, "POST", "/v1/me/password", {
      bearer: accessA,
      json: { currentPassword: "DefinitelyWrong!", newPassword },
    });
    assertStatus("CP2", res.status, 401);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // password must be unchanged — old login still works later in CP1 path
    if (!user.passwordHash) throw new Error("CP2: passwordHash missing");
  });

  await run("CP1 correct currentPassword", async () => {
    const res = await call(server, "POST", "/v1/me/password", {
      bearer: accessA,
      json: { currentPassword: oldPassword, newPassword },
    });
    assertStatus("CP1", res.status, [200, 201]);
    const body = res.body as { ok?: boolean };
    if (body.ok !== true) throw new Error(`CP1: unexpected body ${JSON.stringify(res.body)}`);
  });

  await run("CP3 current session remains", async () => {
    const me = await call(server, "GET", "/v1/auth/me", { bearer: accessA });
    assertStatus("CP3 me", me.status, 200);
    const sess = await prisma.session.findUniqueOrThrow({ where: { id: sessionIdA } });
    if (sess.revokedAt) throw new Error("CP3: current session was revoked");
  });

  await run("CP4 other sessions revoked", async () => {
    const sess = await prisma.session.findUniqueOrThrow({ where: { id: sessionIdB } });
    if (!sess.revokedAt) throw new Error("CP4: other session still active");
    const refresh = await call(server, "POST", "/v1/auth/refresh", { cookie: refreshB });
    assertStatus("CP4 refresh other", refresh.status, 401);
  });

  await run("CP5 login new/old", async () => {
    const okNew = await call(server, "POST", "/v1/auth/login", {
      json: { email, password: newPassword },
    });
    assertStatus("CP5 new", okNew.status, 200);
    const failOld = await call(server, "POST", "/v1/auth/login", {
      json: { email, password: oldPassword },
    });
    assertStatus("CP5 old", failOld.status, 401);
  });

  await run("CP6 password.change audit", async () => {
    const auditsAfter = await prisma.auditLog.count({
      where: { action: "password.change", entityId: userId },
    });
    if (auditsAfter !== auditsBefore + 1) {
      throw new Error(`CP6: expected +1 password.change audit (${auditsBefore} → ${auditsAfter})`);
    }
  });

  await run("CP7 unauthenticated", async () => {
    const res = await call(server, "POST", "/v1/me/password", {
      json: { currentPassword: newPassword, newPassword: "AnotherPass1!" },
    });
    assertStatus("CP7", res.status, 401);
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
