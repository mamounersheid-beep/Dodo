/**
 * Execute Admin §12.9 — PATCH /v1/admin/shipping-rates/:id transit days.
 *
 * Requires: DATABASE_URL (+ seeded Role + at least one ShippingRate)
 * Run (after build): node dist/shipping.admin-transit.selftest.js
 *
 * Scenarios:
 *   ST1  — ADMIN can update min/max
 *   ST2  — OWNER can update min/max
 *   ST3  — SUPPORT → 403, no write
 *   ST4  — missing/null/extra/float/negative/string → 400, no write
 *   ST5  — unknown id → 404
 *   ST6  — 0 is accepted
 *   ST7  — min == max accepted
 *   ST8  — min > max → 400
 *   ST9  — success body exact keys
 *   ST10 — actual change creates expected AuditLog
 *   ST11 — same-value 200, no new audit
 *   ST12 — both fields updated atomically
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
import { AdminShippingTransitTestAppModule } from "./shipping.admin-transit-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

const TRANSIT_ACTION = "shipping.rate.estimated_transit_days.update";
const RESPONSE_KEYS = ["id", "estimatedTransitDaysMin", "estimatedTransitDaysMax"] as const;

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

function asTransit(body: unknown): {
  id: string;
  estimatedTransitDaysMin: number;
  estimatedTransitDaysMax: number;
} {
  return body as {
    id: string;
    estimatedTransitDaysMin: number;
    estimatedTransitDaysMax: number;
  };
}

function assertShape(body: unknown, rateId: string): void {
  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const expected = [...RESPONSE_KEYS].sort();
  if (keys.join(",") !== expected.join(",")) {
    throw new Error(`shape keys ${JSON.stringify(keys)}`);
  }
  const dt = asTransit(body);
  if (dt.id !== rateId) throw new Error("id mismatch");
  if (!Number.isInteger(dt.estimatedTransitDaysMin) || !Number.isInteger(dt.estimatedTransitDaysMax)) {
    throw new Error("response days must be integers");
  }
  if (
    Object.prototype.hasOwnProperty.call(obj, "deliveryTime") ||
    Object.prototype.hasOwnProperty.call(obj, "labelShown") ||
    Object.prototype.hasOwnProperty.call(obj, "orderProcessingDaysMin")
  ) {
    throw new Error("forbidden extra preview/processing fields");
  }
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = [
    "ST1",
    "ST2",
    "ST3",
    "ST4",
    "ST5",
    "ST6",
    "ST7",
    "ST8",
    "ST9",
    "ST10",
    "ST11",
    "ST12",
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

  const app = await NestFactory.create(AdminShippingTransitTestAppModule, { logger: false });
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
  const createdAuditIds: string[] = [];
  let rateId = "";
  let origMin = 0;
  let origMax = 0;

  const patch = (id: string, bearer: string | undefined, json: unknown) =>
    call(server, "PATCH", `/v1/admin/shipping-rates/${id}`, { bearer, json });

  const staffUser = async (code: RoleCode): Promise<{ bearer: string; userId: string }> => {
    const role = await prisma.role.findUniqueOrThrow({ where: { code } });
    const user = await prisma.user.create({
      data: {
        email: `st12_9_${code}_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
        passwordHash: `hash_${randomBytes(8).toString("hex")}`,
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

  const readRate = () =>
    prisma.shippingRate.findUniqueOrThrow({
      where: { id: rateId },
      select: { estimatedTransitDaysMin: true, estimatedTransitDaysMax: true },
    });

  const setRate = (min: number, max: number) =>
    prisma.shippingRate.update({
      where: { id: rateId },
      data: { estimatedTransitDaysMin: min, estimatedTransitDaysMax: max },
    });

  const auditCount = () =>
    prisma.auditLog.count({
      where: { action: TRANSIT_ACTION, entityType: "ShippingRate", entityId: rateId },
    });

  try {
    const rate = await prisma.shippingRate.findFirst();
    if (!rate) throw new Error("ShippingRate row required — seed");
    rateId = rate.id;
    origMin = rate.estimatedTransitDaysMin;
    origMax = rate.estimatedTransitDaysMax;

    const admin = await staffUser(RoleCode.ADMIN);
    const owner = await staffUser(RoleCode.OWNER);
    const support = await staffUser(RoleCode.SUPPORT);

    await run("ST1", async () => {
      await setRate(2, 4);
      const res = await patch(rateId, admin.bearer, {
        estimatedTransitDaysMin: 3,
        estimatedTransitDaysMax: 6,
      });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asTransit(res.body);
      if (body.estimatedTransitDaysMin !== 3 || body.estimatedTransitDaysMax !== 6) {
        throw new Error("ADMIN write not reflected");
      }
      const row = await readRate();
      if (row.estimatedTransitDaysMin !== 3 || row.estimatedTransitDaysMax !== 6) {
        throw new Error("ADMIN DB mismatch");
      }
    });

    await run("ST2", async () => {
      await setRate(2, 4);
      const res = await patch(rateId, owner.bearer, {
        estimatedTransitDaysMin: 1,
        estimatedTransitDaysMax: 5,
      });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const row = await readRate();
      if (row.estimatedTransitDaysMin !== 1 || row.estimatedTransitDaysMax !== 5) {
        throw new Error("OWNER DB mismatch");
      }
    });

    await run("ST3", async () => {
      await setRate(2, 4);
      const before = await readRate();
      const auditsBefore = await auditCount();
      const res = await patch(rateId, support.bearer, {
        estimatedTransitDaysMin: 9,
        estimatedTransitDaysMax: 12,
      });
      if (res.status !== 403) throw new Error(`expected 403 got ${res.status}`);
      if (errCode(res.body) !== "FORBIDDEN") throw new Error(`code=${errCode(res.body)}`);
      const after = await readRate();
      if (
        after.estimatedTransitDaysMin !== before.estimatedTransitDaysMin ||
        after.estimatedTransitDaysMax !== before.estimatedTransitDaysMax
      ) {
        throw new Error("SUPPORT must not write");
      }
      if ((await auditCount()) !== auditsBefore) throw new Error("SUPPORT must not audit");
    });

    await run("ST4", async () => {
      await setRate(2, 4);
      const before = await readRate();
      const auditsBefore = await auditCount();
      const cases: Array<{ label: string; json: unknown }> = [
        { label: "missing min", json: { estimatedTransitDaysMax: 4 } },
        { label: "missing max", json: { estimatedTransitDaysMin: 2 } },
        { label: "empty", json: {} },
        { label: "null min", json: { estimatedTransitDaysMin: null, estimatedTransitDaysMax: 4 } },
        { label: "null max", json: { estimatedTransitDaysMin: 2, estimatedTransitDaysMax: null } },
        {
          label: "extra",
          json: { estimatedTransitDaysMin: 2, estimatedTransitDaysMax: 4, price: 1 },
        },
        { label: "float", json: { estimatedTransitDaysMin: 1.5, estimatedTransitDaysMax: 4 } },
        { label: "negative", json: { estimatedTransitDaysMin: -1, estimatedTransitDaysMax: 4 } },
        { label: "string", json: { estimatedTransitDaysMin: "2", estimatedTransitDaysMax: 4 } },
      ];
      for (const c of cases) {
        const res = await patch(rateId, admin.bearer, c.json);
        if (res.status !== 400) {
          throw new Error(`${c.label}: expected 400 got ${res.status} ${JSON.stringify(res.body)}`);
        }
        const after = await readRate();
        if (
          after.estimatedTransitDaysMin !== before.estimatedTransitDaysMin ||
          after.estimatedTransitDaysMax !== before.estimatedTransitDaysMax
        ) {
          throw new Error(`${c.label}: wrote on 400`);
        }
      }
      if ((await auditCount()) !== auditsBefore) throw new Error("400 must not audit");
    });

    await run("ST5", async () => {
      const auditsBefore = await prisma.auditLog.count({
        where: { action: TRANSIT_ACTION, entityType: "ShippingRate" },
      });
      const res = await patch("nonexistent_shipping_rate_id", admin.bearer, {
        estimatedTransitDaysMin: 2,
        estimatedTransitDaysMax: 4,
      });
      if (res.status !== 404) throw new Error(`expected 404 got ${res.status}`);
      if (errCode(res.body) !== "NOT_FOUND") throw new Error(`code=${errCode(res.body)}`);
      const auditsAfter = await prisma.auditLog.count({
        where: { action: TRANSIT_ACTION, entityType: "ShippingRate" },
      });
      if (auditsAfter !== auditsBefore) throw new Error("404 must not audit");
    });

    await run("ST6", async () => {
      await setRate(2, 4);
      const res = await patch(rateId, admin.bearer, {
        estimatedTransitDaysMin: 0,
        estimatedTransitDaysMax: 0,
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = asTransit(res.body);
      if (body.estimatedTransitDaysMin !== 0 || body.estimatedTransitDaysMax !== 0) {
        throw new Error("0 not accepted");
      }
    });

    await run("ST7", async () => {
      await setRate(2, 4);
      const res = await patch(rateId, admin.bearer, {
        estimatedTransitDaysMin: 4,
        estimatedTransitDaysMax: 4,
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const row = await readRate();
      if (row.estimatedTransitDaysMin !== 4 || row.estimatedTransitDaysMax !== 4) {
        throw new Error("min==max not persisted");
      }
    });

    await run("ST8", async () => {
      await setRate(2, 4);
      const before = await readRate();
      const res = await patch(rateId, admin.bearer, {
        estimatedTransitDaysMin: 9,
        estimatedTransitDaysMax: 1,
      });
      if (res.status !== 400) throw new Error(`expected 400 got ${res.status}`);
      const after = await readRate();
      if (
        after.estimatedTransitDaysMin !== before.estimatedTransitDaysMin ||
        after.estimatedTransitDaysMax !== before.estimatedTransitDaysMax
      ) {
        throw new Error("min>max wrote");
      }
    });

    await run("ST9", async () => {
      await setRate(2, 4);
      const res = await patch(rateId, admin.bearer, {
        estimatedTransitDaysMin: 5,
        estimatedTransitDaysMax: 8,
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      assertShape(res.body, rateId);
      const body = asTransit(res.body);
      if (body.estimatedTransitDaysMin !== 5 || body.estimatedTransitDaysMax !== 8) {
        throw new Error("shape values");
      }
    });

    await run("ST10", async () => {
      await setRate(2, 4);
      const res = await patch(rateId, admin.bearer, {
        estimatedTransitDaysMin: 7,
        estimatedTransitDaysMax: 10,
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const logs = await prisma.auditLog.findMany({
        where: {
          action: TRANSIT_ACTION,
          entityType: "ShippingRate",
          entityId: rateId,
          actorId: admin.userId,
        },
        orderBy: { createdAt: "desc" },
        take: 1,
      });
      if (logs.length !== 1) throw new Error(`expected 1 audit got ${logs.length}`);
      const log = logs[0];
      createdAuditIds.push(log.id);
      if (log.actorType !== "ADMIN") throw new Error(`actorType ${log.actorType}`);
      if (log.actorId !== admin.userId) throw new Error("actorId");
      if (log.action !== TRANSIT_ACTION) throw new Error("action");
      if (log.entityType !== "ShippingRate") throw new Error("entityType");
      if (log.entityId !== rateId) throw new Error("entityId");
      const before = log.beforeJson as { estimatedTransitDaysMin: number; estimatedTransitDaysMax: number };
      const after = log.afterJson as { estimatedTransitDaysMin: number; estimatedTransitDaysMax: number };
      if (before.estimatedTransitDaysMin !== 2 || before.estimatedTransitDaysMax !== 4) {
        throw new Error(`beforeJson ${JSON.stringify(before)}`);
      }
      if (after.estimatedTransitDaysMin !== 7 || after.estimatedTransitDaysMax !== 10) {
        throw new Error(`afterJson ${JSON.stringify(after)}`);
      }
      const beforeKeys = Object.keys(before).sort().join(",");
      const afterKeys = Object.keys(after).sort().join(",");
      if (beforeKeys !== "estimatedTransitDaysMax,estimatedTransitDaysMin") {
        throw new Error(`before keys ${beforeKeys}`);
      }
      if (afterKeys !== "estimatedTransitDaysMax,estimatedTransitDaysMin") {
        throw new Error(`after keys ${afterKeys}`);
      }
    });

    await run("ST11", async () => {
      await setRate(3, 6);
      const auditsBefore = await auditCount();
      const res = await patch(rateId, admin.bearer, {
        estimatedTransitDaysMin: 3,
        estimatedTransitDaysMax: 6,
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      assertShape(res.body, rateId);
      const body = asTransit(res.body);
      if (body.estimatedTransitDaysMin !== 3 || body.estimatedTransitDaysMax !== 6) {
        throw new Error("same-value body");
      }
      if ((await auditCount()) !== auditsBefore) throw new Error("same-value must not audit");
    });

    await run("ST12", async () => {
      await setRate(2, 4);
      const res = await patch(rateId, admin.bearer, {
        estimatedTransitDaysMin: 8,
        estimatedTransitDaysMax: 11,
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const row = await readRate();
      if (row.estimatedTransitDaysMin !== 8 || row.estimatedTransitDaysMax !== 11) {
        throw new Error("pair not updated together");
      }
    });
  } finally {
    if (rateId) {
      await prisma.shippingRate
        .update({
          where: { id: rateId },
          data: { estimatedTransitDaysMin: origMin, estimatedTransitDaysMax: origMax },
        })
        .catch(() => undefined);
    }
    await prisma.auditLog
      .deleteMany({
        where: {
          action: TRANSIT_ACTION,
          entityType: "ShippingRate",
          ...(createdUserIds.length ? { actorId: { in: createdUserIds } } : { id: { in: createdAuditIds } }),
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
    console.log(`\nAdmin §12.9 transit: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`);
    process.exit(1);
  }
  console.log(`\nAdmin §12.9 transit: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
