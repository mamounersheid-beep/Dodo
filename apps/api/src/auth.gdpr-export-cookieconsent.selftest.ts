/**
 * Gap A — GDPR Export · CookieConsent (Option A, test-only).
 * Paper Decision 2026-09-03: export CookieConsent where userId = authenticated user.
 *
 * Requires: DATABASE_URL + seed
 * Run (after build): pnpm --filter @dodo/api exec node dist/auth.gdpr-export-cookieconsent.selftest.js
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

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

type HttpResult = {
  status: number;
  body: unknown;
  setCookies: string[];
};

const COOKIE_CONSENT_FIELDS = new Set([
  "id",
  "visitorKey",
  "userId",
  "categoriesJson",
  "policyVersion",
  "createdAt",
]);

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

function asExportBody(body: unknown): {
  cookieConsents?: Array<Record<string, unknown>>;
} {
  return body as { cookieConsents?: Array<Record<string, unknown>> };
}

async function main() {
  const stamp = Date.now();
  const emailA = `gap-a-a-${stamp}@gdpr.invalid`;
  const emailB = `gap-a-b-${stamp}@gdpr.invalid`;
  const password = "GapACookieConsentPass!";
  const results: Result[] = [];
  const scenarioIds = [
    "G-CC1 own CookieConsent in export",
    "G-CC2 no guest / other-user leak",
    "G-CC3 createdAt ASC",
    "G-CC4 no extra secret fields",
  ];

  console.log("Gap A — GDPR Export · CookieConsent (Option A, test-only)\n");

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
  let ownIds: string[] = [];
  let otherUserConsentId = "";
  let guestConsentId = "";
  let exportConsents: Array<Record<string, unknown>> = [];

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
    const userB = await prisma.user.findUniqueOrThrow({ where: { email: emailB } });
    userIdB = userB.id;

    const t1 = new Date("2026-01-01T10:00:00.000Z");
    const t2 = new Date("2026-01-02T10:00:00.000Z");
    const categories = {
      necessary: true,
      preferences: false,
      analytics: true,
      marketing: false,
    };

    const c1 = await prisma.cookieConsent.create({
      data: {
        userId: userIdA,
        categoriesJson: categories,
        policyVersion: "1",
        createdAt: t1,
      },
    });
    const c2 = await prisma.cookieConsent.create({
      data: {
        userId: userIdA,
        visitorKey: `linked-visitor-${stamp}`,
        categoriesJson: { ...categories, marketing: true },
        policyVersion: "2",
        createdAt: t2,
      },
    });
    ownIds = [c1.id, c2.id];

    const other = await prisma.cookieConsent.create({
      data: {
        userId: userIdB,
        categoriesJson: categories,
        policyVersion: "1",
        createdAt: new Date("2026-01-01T12:00:00.000Z"),
      },
    });
    otherUserConsentId = other.id;

    const guest = await prisma.cookieConsent.create({
      data: {
        visitorKey: `guest-only-${stamp}`,
        categoriesJson: categories,
        policyVersion: "1",
        createdAt: new Date("2026-01-01T11:00:00.000Z"),
      },
    });
    guestConsentId = guest.id;

    const exportRes = await call(server, "GET", "/v1/me/gdpr/export", { bearer: accessA });
    assertStatus("export", exportRes.status, 200);
    const body = asExportBody(exportRes.body);
    if (!Array.isArray(body.cookieConsents)) {
      throw new Error("export missing cookieConsents array");
    }
    exportConsents = body.cookieConsents;
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

  await run("G-CC1 own CookieConsent in export", async () => {
    if (exportConsents.length !== 2) {
      throw new Error(`expected 2 own consents, got ${exportConsents.length}`);
    }
    const ids = exportConsents.map((r) => r.id);
    for (const id of ownIds) {
      if (!ids.includes(id)) throw new Error(`missing own consent ${id}`);
    }
    for (const row of exportConsents) {
      if (row.userId !== userIdA) throw new Error(`unexpected userId ${String(row.userId)}`);
    }
  });

  await run("G-CC2 no guest / other-user leak", async () => {
    const ids = exportConsents.map((r) => r.id);
    if (ids.includes(otherUserConsentId)) {
      throw new Error("other user's CookieConsent leaked into export");
    }
    if (ids.includes(guestConsentId)) {
      throw new Error("guest visitorKey-only CookieConsent leaked into export");
    }
    for (const row of exportConsents) {
      if (row.userId == null || row.userId === "") {
        throw new Error("export included a row without userId (guest-like)");
      }
      if (row.userId !== userIdA) {
        throw new Error(`export included foreign userId ${String(row.userId)}`);
      }
    }
  });

  await run("G-CC3 createdAt ASC", async () => {
    const times = exportConsents.map((r) => new Date(String(r.createdAt)).getTime());
    for (let i = 1; i < times.length; i++) {
      if (times[i]! < times[i - 1]!) {
        throw new Error("cookieConsents not ordered by createdAt ASC");
      }
    }
    if (exportConsents[0]?.id !== ownIds[0] || exportConsents[1]?.id !== ownIds[1]) {
      throw new Error("expected oldest→newest own consent order");
    }
  });

  await run("G-CC4 no extra secret fields", async () => {
    for (const row of exportConsents) {
      for (const key of Object.keys(row)) {
        if (!COOKIE_CONSENT_FIELDS.has(key)) {
          throw new Error(`unexpected field on CookieConsent export: ${key}`);
        }
      }
      for (const banned of [
        "passwordHash",
        "tokenHash",
        "refreshTokenHash",
        "password",
        "token",
        "secret",
      ]) {
        if (banned in row) throw new Error(`secret-like field present: ${banned}`);
      }
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
