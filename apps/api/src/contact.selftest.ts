/**
 * Public POST /v1/contact — 10.10 §6.
 *
 * Requires: DATABASE_URL
 * Run: pnpm --filter @dodo/api test:contact
 *
 *   CT1 — guest 202, generic body, enqueue to live supportEmail
 *   CT2 — empty supportEmail → 202, no enqueue
 *   CT3 — registered + unowned orderNumber → 400, no order leak
 *   CT4 — guest + orderNumber → 202, no order data
 *   CT5 — body userId rejected; audit has no message
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { BadRequestException } from "@nestjs/common";
import { ContactTestAppModule, contactEnqueueCapture } from "./contact-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { COMPANY_SETTINGS_ID } from "./company-settings/company-settings.service";
import { CONTACT_AUDIT_ACTION } from "./contact/contact.constants";
import { ContactService } from "./contact/contact.service";
import type { AuthUser } from "./auth/auth.types";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

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

function asRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new Error(`expected object body, got ${JSON.stringify(body)}`);
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = ["CT1", "CT2", "CT3", "CT4", "CT5"] as const;

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

  const app = await NestFactory.create(ContactTestAppModule, { logger: false });
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

  const settingsBefore = await prisma.companySettings.findUnique({
    where: { id: COMPANY_SETTINGS_ID },
    select: { supportEmail: true },
  });
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  const restoreSupportEmail = async () => {
    await prisma.companySettings.update({
      where: { id: COMPANY_SETTINGS_ID },
      data: { supportEmail: settingsBefore?.supportEmail ?? null },
    });
  };

  try {
    await prisma.companySettings.update({
      where: { id: COMPANY_SETTINGS_ID },
      data: { supportEmail: `support-ct-${stamp}@example.com` },
    });

    await run("CT1", async () => {
      contactEnqueueCapture.length = 0;
      const secret = `SECRET-MSG-${stamp}`;
      const res = await call(server, "POST", "/v1/contact", {
        json: {
          name: "Gast",
          email: `gast-ct1-${stamp}@example.com`,
          subject: "general",
          message: secret,
        },
      });
      if (res.status !== 202) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecord(res.body);
      if (body.message !== "Accepted") throw new Error("generic message");
      if (JSON.stringify(body).includes(secret)) throw new Error("message leaked");
      if (JSON.stringify(body).includes("support-ct-")) throw new Error("supportEmail leaked");
      if ("orderNumber" in body || "userId" in body || "id" in body) {
        throw new Error("extra fields");
      }
      if (contactEnqueueCapture.length !== 1) throw new Error("expected one enqueue");
      const job = contactEnqueueCapture[0]!;
      if (job.to !== `support-ct-${stamp}@example.com`) throw new Error("dest not live supportEmail");
      if (job.message !== secret) throw new Error("queue should carry message");
    });

    await run("CT2", async () => {
      contactEnqueueCapture.length = 0;
      await prisma.companySettings.update({
        where: { id: COMPANY_SETTINGS_ID },
        data: { supportEmail: null },
      });
      try {
        const res = await call(server, "POST", "/v1/contact", {
          json: {
            name: "Gast",
            email: `gast-ct2-${stamp}@example.com`,
            subject: "shipping",
            message: "empty-dest",
          },
        });
        if (res.status !== 202) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
        if (contactEnqueueCapture.length !== 0) throw new Error("must not enqueue when supportEmail empty");
      } finally {
        await prisma.companySettings.update({
          where: { id: COMPANY_SETTINGS_ID },
          data: { supportEmail: `support-ct-${stamp}@example.com` },
        });
      }
    });

    await run("CT3", async () => {
      const email = `reg-ct3-${stamp}@example.com`;
      const user = await prisma.user.create({
        data: { email, name: "Reg", locale: "de" },
      });
      createdUserIds.push(user.id);
      const authUser: AuthUser = {
        id: user.id,
        email,
        name: "Reg",
        locale: "de",
        roles: [],
        anonymizedAt: null,
      };

      const other = await prisma.order.create({
        data: {
          orderNumber: `CT3-OTHER-${stamp}`,
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
          shippingAddressJson: { line1: "x" },
          billingAddressJson: { line1: "y" },
          sellerIdentitySnapshotJson: {
            legalName: "Other",
            line1: "x",
            postalCode: "10115",
            city: "Berlin",
            countryCode: "DE",
          },
        },
      });
      createdOrderIds.push(other.id);

      const svc = app.get(ContactService);
      let caught: unknown;
      try {
        await svc.submit(
          {
            name: "Reg",
            email,
            subject: "order",
            message: "claim",
            orderNumber: other.orderNumber,
          },
          authUser,
        );
      } catch (e) {
        caught = e;
      }
      if (!(caught instanceof BadRequestException)) {
        throw new Error(`expected 400 ownership, got ${String(caught)}`);
      }
      const dumped = JSON.stringify(caught.getResponse());
      if (dumped.includes(other.id)) throw new Error("order id leaked");
      if (dumped.includes("guestAccessToken")) throw new Error("tracking leaked");
    });

    await run("CT4", async () => {
      contactEnqueueCapture.length = 0;
      const res = await call(server, "POST", "/v1/contact", {
        json: {
          name: "Gast",
          email: `gast-ct4-${stamp}@example.com`,
          subject: "order",
          message: "guest-order-text",
          orderNumber: "ANY-TEXT-123",
        },
      });
      if (res.status !== 202) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecord(res.body);
      if ("items" in body || "tracking" in body || "order" in body) {
        throw new Error("order payload returned");
      }
      if (contactEnqueueCapture.length !== 1) throw new Error("enqueue");
      if (contactEnqueueCapture[0]?.orderNumber !== "ANY-TEXT-123") {
        throw new Error("orderNumber should be staff text");
      }
    });

    await run("CT5", async () => {
      contactEnqueueCapture.length = 0;
      const res = await call(server, "POST", "/v1/contact", {
        json: {
          name: "Gast",
          email: `gast-ct5-${stamp}@example.com`,
          subject: "account",
          message: "AUDIT-SECRET-TEXT",
          userId: "forged-user-id",
        },
      });
      if (res.status !== 202) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      if (contactEnqueueCapture[0]?.userId) throw new Error("body userId must not bind");
      const logs = await prisma.auditLog.findMany({
        where: { action: CONTACT_AUDIT_ACTION },
        orderBy: { createdAt: "desc" },
        take: 5,
      });
      const dumped = JSON.stringify(logs);
      if (dumped.includes("AUDIT-SECRET-TEXT")) throw new Error("message stored in audit");
      if (dumped.includes("forged-user-id")) throw new Error("forged userId audited");
      const latest = logs[0];
      if (!latest) throw new Error("missing audit");
      if (latest.action !== CONTACT_AUDIT_ACTION) throw new Error("action");
    });
  } finally {
    await restoreSupportEmail().catch(() => undefined);
    if (createdOrderIds.length > 0) {
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => undefined);
    }
    if (createdUserIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } }).catch(() => undefined);
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
    }
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nPOST /v1/contact: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nPOST /v1/contact: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
