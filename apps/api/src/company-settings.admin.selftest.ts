/**
 * Execute Admin §12.18b — CompanySettings GET/PATCH.
 *
 * Requires: DATABASE_URL (+ seeded Role + CompanySettings id=default)
 * Run (after build): node dist/company-settings.admin.selftest.js
 *
 * Scenarios:
 *   CS1  — ADMIN GET 200
 *   CS2  — OWNER GET 200
 *   CS3  — SUPPORT GET 403
 *   CS4  — unauthenticated GET 401
 *   CS5  — OWNER PATCH identity 200 + AuditLog before/after
 *   CS6  — ADMIN PATCH 403, no write
 *   CS7  — SUPPORT PATCH 403, no write
 *   CS8  — OWNER wrong password 401, no write, no audit
 *   CS9  — OWNER missing confirmed 400
 *   CS10 — OWNER empty legalName 400
 *   CS11 — invoiceNextNumber in body 400, counters unchanged
 *   CS12 — defaultCurrencyCode in body 400
 *   CS13 — checkoutEnabled in body 400 (W9 EM not this slice)
 *   CS14 — same-value PATCH 200, no new audit
 *   CS15 — successful PATCH does not change counters
 *   CS16 — OWNER can set logoObjectKey (live only)
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import { RoleCode } from "@dodo/shared-types";
import { CompanySettingsAdminTestAppModule } from "./company-settings.admin-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { hashPassword } from "./auth/crypto.util";
import {
  COMPANY_SETTINGS_AUDIT_ACTION,
  COMPANY_SETTINGS_ID,
} from "./company-settings/company-settings.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

const OWNER_PASSWORD = "OwnerPass1!";
const PATH = "/v1/admin/company-settings";

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
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
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function errCode(body: unknown): string | undefined {
  return (body as { code?: string })?.code;
}

function asSettings(body: unknown): Record<string, unknown> {
  return body as Record<string, unknown>;
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = [
    "CS1",
    "CS2",
    "CS3",
    "CS4",
    "CS5",
    "CS6",
    "CS7",
    "CS8",
    "CS9",
    "CS10",
    "CS11",
    "CS12",
    "CS13",
    "CS14",
    "CS15",
    "CS16",
  ] as const;

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

  const app = await NestFactory.create(CompanySettingsAdminTestAppModule, { logger: false });
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
  const jwt = app.get(JwtService);

  const createdUserIds: string[] = [];
  const orig = await prisma.companySettings.findUnique({ where: { id: COMPANY_SETTINGS_ID } });
  if (!orig) throw new Error("CompanySettings default row required — seed");
  const origLegalName = orig.legalName;
  const origLogo = orig.logoObjectKey;
  const origInvoiceNext = orig.invoiceNextNumber;
  const origOrderNext = orig.orderNextNumber;

  const get = (bearer?: string) => call(server, "GET", PATH, { bearer });
  const patch = (bearer: string | undefined, json: unknown) =>
    call(server, "PATCH", PATH, { bearer, json });

  const staffUser = async (
    code: RoleCode,
    password?: string,
  ): Promise<{ bearer: string; userId: string }> => {
    const role = await prisma.role.findUniqueOrThrow({ where: { code } });
    const user = await prisma.user.create({
      data: {
        email: `cs1218b_${code}_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
        passwordHash: password ? await hashPassword(password) : `hash_${randomBytes(8).toString("hex")}`,
        locale: "de",
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: randomBytes(16).toString("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const bearer = await jwt.signAsync({ sub: user.id, sid: session.id, roles: [code] });
    return { bearer, userId: user.id };
  };

  const readRow = () => prisma.companySettings.findUniqueOrThrow({ where: { id: COMPANY_SETTINGS_ID } });

  const auditCount = (actorId?: string) =>
    prisma.auditLog.count({
      where: {
        action: COMPANY_SETTINGS_AUDIT_ACTION,
        entityType: "CompanySettings",
        entityId: COMPANY_SETTINGS_ID,
        ...(actorId ? { actorId } : {}),
      },
    });

  const ownerWrite = (bearer: string, fields: Record<string, unknown>) =>
    patch(bearer, { confirmed: true, currentPassword: OWNER_PASSWORD, ...fields });

  try {
    const admin = await staffUser(RoleCode.ADMIN);
    const owner = await staffUser(RoleCode.OWNER, OWNER_PASSWORD);
    const support = await staffUser(RoleCode.SUPPORT);

    await run("CS1", async () => {
      const res = await get(admin.bearer);
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asSettings(res.body);
      if (body.id !== COMPANY_SETTINGS_ID) throw new Error("id");
      if (typeof body.legalName !== "string") throw new Error("legalName");
      if (typeof body.invoiceNextNumber !== "number") throw new Error("invoiceNextNumber readable");
      if (body.defaultCurrencyCode !== "EUR") throw new Error("EUR");
    });

    await run("CS2", async () => {
      const res = await get(owner.bearer);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      if (asSettings(res.body).id !== COMPANY_SETTINGS_ID) throw new Error("id");
    });

    await run("CS3", async () => {
      const res = await get(support.bearer);
      if (res.status !== 403) throw new Error(`expected 403 got ${res.status}`);
      if (errCode(res.body) !== "FORBIDDEN") throw new Error(`code=${errCode(res.body)}`);
    });

    await run("CS4", async () => {
      const res = await get();
      if (res.status !== 401) throw new Error(`expected 401 got ${res.status}`);
      if (errCode(res.body) !== "UNAUTHORIZED") throw new Error(`code=${errCode(res.body)}`);
    });

    await run("CS5", async () => {
      const nextName = `CS5 Firma ${stamp}`;
      const beforeRow = await readRow();
      const res = await ownerWrite(owner.bearer, { legalName: nextName });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asSettings(res.body);
      if (body.legalName !== nextName) throw new Error("legalName not returned");
      const row = await readRow();
      if (row.legalName !== nextName) throw new Error("legalName not persisted");
      const logs = await prisma.auditLog.findMany({
        where: {
          action: COMPANY_SETTINGS_AUDIT_ACTION,
          entityType: "CompanySettings",
          entityId: COMPANY_SETTINGS_ID,
          actorId: owner.userId,
        },
        orderBy: { createdAt: "desc" },
        take: 1,
      });
      if (logs.length !== 1) throw new Error(`expected 1 audit got ${logs.length}`);
      const log = logs[0];
      if (log.actorType !== "ADMIN") throw new Error(`actorType ${log.actorType}`);
      const beforeJson = log.beforeJson as { legalName: string };
      const afterJson = log.afterJson as { legalName: string };
      if (beforeJson.legalName !== beforeRow.legalName) throw new Error("beforeJson.legalName");
      if (afterJson.legalName !== nextName) throw new Error("afterJson.legalName");
      if (!Object.prototype.hasOwnProperty.call(beforeJson, "logoObjectKey")) {
        throw new Error("beforeJson must include writable projection");
      }
    });

    await run("CS6", async () => {
      const before = await readRow();
      const auditsBefore = await auditCount();
      const res = await patch(admin.bearer, {
        confirmed: true,
        currentPassword: OWNER_PASSWORD,
        legalName: "ADMIN MUST NOT WRITE",
      });
      if (res.status !== 403) throw new Error(`expected 403 got ${res.status}`);
      if (errCode(res.body) !== "FORBIDDEN") throw new Error(`code=${errCode(res.body)}`);
      const after = await readRow();
      if (after.legalName !== before.legalName) throw new Error("ADMIN wrote");
      if ((await auditCount()) !== auditsBefore) throw new Error("ADMIN must not audit");
    });

    await run("CS7", async () => {
      const before = await readRow();
      const res = await patch(support.bearer, {
        confirmed: true,
        currentPassword: OWNER_PASSWORD,
        legalName: "SUPPORT MUST NOT WRITE",
      });
      if (res.status !== 403) throw new Error(`expected 403 got ${res.status}`);
      const after = await readRow();
      if (after.legalName !== before.legalName) throw new Error("SUPPORT wrote");
    });

    await run("CS8", async () => {
      const before = await readRow();
      const auditsBefore = await auditCount(owner.userId);
      const res = await patch(owner.bearer, {
        confirmed: true,
        currentPassword: "WrongPass1!",
        legalName: "MUST NOT APPLY",
      });
      if (res.status !== 401) throw new Error(`expected 401 got ${res.status} ${JSON.stringify(res.body)}`);
      if (errCode(res.body) !== "UNAUTHORIZED") throw new Error(`code=${errCode(res.body)}`);
      const after = await readRow();
      if (after.legalName !== before.legalName) throw new Error("wrote on bad re-auth");
      if ((await auditCount(owner.userId)) !== auditsBefore) throw new Error("audit on bad re-auth");
    });

    await run("CS9", async () => {
      const before = await readRow();
      const res = await patch(owner.bearer, {
        currentPassword: OWNER_PASSWORD,
        legalName: "NO CONFIRM",
      });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
      const after = await readRow();
      if (after.legalName !== before.legalName) throw new Error("wrote without confirmed");
    });

    await run("CS10", async () => {
      const before = await readRow();
      const res = await ownerWrite(owner.bearer, { legalName: "   " });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status} ${JSON.stringify(res.body)}`);
      const after = await readRow();
      if (after.legalName !== before.legalName) throw new Error("empty legalName wrote");
    });

    await run("CS11", async () => {
      const before = await readRow();
      const res = await ownerWrite(owner.bearer, {
        legalName: before.legalName,
        invoiceNextNumber: before.invoiceNextNumber + 50,
      });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
      const after = await readRow();
      if (after.invoiceNextNumber !== before.invoiceNextNumber) throw new Error("counter mutated");
    });

    await run("CS12", async () => {
      const before = await readRow();
      const res = await ownerWrite(owner.bearer, { defaultCurrencyCode: "USD" });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
      const after = await readRow();
      if (after.defaultCurrencyCode !== "EUR") throw new Error("EUR unlocked");
      if (after.legalName !== before.legalName) throw new Error("side write");
    });

    await run("CS13", async () => {
      const before = await readRow();
      const res = await ownerWrite(owner.bearer, { checkoutEnabled: false });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
      const after = await readRow();
      if (after.checkoutEnabled !== before.checkoutEnabled) throw new Error("flag wrote");
    });

    await run("CS14", async () => {
      const row = await readRow();
      const auditsBefore = await auditCount(owner.userId);
      const res = await ownerWrite(owner.bearer, { legalName: row.legalName });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      if (asSettings(res.body).legalName !== row.legalName) throw new Error("same-value body");
      if ((await auditCount(owner.userId)) !== auditsBefore) throw new Error("same-value audited");
    });

    await run("CS15", async () => {
      const before = await readRow();
      const res = await ownerWrite(owner.bearer, { legalName: `CS15 ${stamp}` });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const after = await readRow();
      if (after.invoiceNextNumber !== before.invoiceNextNumber) throw new Error("invoiceNextNumber changed");
      if (after.orderNextNumber !== before.orderNextNumber) throw new Error("orderNextNumber changed");
      if (after.defaultCurrencyCode !== "EUR") throw new Error("currency changed");
    });

    await run("CS16", async () => {
      const key = `logos/cs16-${stamp}.png`;
      const res = await ownerWrite(owner.bearer, { logoObjectKey: key });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      if (asSettings(res.body).logoObjectKey !== key) throw new Error("logo not returned");
      const row = await readRow();
      if (row.logoObjectKey !== key) throw new Error("logo not persisted");
    });
  } finally {
    await prisma.auditLog
      .deleteMany({
        where: {
          action: COMPANY_SETTINGS_AUDIT_ACTION,
          entityType: "CompanySettings",
          ...(createdUserIds.length ? { actorId: { in: createdUserIds } } : {}),
        },
      })
      .catch(() => undefined);
    await prisma.companySettings
      .update({
        where: { id: COMPANY_SETTINGS_ID },
        data: {
          legalName: origLegalName,
          logoObjectKey: origLogo,
          invoiceNextNumber: origInvoiceNext,
          orderNextNumber: origOrderNext,
        },
      })
      .catch(() => undefined);
    if (createdUserIds.length) {
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
      await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
    }
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nAdmin §12.18b CompanySettings: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nAdmin §12.18b CompanySettings: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
