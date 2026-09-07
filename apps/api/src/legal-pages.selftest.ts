/**
 * Public GET /v1/legal/pages/:slug — current PUBLISHED only.
 *
 * Requires: DATABASE_URL
 * Run: pnpm --filter @dodo/api test:legal-pages
 *
 *   LP1 — published impressum → 200, allowlisted fields only
 *   LP2 — draft-only slug → 404, no draft leak
 *   LP3 — no current PUBLISHED impressum → 404
 *   LP4 — Admin/internal fields never in 200 body
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

const IMPRESSUM_PATH = "/v1/legal/pages/impressum";
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
  const ids = ["LP1", "LP2", "LP3", "LP4"] as const;

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

  const impressumSnapshot = await prisma.legalPage.findMany({
    where: { slug: "impressum", countryCode: "DE" },
  });
  const createdIds: string[] = [];

  const restoreImpressum = async () => {
    if (createdIds.length > 0) {
      await prisma.legalPage.deleteMany({ where: { id: { in: createdIds } } });
      createdIds.length = 0;
    }
    const current = await prisma.legalPage.findMany({
      where: { slug: "impressum", countryCode: "DE" },
    });
    const keep = new Set(impressumSnapshot.map((r) => r.id));
    const extras = current.filter((r) => !keep.has(r.id));
    if (extras.length > 0) {
      await prisma.legalPage.deleteMany({ where: { id: { in: extras.map((r) => r.id) } } });
    }
    for (const row of impressumSnapshot) {
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
    await run("LP1", async () => {
      const published = impressumSnapshot.find((r) => r.publishedAt != null && r.supersededAt == null);
      if (!published) {
        const created = await prisma.legalPage.create({
          data: {
            slug: "impressum",
            countryCode: "DE",
            version: `lp1-${stamp}`,
            title: "Impressum",
            body: `LP1 published body ${stamp}`,
            publishedAt: new Date(),
            publishNote: "must-not-leak-lp1",
          },
        });
        createdIds.push(created.id);
      }
      const res = await call(server, "GET", IMPRESSUM_PATH);
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecord(res.body);
      for (const key of PUBLIC_LEGAL_PAGE_FIELDS) {
        if (body[key] == null || (typeof body[key] === "string" && body[key] === "")) {
          throw new Error(`missing ${key}`);
        }
      }
      if (typeof body.publishedAt !== "string" || Number.isNaN(Date.parse(body.publishedAt))) {
        throw new Error("publishedAt must be ISO date string");
      }
      if (body.slug !== "impressum") throw new Error("slug");
      for (const key of Object.keys(body)) {
        if (!ALLOWED.has(key)) throw new Error(`unexpected key ${key}`);
      }
      for (const key of FORBIDDEN) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
          throw new Error(`forbidden key ${key}`);
        }
      }
    });

    await run("LP2", async () => {
      const slug = `lp-draft-${stamp}`;
      const secret = `DRAFT-SECRET-${stamp}`;
      const created = await prisma.legalPage.create({
        data: {
          slug,
          countryCode: "DE",
          version: "v1",
          title: "Draft only",
          body: secret,
          publishedAt: null,
          publishNote: "draft-note-internal",
          consentMigrationPolicy: { kind: "NO_ACTION", determinedByActorId: "actor-1" },
        },
      });
      try {
        const res = await call(server, "GET", `/v1/legal/pages/${slug}`);
        if (res.status !== 404) throw new Error(`status ${res.status}`);
        const dumped = JSON.stringify(res.body);
        if (dumped.includes(secret)) throw new Error("draft body leaked");
        if (dumped.includes("draft-note-internal")) throw new Error("publishNote leaked");
        if (dumped.includes("actor-1")) throw new Error("actor leaked");
      } finally {
        await prisma.legalPage.delete({ where: { id: created.id } });
      }
    });

    await run("LP3", async () => {
      await prisma.legalPage.updateMany({
        where: { slug: "impressum", countryCode: "DE", supersededAt: null, publishedAt: { not: null } },
        data: { supersededAt: new Date() },
      });
      const draft = await prisma.legalPage.create({
        data: {
          slug: "impressum",
          countryCode: "DE",
          version: `lp3-draft-${stamp}`,
          title: "Draft Impressum",
          body: `LP3-DRAFT-SECRET-${stamp}`,
          publishedAt: null,
          publishNote: "lp3-internal",
        },
      });
      createdIds.push(draft.id);
      try {
        const res = await call(server, "GET", IMPRESSUM_PATH);
        if (res.status !== 404) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
        const dumped = JSON.stringify(res.body);
        if (dumped.includes(`LP3-DRAFT-SECRET-${stamp}`)) throw new Error("draft impressum leaked");
        if (dumped.includes("lp3-internal")) throw new Error("publishNote leaked");
      } finally {
        await restoreImpressum();
      }
    });

    await run("LP4", async () => {
      await restoreImpressum();
      const created = await prisma.legalPage.create({
        data: {
          slug: "impressum",
          countryCode: "DE",
          version: `lp4-${stamp}`,
          title: "Impressum",
          body: "LP4 public body",
          publishedAt: new Date(),
          publishNote: "OWNER-ONLY-NOTE",
          consentMigrationPolicy: { kind: "NO_ACTION", determinedByActorId: "admin-lp4" },
          contentHash: "hash-must-not-appear",
        },
      });
      createdIds.push(created.id);
      await prisma.legalPage.updateMany({
        where: {
          slug: "impressum",
          countryCode: "DE",
          id: { not: created.id },
          supersededAt: null,
        },
        data: { supersededAt: new Date() },
      });
      try {
        const res = await call(server, "GET", IMPRESSUM_PATH);
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const body = asRecord(res.body);
        for (const key of FORBIDDEN) {
          if (Object.prototype.hasOwnProperty.call(body, key)) {
            throw new Error(`forbidden key ${key}`);
          }
        }
        const dumped = JSON.stringify(body);
        if (dumped.includes("OWNER-ONLY-NOTE")) throw new Error("publishNote value leaked");
        if (dumped.includes("admin-lp4")) throw new Error("actor leaked");
        if (dumped.includes("hash-must-not-appear")) throw new Error("contentHash leaked");
        if (dumped.includes("consentMigrationPolicy")) throw new Error("policy leaked");
        if (body.body !== "LP4 public body") throw new Error("body");
        if (Object.keys(body).some((k) => !ALLOWED.has(k))) {
          throw new Error(`extra keys ${Object.keys(body).join(",")}`);
        }
      } finally {
        await restoreImpressum();
      }
    });
  } finally {
    await restoreImpressum().catch(() => undefined);
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nGET /v1/legal/pages/:slug: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nGET /v1/legal/pages/:slug: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
