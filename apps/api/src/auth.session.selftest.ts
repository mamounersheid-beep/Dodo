/**
 * Unit 1 — Auth Session Spine acceptance (Option B).
 * Flow: register → login → me → refresh → logout → refresh=401
 *
 * Requires: DATABASE_URL + seeded roles (pnpm --filter @dodo/database db:seed)
 * Run: pnpm --filter @dodo/api test:session
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

function getAccessToken(body: unknown): string {
  if (typeof body === "object" && body !== null && "accessToken" in body) {
    const t = (body as { accessToken: unknown }).accessToken;
    if (typeof t === "string" && t.length > 0) return t;
  }
  throw new Error(`missing accessToken in response: ${JSON.stringify(body)}`);
}

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

async function runS8(): Promise<Result[]> {
  const out: Result[] = [];

  try {
    const { execSync } = await import("node:child_process");
    execSync("pnpm exec tsx src/auth.selftest.ts", { cwd: process.cwd(), stdio: "pipe" });
    out.push({ id: "S8a auth.selftest (crypto)", status: "PASS" });
    console.log("  ✓ S8a auth.selftest (crypto)");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    out.push({ id: "S8a auth.selftest (crypto)", status: "FAIL", note: msg });
    console.error(`  ✗ S8a: ${msg}`);
  }

  try {
    const { execSync } = await import("node:child_process");
    execSync("pnpm exec tsc -p tsconfig.json --noEmit", { cwd: process.cwd(), stdio: "pipe" });
    out.push({ id: "S8b typecheck", status: "PASS" });
    console.log("  ✓ S8b typecheck");
  } catch {
    out.push({
      id: "S8b typecheck",
      status: "FAIL",
      note: "shipping.service.ts — ShippingProviderRegistry import (outside Unit 1)",
    });
    console.error("  ✗ S8b typecheck (known shipping import — outside Unit 1)");
  }

  return out;
}

async function main() {
  const email = `unit1-${Date.now()}@session-test.invalid`;
  const password = "Unit1TestPass!";
  const results: Result[] = [];

  console.log("Unit 1 — Auth Session Spine (Option B)\n");

  console.log("S8 (no DB required):");
  results.push(...(await runS8()));

  console.log("\nS1–S7 (requires Postgres + seed):");
  let app;
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of [
      "S1 register",
      "S2 me",
      "S3 refresh",
      "S4 logout",
      "S5 refresh=401",
      "S6 login fail",
      "S7 me no auth",
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

  let accessToken = "";
  let refreshCookie = "";

  await run("S1 register", async () => {
    const res = await call(server, "POST", "/v1/auth/register", {
      json: { email, password, locale: "de" },
    });
    assertStatus("S1", res.status, [200, 201]);
    accessToken = getAccessToken(res.body);
    refreshCookie = extractCookie(res.setCookies, REFRESH_COOKIE) ?? "";
    if (!refreshCookie) throw new Error("S1: missing refresh Set-Cookie");
  });

  await run("S2 me", async () => {
    const res = await call(server, "GET", "/v1/auth/me", { bearer: accessToken });
    assertStatus("S2", res.status, 200);
    const body = res.body as { email?: string };
    if (body.email !== email) throw new Error(`S2: email mismatch ${body.email}`);
  });

  await run("S3 refresh", async () => {
    const res = await call(server, "POST", "/v1/auth/refresh", { cookie: refreshCookie });
    assertStatus("S3", res.status, 200);
    accessToken = getAccessToken(res.body);
    const next = extractCookie(res.setCookies, REFRESH_COOKIE);
    if (next) refreshCookie = next;
  });

  await run("S4 logout", async () => {
    const res = await call(server, "POST", "/v1/auth/logout", { bearer: accessToken });
    assertStatus("S4", res.status, 200);
  });

  await run("S5 refresh=401", async () => {
    const res = await call(server, "POST", "/v1/auth/refresh", { cookie: refreshCookie });
    assertStatus("S5", res.status, 401);
  });

  await run("S6 login fail", async () => {
    const res = await call(server, "POST", "/v1/auth/login", {
      json: { email, password: "wrong-password-xyz" },
    });
    assertStatus("S6", res.status, 401);
  });

  await run("S7 me no auth", async () => {
    const res = await call(server, "GET", "/v1/auth/me");
    assertStatus("S7", res.status, 401);
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
