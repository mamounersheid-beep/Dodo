/**
 * Unit 8 — Profile acceptance (Option A, test-only).
 * Scenarios P1–P8 per 10.1-auth-gdpr.md Profile.
 *
 * Requires: DATABASE_URL + seed
 * Run (after build): node dist/auth.profile.selftest.js
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

type MeBody = {
  id?: string;
  email?: string;
  name?: string | null;
  locale?: string;
  companyName?: string | null;
  vatId?: string | null;
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
  const email = `unit8-prof-${stamp}@auth.invalid`;
  const password = "Unit8ProfPass!";
  const results: Result[] = [];
  const scenarioIds = [
    "P1 unauthenticated",
    "P2 basic partial update",
    "P3 forbidden fields",
    "P4 company/VAT",
    "P5 independent fields",
    "P6 invalid DE VAT",
    "P7 profile.update audit",
    "P8 User-only mutation boundary",
  ];

  console.log("Unit 8 — Profile (Option A, test-only)\n");

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
  let emailFrozen = email;

  try {
    const reg = await call(server, "POST", "/v1/auth/register", {
      json: { email, password, locale: "de" },
    });
    assertStatus("register", reg.status, [200, 201]);
    access = getAccessToken(reg.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    userId = user.id;
    emailFrozen = user.email;
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

  await run("P1 unauthenticated", async () => {
    const res = await call(server, "PATCH", "/v1/me/profile", {
      json: { name: "Nope", locale: "en" },
    });
    assertStatus("P1", res.status, 401);
  });

  await run("P2 basic partial update", async () => {
    const res = await call(server, "PATCH", "/v1/me/profile", {
      bearer: access,
      json: { name: "Unit8 Name", locale: "en" },
    });
    assertStatus("P2", res.status, 200);
    const body = res.body as MeBody;
    if (body.name !== "Unit8 Name") throw new Error(`P2: name=${String(body.name)}`);
    if (body.locale !== "en") throw new Error(`P2: locale=${String(body.locale)}`);
    if (body.email !== emailFrozen) throw new Error(`P2: email changed to ${String(body.email)}`);
  });

  await run("P3 forbidden fields", async () => {
    const withEmail = await call(server, "PATCH", "/v1/me/profile", {
      bearer: access,
      json: { email: "hijack@auth.invalid" },
    });
    assertStatus("P3 email", withEmail.status, 400);
    const withType = await call(server, "PATCH", "/v1/me/profile", {
      bearer: access,
      json: { customerType: "BUSINESS" },
    });
    assertStatus("P3 customerType", withType.status, 400);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (row.email !== emailFrozen) throw new Error("P3: email mutated despite forbidden field");
  });

  await run("P4 company/VAT", async () => {
    const companyOnly = await call(server, "PATCH", "/v1/me/profile", {
      bearer: access,
      json: { companyName: "Acme GmbH", vatId: null },
    });
    assertStatus("P4 company only", companyOnly.status, 200);
    const b1 = companyOnly.body as MeBody;
    if (b1.companyName !== "Acme GmbH") throw new Error("P4: companyName missing");
    if (b1.vatId !== null && b1.vatId !== undefined) {
      throw new Error(`P4: vatId should be null, got ${String(b1.vatId)}`);
    }

    const withVat = await call(server, "PATCH", "/v1/me/profile", {
      bearer: access,
      json: { companyName: "Acme GmbH", vatId: "DE123456789" },
    });
    assertStatus("P4 company+VAT", withVat.status, 200);
    const b2 = withVat.body as MeBody;
    if (b2.companyName !== "Acme GmbH" || b2.vatId !== "DE123456789") {
      throw new Error(`P4: company+VAT mismatch ${JSON.stringify(b2)}`);
    }

    const clear = await call(server, "PATCH", "/v1/me/profile", {
      bearer: access,
      json: { companyName: null, vatId: null },
    });
    assertStatus("P4 clear", clear.status, 200);
    const b3 = clear.body as MeBody;
    if (b3.companyName != null || b3.vatId != null) {
      throw new Error(`P4: clear failed ${JSON.stringify(b3)}`);
    }
  });

  await run("P5 independent fields", async () => {
    const res = await call(server, "PATCH", "/v1/me/profile", {
      bearer: access,
      json: { vatId: "DE987654321", companyName: null },
    });
    assertStatus("P5", res.status, 200);
    const body = res.body as MeBody;
    if (body.vatId !== "DE987654321") throw new Error(`P5: vatId=${String(body.vatId)}`);
    if (body.companyName != null) throw new Error(`P5: companyName should be null`);
  });

  await run("P6 invalid DE VAT", async () => {
    const res = await call(server, "PATCH", "/v1/me/profile", {
      bearer: access,
      json: { vatId: "INVALID-VAT" },
    });
    assertStatus("P6", res.status, 400);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (row.vatId !== "DE987654321") throw new Error("P6: vatId changed on invalid input");
  });

  await run("P7 profile.update audit", async () => {
    const before = await prisma.auditLog.count({
      where: { action: "profile.update", entityId: userId },
    });
    const res = await call(server, "PATCH", "/v1/me/profile", {
      bearer: access,
      json: { name: "Audit Probe" },
    });
    assertStatus("P7 patch", res.status, 200);
    const after = await prisma.auditLog.count({
      where: { action: "profile.update", entityId: userId },
    });
    if (after !== before + 1) {
      throw new Error(`P7: expected +1 profile.update (${before} → ${after})`);
    }
  });

  await run("P8 User-only mutation boundary", async () => {
    const order = await prisma.order.create({
      data: {
        orderNumber: `U8-${stamp}`,
        userId,
        status: "PLACED",
        currencyCode: "EUR",
        locale: "de",
        shippingCountryCode: "DE",
        companyIsKleinunternehmer: true,
        itemsSubtotal: 10,
        shippingTotal: 0,
        grandTotal: 10,
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: 0,
        shippingAddressJson: { line1: "snapshot-ship" },
        billingAddressJson: { line1: "snapshot-bill", name: "Frozen Buyer" },
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
            invoiceNumber: `INV-U8-${stamp}`,
            grandTotalSnapshot: 10,
            buyerSnapshotJson: { email: emailFrozen, name: "Frozen Buyer" },
            sellerSnapshotJson: { name: "Shop" },
          },
        },
      },
      include: { invoices: true },
    });
    const invoiceId = order.invoices[0]!.id;
    const beforeOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const beforeInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const beforeOrderJson = JSON.stringify(beforeOrder);
    const beforeInvoiceJson = JSON.stringify(beforeInvoice);

    const res = await call(server, "PATCH", "/v1/me/profile", {
      bearer: access,
      json: {
        name: "Post-Order Name",
        locale: "ar",
        companyName: "New Co",
        vatId: "DE111111111",
      },
    });
    assertStatus("P8 profile", res.status, 200);
    const me = res.body as MeBody;
    if (me.name !== "Post-Order Name" || me.locale !== "ar") {
      throw new Error("P8: User profile did not update");
    }

    const afterOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const afterInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (JSON.stringify(afterOrder) !== beforeOrderJson) {
      throw new Error("P8: Order row mutated by profile PATCH");
    }
    if (JSON.stringify(afterInvoice) !== beforeInvoiceJson) {
      throw new Error("P8: Invoice row mutated by profile PATCH");
    }
    if (afterOrder.locale !== "de") {
      throw new Error("P8: Order.locale snapshot changed");
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
