/**
 * Execute §12.18b — GET /v1/store/identity (MC-1 / MC-2).
 *
 * Requires: DATABASE_URL (+ seeded CompanySettings id=default)
 * Run (after build): node dist/store-identity.selftest.js
 *
 * Scenarios:
 *   SI1 — guest GET 200 (no JWT)
 *   SI2 — required fields present; body is flat
 *   SI3 — empty/null optionals omitted
 *   SI4 — logoObjectKey never in body
 *   SI5 — logoUrl when logoObjectKey set
 *   SI6 — live CompanySettings values
 *   SI7 — GET /v1/store/status unchanged; identity has no #7 fields
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { StoreIdentityTestAppModule } from "./store-identity-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { COMPANY_SETTINGS_ID } from "./company-settings/company-settings.service";
import { toPublicObjectUrl } from "./catalog/public-object-url";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

const PATH = "/v1/store/identity";
const STATUS_PATH = "/v1/store/status";

const REQUIRED = ["legalName", "line1", "postalCode", "city", "countryCode"] as const;
const OPTIONAL = [
  "supportEmail",
  "supportPhone",
  "logoUrl",
  "steuernummer",
  "vatId",
  "kleinunternehmerId",
] as const;
const FORBIDDEN = [
  "address",
  "data",
  "updatedAt",
  "id",
  "logoObjectKey",
  "checkoutEnabled",
  "maintenance",
  "maintenanceMode",
  "payments",
  "paymentsEnabled",
  "couponsEnabled",
  "bonusPlusEnabled",
  "isKleinunternehmer",
  "invoiceExemptionText",
  "kleinunternehmerSince",
  "returnAddressName",
  "returnAddressLine1",
  "orderProcessingDaysMin",
  "defaultCurrencyCode",
  "defaultLocale",
  "invoiceNextNumber",
  "orderNextNumber",
] as const;

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function call(server: Server, method: string, path: string): Promise<HttpResult> {
  const addr = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: addr.port, path, method },
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
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new Error(`expected object body, got ${JSON.stringify(body)}`);
}

function assertNoForbidden(body: Record<string, unknown>): void {
  for (const key of FORBIDDEN) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      throw new Error(`forbidden key present: ${key}`);
    }
  }
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = ["SI1", "SI2", "SI3", "SI4", "SI5", "SI6", "SI7"] as const;

  const run = async (id: (typeof ids)[number], fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ id, status: "PASS" });
    } catch (e) {
      results.push({
        id,
        status: "FAIL",
        note: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const app = await NestFactory.create(StoreIdentityTestAppModule, { logger: false });
  app.setGlobalPrefix("v1");
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0);
  const server = app.getHttpServer() as Server;
  const prisma = app.get(PrismaService);

  const orig = await prisma.companySettings.findUnique({ where: { id: COMPANY_SETTINGS_ID } });
  if (!orig) throw new Error("CompanySettings default row required — seed");

  const restore = async () => {
    await prisma.companySettings.update({
      where: { id: COMPANY_SETTINGS_ID },
      data: {
        legalName: orig.legalName,
        line1: orig.line1,
        postalCode: orig.postalCode,
        city: orig.city,
        countryCode: orig.countryCode,
        supportEmail: orig.supportEmail,
        supportPhone: orig.supportPhone,
        logoObjectKey: orig.logoObjectKey,
        steuernummer: orig.steuernummer,
        vatId: orig.vatId,
        kleinunternehmerId: orig.kleinunternehmerId,
      },
    });
  };

  try {
    await run("SI1", async () => {
      const res = await call(server, "GET", PATH);
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
    });

    await run("SI2", async () => {
      const res = await call(server, "GET", PATH);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecord(res.body);
      for (const key of REQUIRED) {
        if (typeof body[key] !== "string" || (body[key] as string).length === 0) {
          throw new Error(`required ${key}`);
        }
      }
      const allowed = new Set<string>([...REQUIRED, ...OPTIONAL]);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new Error(`unexpected key ${key}`);
      }
      assertNoForbidden(body);
    });

    await run("SI3", async () => {
      await prisma.companySettings.update({
        where: { id: COMPANY_SETTINGS_ID },
        data: {
          supportEmail: null,
          supportPhone: null,
          logoObjectKey: null,
          steuernummer: null,
          vatId: null,
          kleinunternehmerId: null,
        },
      });
      const res = await call(server, "GET", PATH);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecord(res.body);
      for (const key of OPTIONAL) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
          throw new Error(`optional ${key} should be omitted`);
        }
      }
      for (const key of REQUIRED) {
        if (typeof body[key] !== "string") throw new Error(`required ${key} missing`);
      }
      await restore();
    });

    await run("SI4", async () => {
      await prisma.companySettings.update({
        where: { id: COMPANY_SETTINGS_ID },
        data: { logoObjectKey: `identity-logo-${stamp}.png` },
      });
      const res = await call(server, "GET", PATH);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecord(res.body);
      if (Object.prototype.hasOwnProperty.call(body, "logoObjectKey")) {
        throw new Error("logoObjectKey exposed");
      }
      const dumped = JSON.stringify(body);
      if (dumped.includes("logoObjectKey")) throw new Error("logoObjectKey in JSON");
      await restore();
    });

    await run("SI5", async () => {
      const key = `identity-logo-${stamp}.png`;
      await prisma.companySettings.update({
        where: { id: COMPANY_SETTINGS_ID },
        data: { logoObjectKey: key },
      });
      const res = await call(server, "GET", PATH);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecord(res.body);
      if (body.logoUrl !== toPublicObjectUrl(key)) {
        throw new Error(`logoUrl=${String(body.logoUrl)} expected ${toPublicObjectUrl(key)}`);
      }
      if (typeof body.logoUrl !== "string" || !body.logoUrl.includes(key)) {
        throw new Error("logoUrl must include object key");
      }
      if (body.logoUrl === key) throw new Error("logoUrl must not be raw objectKey");
      await restore();
    });

    await run("SI6", async () => {
      const liveName = `SI6 Firma ${stamp}`;
      const liveLine = `SI6 Line ${stamp}`;
      await prisma.companySettings.update({
        where: { id: COMPANY_SETTINGS_ID },
        data: { legalName: liveName, line1: liveLine },
      });
      const res = await call(server, "GET", PATH);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asRecord(res.body);
      if (body.legalName !== liveName) throw new Error("legalName not live");
      if (body.line1 !== liveLine) throw new Error("line1 not live");
      await restore();
    });

    await run("SI7", async () => {
      const before = await call(server, "GET", STATUS_PATH);
      const identity = await call(server, "GET", PATH);
      if (identity.status !== 200) throw new Error(`identity ${identity.status}`);
      const body = asRecord(identity.body);
      assertNoForbidden(body);
      if (before.status !== 404) {
        throw new Error(`store/status expected unchanged 404, got ${before.status}`);
      }
    });
  } finally {
    await restore().catch(() => undefined);
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nGET /v1/store/identity: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nGET /v1/store/identity: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
