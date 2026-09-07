/**
 * Unit 4 — Final Acceptance Verification (Option A, test-only).
 * Gaps A/B/C closed — this suite proves remaining Export/Anonymize acceptance + guest denial.
 *
 * Requires: DATABASE_URL + seed
 * Run (after build): pnpm --filter @dodo/api exec node dist/auth.gdpr-unit4-final.selftest.js
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

async function createApp(): Promise<{
  app: Awaited<ReturnType<typeof NestFactory.create>>;
  server: Server;
  prisma: PrismaService;
}> {
  const app = await NestFactory.create(AuthVerifyTestAppModule, { logger: ["error"] });
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
  return {
    app,
    server: app.getHttpServer() as Server,
    prisma: app.get(PrismaService),
  };
}

async function main() {
  const stamp = Date.now();
  const password = "Unit4FinalPass!";
  const results: Result[] = [];
  const scenarioIds = [
    "U4-V1 GDPR Export contract + audit",
    "U4-V1-rl Export rate limit 3/hour",
    "U4-V2 Guest denial",
    "U4-V3 Anonymize success + retention",
    "U4-V4 Rejection INVALID_PASSWORD",
  ];

  console.log("Unit 4 — Final Acceptance Verification (test-only)\n");

  let app;
  let server: Server;
  let prisma: PrismaService;
  try {
    ({ app, server, prisma } = await createApp());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of scenarioIds) {
      results.push({ id, status: "BLOCKED", note: msg });
      console.error(`  ⊘ ${id}: BLOCKED`);
    }
    printSummary(results);
    process.exit(2);
  }

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

  const emailExport = `u4-export-${stamp}@gdpr.invalid`;
  const emailAnon = `u4-anon-${stamp}@gdpr.invalid`;
  const emailReject = `u4-reject-${stamp}@gdpr.invalid`;

  await run("U4-V1 GDPR Export contract + audit", async () => {
    const reg = await call(server, "POST", "/v1/auth/register", {
      json: { email: emailExport, password, locale: "de", name: "Export User" },
    });
    assertStatus("register export", reg.status, [200, 201]);
    const access = getAccessToken(reg.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: emailExport } });

    await prisma.address.create({
      data: {
        userId: user.id,
        type: "SHIPPING",
        name: "Export User",
        line1: "Teststr. 1",
        postalCode: "10115",
        city: "Berlin",
        countryCode: "DE",
      },
    });
    await prisma.cookieConsent.create({
      data: {
        userId: user.id,
        categoriesJson: {
          necessary: true,
          preferences: false,
          analytics: false,
          marketing: false,
        },
        policyVersion: "1",
      },
    });

    const auditsBefore = await prisma.auditLog.count({
      where: { action: "gdpr.export", entityId: user.id },
    });

    const res = await call(server, "GET", "/v1/me/gdpr/export", { bearer: access });
    assertStatus("export", res.status, 200);
    const body = res.body as Record<string, unknown>;
    for (const key of [
      "exportedAt",
      "user",
      "addresses",
      "orders",
      "bonus",
      "sessions",
      "reviews",
      "cookieConsents",
    ]) {
      if (!(key in body)) throw new Error(`export missing key: ${key}`);
    }
    if (!Array.isArray(body.cookieConsents) || body.cookieConsents.length < 1) {
      throw new Error("cookieConsents missing or empty");
    }
    const sessions = body.sessions as Array<Record<string, unknown>>;
    for (const s of sessions) {
      for (const k of Object.keys(s)) {
        if (k.toLowerCase().includes("hash")) {
          throw new Error(`session leaked hash field: ${k}`);
        }
      }
    }

    const auditsAfter = await prisma.auditLog.count({
      where: { action: "gdpr.export", entityId: user.id },
    });
    if (auditsAfter !== auditsBefore + 1) {
      throw new Error(`gdpr.export audit not written (${auditsBefore} → ${auditsAfter})`);
    }
  });

  await run("U4-V1-rl Export rate limit 3/hour", async () => {
    const rl = await createApp();
    try {
      const emailRl = `u4-rl-${stamp}@gdpr.invalid`;
      const reg = await call(rl.server, "POST", "/v1/auth/register", {
        json: { email: emailRl, password, locale: "de" },
      });
      assertStatus("rl register", reg.status, [200, 201]);
      const access = getAccessToken(reg.body);

      for (let i = 1; i <= 3; i++) {
        const r = await call(rl.server, "GET", "/v1/me/gdpr/export", { bearer: access });
        assertStatus(`rl export ${i}`, r.status, 200);
      }
      const r4 = await call(rl.server, "GET", "/v1/me/gdpr/export", { bearer: access });
      assertStatus("rl export 4 throttled", r4.status, 429);
    } finally {
      await rl.app.close();
    }
  });

  await run("U4-V2 Guest denial", async () => {
    const exp = await call(server, "GET", "/v1/me/gdpr/export");
    assertStatus("guest export", exp.status, 401);
    const anon = await call(server, "POST", "/v1/me/gdpr/anonymize", {
      json: { password: "x" },
    });
    assertStatus("guest anonymize", anon.status, 401);
  });

  await run("U4-V3 Anonymize success + retention", async () => {
    const reg = await call(server, "POST", "/v1/auth/register", {
      json: {
        email: emailAnon,
        password,
        locale: "de",
        name: "Anon User",
      },
    });
    assertStatus("register anon", reg.status, [200, 201]);
    const access = getAccessToken(reg.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: emailAnon } });
    await prisma.user.update({
      where: { id: user.id },
      data: { companyName: "Anon GmbH", vatId: "DE123" },
    });

    await prisma.address.create({
      data: {
        userId: user.id,
        type: "BILLING",
        name: "Anon User",
        line1: "Anonweg 2",
        postalCode: "80331",
        city: "München",
        countryCode: "DE",
      },
    });
    await prisma.cookieConsent.create({
      data: {
        userId: user.id,
        categoriesJson: { necessary: true, preferences: true, analytics: false, marketing: false },
        policyVersion: "2",
      },
    });

    const variant = await prisma.productVariant.findFirst();
    if (variant) {
      await prisma.wishlistItem.create({
        data: { userId: user.id, variantId: variant.id },
      });
    }

    const product = await prisma.product.findFirst();
    if (product) {
      await prisma.review.create({
        data: {
          productId: product.id,
          userId: user.id,
          rating: 5,
          body: "PII review text",
          status: "published",
        },
      });
    }

    const rawTok = randomBytes(32).toString("base64url");
    await prisma.verificationToken.create({
      data: {
        userId: user.id,
        email: emailAnon,
        type: "email_verify",
        tokenHash: hashToken(rawTok),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await prisma.verificationToken.create({
      data: {
        userId: user.id,
        email: emailAnon,
        type: "password_reset",
        tokenHash: hashToken(randomBytes(32).toString("base64url")),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const order = await prisma.order.create({
      data: {
        orderNumber: `U4-${stamp}`,
        userId: user.id,
        status: "PLACED",
        currencyCode: "EUR",
        shippingCountryCode: "DE",
        companyIsKleinunternehmer: true,
        itemsSubtotal: 10,
        shippingTotal: 0,
        grandTotal: 10,
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: 0,
        shippingAddressJson: { line1: "x" },
        billingAddressJson: { line1: "x" },
        sellerIdentitySnapshotJson: {
          legalName: "Test Seller UG",
          line1: "Teststr. 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
          supportEmail: "support@example.com",
          supportPhone: null,
        },
        invoices: {
          create: {
            invoiceNumber: `INV-U4-${stamp}`,
            grandTotalSnapshot: 10,
            buyerSnapshotJson: { email: emailAnon },
            sellerSnapshotJson: { name: "Shop" },
          },
        },
      },
      include: { invoices: true },
    });
    const orderId = order.id;
    const invoiceId = order.invoices[0]!.id;

    const auditsBefore = await prisma.auditLog.count({
      where: { action: "gdpr.anonymize", entityId: user.id },
    });

    const res = await call(server, "POST", "/v1/me/gdpr/anonymize", {
      bearer: access,
      json: { password },
    });
    assertStatus("anonymize", res.status, [200, 201]);
    const body = res.body as Record<string, unknown>;
    if (body.status !== "done") throw new Error(`status=${String(body.status)}`);
    if (typeof body.anonymizedAt !== "string" || !body.anonymizedAt) {
      throw new Error("missing anonymizedAt");
    }

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!after.anonymizedAt || !after.deletedAt) throw new Error("anonymize markers missing");
    if (!after.email.startsWith("deleted-") || !after.email.endsWith("@anonymized.invalid")) {
      throw new Error(`email not anonymized: ${after.email}`);
    }
    if (after.name !== null || after.companyName !== null || after.vatId !== null) {
      throw new Error("PII fields not cleared");
    }

    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    for (const s of sessions) {
      if (!s.revokedAt) throw new Error(`session ${s.id} not revoked`);
    }

    const activeTok = await prisma.verificationToken.count({
      where: { userId: user.id, usedAt: null },
    });
    if (activeTok !== 0) throw new Error(`active VerificationTokens remain: ${activeTok}`);

    const addrCount = await prisma.address.count({ where: { userId: user.id } });
    if (addrCount !== 0) throw new Error("addresses not deleted");
    const wishCount = await prisma.wishlistItem.count({ where: { userId: user.id } });
    if (wishCount !== 0) throw new Error("wishlist not deleted");
    const ccCount = await prisma.cookieConsent.count({ where: { userId: user.id } });
    if (ccCount !== 0) throw new Error("CookieConsent not deleted");

    if (product) {
      const rev = await prisma.review.findFirst({ where: { userId: user.id, productId: product.id } });
      if (rev && rev.body !== null) throw new Error("review body not scrubbed");
    }

    const orderAfter = await prisma.order.findUnique({ where: { id: orderId } });
    if (!orderAfter) throw new Error("order deleted (GoBD violation)");
    const invAfter = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invAfter) throw new Error("invoice deleted (GoBD violation)");

    const auditsAfter = await prisma.auditLog.count({
      where: { action: "gdpr.anonymize", entityId: user.id },
    });
    if (auditsAfter !== auditsBefore + 1) {
      throw new Error(`gdpr.anonymize audit not written (${auditsBefore} → ${auditsAfter})`);
    }

    const me = await call(server, "GET", "/v1/auth/me", { bearer: access });
    assertStatus("me after anonymize", me.status, 401);
  });

  await run("U4-V4 Rejection INVALID_PASSWORD", async () => {
    const reg = await call(server, "POST", "/v1/auth/register", {
      json: { email: emailReject, password, locale: "de" },
    });
    assertStatus("register reject", reg.status, [200, 201]);
    const access = getAccessToken(reg.body);
    const res = await call(server, "POST", "/v1/me/gdpr/anonymize", {
      bearer: access,
      json: { password: "WrongPasswordHere!" },
    });
    assertStatus("wrong password", res.status, 401);
    const body = res.body as Record<string, unknown>;
    if (body.status !== "rejected" || body.reason !== "INVALID_PASSWORD") {
      throw new Error(`unexpected reject body: ${JSON.stringify(body)}`);
    }
    const keys = Object.keys(body).sort();
    if (keys.join(",") !== "reason,status") {
      throw new Error(`unexpected reject keys: ${keys.join(",")}`);
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
