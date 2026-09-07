/**
 * Gap B — GDPR Anonymize · Rejection Shape (Option A, test-only).
 * Paper Amend 2026-09-03: INVALID_PASSWORD via HTTP; ALREADY_ANONYMIZED = defensive/service-level only.
 *
 * Requires: DATABASE_URL + seed
 * Run (after build): pnpm --filter @dodo/api exec node dist/auth.gdpr-anonymize-reject.selftest.js
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import type { Response } from "express";
import { AuthVerifyTestAppModule } from "./auth.verify-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { GdprService } from "./users/gdpr.service";
import type { AuthUser } from "./auth/auth.types";
import { RoleCode } from "@dodo/shared-types";

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

function assertExactReject(body: unknown, reason: string): void {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`expected object body, got ${typeof body}`);
  }
  const o = body as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.join(",") !== "reason,status") {
    throw new Error(`unexpected reject keys: ${keys.join(",")}`);
  }
  if (o.status !== "rejected") throw new Error(`status=${String(o.status)}`);
  if (o.reason !== reason) throw new Error(`reason=${String(o.reason)} expected ${reason}`);
}

function assertNoLeak(body: unknown, banned: string[]): void {
  const text = JSON.stringify(body);
  for (const b of banned) {
    if (text.includes(b)) throw new Error(`rejection leaked value: ${b}`);
  }
  const o = body as Record<string, unknown>;
  for (const k of ["message", "code", "error", "email", "password", "passwordHash", "traceId"]) {
    if (k in o) throw new Error(`unexpected field on reject body: ${k}`);
  }
}

function createCaptureRes(): Response & { statusCode: number; body: unknown } {
  const cap = {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    clearCookie() {
      return this;
    },
  };
  return cap as unknown as Response & { statusCode: number; body: unknown };
}

async function main() {
  const stamp = Date.now();
  const email = `gap-b-${stamp}@gdpr.invalid`;
  const password = "GapBRejectPass!";
  const results: Result[] = [];
  const scenarioIds = [
    "G-RJ1 wrong password → 401 + INVALID_PASSWORD",
    "G-RJ2 success → done",
    "G-RJ3-svc defensive ALREADY_ANONYMIZED (service-level)",
    "G-RJ4 reject body has no PII / extra fields",
    "G-RJ5 anonymize core intact after success",
  ];

  console.log("Gap B — GDPR Anonymize · Rejection Shape (Paper Amend)\n");

  let app;
  let prisma: PrismaService;
  let gdpr: GdprService;
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
    gdpr = app.get(GdprService);
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
  let wrongBody: unknown;
  let svcRejectBody: unknown;
  let doneBody: unknown;

  try {
    const reg = await call(server, "POST", "/v1/auth/register", {
      json: { email, password, locale: "de" },
    });
    assertStatus("register", reg.status, [200, 201]);
    access = getAccessToken(reg.body);
    userId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
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

  await run("G-RJ1 wrong password → 401 + INVALID_PASSWORD", async () => {
    const res = await call(server, "POST", "/v1/me/gdpr/anonymize", {
      bearer: access,
      json: { password: "DefinitelyWrongPass!" },
    });
    assertStatus("wrong password", res.status, 401);
    assertExactReject(res.body, "INVALID_PASSWORD");
    wrongBody = res.body;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.anonymizedAt) throw new Error("user anonymized after wrong password");
  });

  await run("G-RJ2 success → done", async () => {
    const res = await call(server, "POST", "/v1/me/gdpr/anonymize", {
      bearer: access,
      json: { password },
    });
    assertStatus("success", res.status, [200, 201]);
    const body = res.body as Record<string, unknown>;
    if (body.status !== "done") throw new Error(`status=${String(body.status)}`);
    if (typeof body.anonymizedAt !== "string" || !body.anonymizedAt) {
      throw new Error("missing anonymizedAt");
    }
    doneBody = body;
  });

  await run("G-RJ3-svc defensive ALREADY_ANONYMIZED (service-level)", async () => {
    // Not HTTP acceptance (JwtAuthGuard blocks anonymized users). Direct service call only.
    const emailSvc = `gap-b-svc-${stamp}@gdpr.invalid`;
    const regSvc = await call(server, "POST", "/v1/auth/register", {
      json: { email: emailSvc, password, locale: "de" },
    });
    assertStatus("register svc", regSvc.status, [200, 201]);
    const userSvc = await prisma.user.findUniqueOrThrow({ where: { email: emailSvc } });
    await prisma.user.update({
      where: { id: userSvc.id },
      data: { anonymizedAt: new Date() },
    });

    const authUser: AuthUser = {
      id: userSvc.id,
      email: emailSvc,
      name: null,
      locale: "de",
      roles: [RoleCode.CUSTOMER],
      anonymizedAt: new Date(),
    };
    const cap = createCaptureRes();
    await gdpr.anonymize(authUser, { password }, cap);
    if (cap.statusCode !== 400) {
      throw new Error(`service expected 400, got ${cap.statusCode}`);
    }
    assertExactReject(cap.body, "ALREADY_ANONYMIZED");
    svcRejectBody = cap.body;
  });

  await run("G-RJ4 reject body has no PII / extra fields", async () => {
    assertNoLeak(wrongBody, [email, password, userId, "Password incorrect", "Already anonymized"]);
    assertNoLeak(svcRejectBody, [
      email,
      password,
      "Password incorrect",
      "Already anonymized",
      "Account unavailable",
    ]);
  });

  await run("G-RJ5 anonymize core intact after success", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.anonymizedAt || !user.deletedAt) throw new Error("anonymize markers missing");
    if (!user.email.startsWith("deleted-")) throw new Error("email not anonymized");
    const sessions = await prisma.session.findMany({ where: { userId } });
    for (const s of sessions) {
      if (!s.revokedAt) throw new Error(`session ${s.id} still active`);
    }
    const me = await call(server, "GET", "/v1/auth/me", { bearer: access });
    assertStatus("me after anonymize", me.status, 401);
    const done = doneBody as Record<string, unknown>;
    if (Object.keys(done).sort().join(",") !== "anonymizedAt,status") {
      throw new Error(`unexpected done keys: ${Object.keys(done).join(",")}`);
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
