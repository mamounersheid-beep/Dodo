/**
 * Public GET /v1/legal/pages/widerruf — current PUBLISHED only (existing contract).
 *
 * Requires: DATABASE_URL
 * Run: pnpm --filter @dodo/api test:legal-pages-widerruf
 *
 *   LP-WR1 — published widerruf → 200, allowlisted fields only
 *   LP-WR2 — draft-only / no current PUBLISHED → 404, no draft leak
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { LegalPagesTestAppModule } from "./legal-pages-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { Prisma } from "@dodo/database";
import { PrismaService } from "./prisma/prisma.service";
import { PUBLIC_LEGAL_PAGE_FIELDS } from "./cms-legal/cms-legal.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

const WR_PATH = "/v1/legal/pages/widerruf";
const ALLOWED = new Set<string>(PUBLIC_LEGAL_PAGE_FIELDS);
const FORBIDDEN = [
  "id",
  "publishNote",
  "consentMigrationPolicy",
  "supersededAt",
  "contentHash",
  "countryCode",
  "determinedByActorId",
  "determinedAt",
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

async function main(): Promise<void> {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = ["LP-WR1", "LP-WR2"] as const;

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

  const app = await NestFactory.create(LegalPagesTestAppModule, { logger: false });
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

  const snapshot = await prisma.legalPage.findMany({
    where: { slug: "widerruf", countryCode: "DE" },
  });
  const createdIds: string[] = [];

  const restore = async () => {
    if (createdIds.length > 0) {
      await prisma.legalPage.deleteMany({ where: { id: { in: createdIds } } });
      createdIds.length = 0;
    }
    const current = await prisma.legalPage.findMany({
      where: { slug: "widerruf", countryCode: "DE" },
    });
    const keep = new Set(snapshot.map((r) => r.id));
    const extras = current.filter((r) => !keep.has(r.id));
    if (extras.length > 0) {
      await prisma.legalPage.deleteMany({ where: { id: { in: extras.map((r) => r.id) } } });
    }
    for (const row of snapshot) {
      await prisma.legalPage.update({
        where: { id: row.id },
        data: {
          title: row.title,
          body: row.body,
          publishedAt: row.publishedAt,
          supersededAt: row.supersededAt,
          publishNote: row.publishNote,
          consentMigrationPolicy:
            row.consentMigrationPolicy === null
              ? Prisma.DbNull
              : (row.consentMigrationPolicy as Prisma.InputJsonValue),
          contentHash: row.contentHash,
        },
      });
    }
  };

  try {
    await run("LP-WR1", async () => {
      const published = snapshot.find((r) => r.publishedAt != null && r.supersededAt == null);
      if (!published) {
        const created = await prisma.legalPage.create({
          data: {
            slug: "widerruf",
            countryCode: "DE",
            version: `wr1-${stamp}`,
            title: "Widerrufsbelehrung",
            body: `LP-WR1 published body ${stamp}`,
            publishedAt: new Date(),
            publishNote: "must-not-leak-wr1",
          },
        });
        createdIds.push(created.id);
      }
      const res = await call(server, "GET", WR_PATH);
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecord(res.body);
      if (body.slug !== "widerruf") throw new Error("slug");
      for (const key of PUBLIC_LEGAL_PAGE_FIELDS) {
        if (body[key] == null || body[key] === "") throw new Error(`missing ${key}`);
      }
      for (const key of Object.keys(body)) {
        if (!ALLOWED.has(key)) throw new Error(`unexpected key ${key}`);
      }
      for (const key of FORBIDDEN) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
          throw new Error(`forbidden key ${key}`);
        }
      }
    });

    await run("LP-WR2", async () => {
      await prisma.legalPage.updateMany({
        where: { slug: "widerruf", countryCode: "DE", supersededAt: null, publishedAt: { not: null } },
        data: { supersededAt: new Date() },
      });
      const secret = `WR-DRAFT-SECRET-${stamp}`;
      const draft = await prisma.legalPage.create({
        data: {
          slug: "widerruf",
          countryCode: "DE",
          version: `wr2-draft-${stamp}`,
          title: "Widerruf Draft",
          body: secret,
          publishedAt: null,
          publishNote: "wr2-internal",
        },
      });
      createdIds.push(draft.id);
      try {
        const res = await call(server, "GET", WR_PATH);
        if (res.status !== 404) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
        const dumped = JSON.stringify(res.body);
        if (dumped.includes(secret)) throw new Error("draft body leaked");
        if (dumped.includes("wr2-internal")) throw new Error("publishNote leaked");
      } finally {
        await restore();
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
      `\nGET /v1/legal/pages/widerruf: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nGET /v1/legal/pages/widerruf: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
