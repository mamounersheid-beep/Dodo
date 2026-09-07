/**
 * Public GET /v1/legal/faq — current PUBLISHED `faq-*` DE only.
 *
 * Requires: DATABASE_URL
 * Run: pnpm --filter @dodo/api test:legal-pages-faq
 *
 *   FAQ1 — only current PUBLISHED faq-* DE rows
 *   FAQ2 — DRAFT / SUPERSEDED / non-FAQ / other-country excluded
 *   FAQ3 — each item allowlisted fields only
 *   FAQ4 — slug ASC
 *   FAQ5 — empty published set → 200 []
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
type LegalRow = Awaited<ReturnType<PrismaService["legalPage"]["findMany"]>>[number];

const FAQ_PATH = "/v1/legal/faq";
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

function asArray(body: unknown): Record<string, unknown>[] {
  if (!Array.isArray(body)) {
    throw new Error(`expected array body, got ${JSON.stringify(body)}`);
  }
  return body.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`item ${i} is not an object`);
    }
    return item as Record<string, unknown>;
  });
}

function assertItemAllowlist(item: Record<string, unknown>): void {
  for (const key of PUBLIC_LEGAL_PAGE_FIELDS) {
    if (item[key] == null || (typeof item[key] === "string" && item[key] === "")) {
      throw new Error(`missing ${key}`);
    }
  }
  if (typeof item.publishedAt !== "string" || Number.isNaN(Date.parse(item.publishedAt))) {
    throw new Error("publishedAt must be ISO date string");
  }
  for (const key of Object.keys(item)) {
    if (!ALLOWED.has(key)) throw new Error(`unexpected key ${key}`);
  }
  for (const key of FORBIDDEN) {
    if (Object.prototype.hasOwnProperty.call(item, key)) {
      throw new Error(`forbidden key ${key}`);
    }
  }
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = ["FAQ1", "FAQ2", "FAQ3", "FAQ4", "FAQ5"] as const;

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

  const faqSnapshot: LegalRow[] = await prisma.legalPage.findMany({
    where: { slug: { startsWith: "faq-" } },
  });
  const createdIds: string[] = [];

  const restoreFaq = async () => {
    if (createdIds.length > 0) {
      await prisma.legalPage.deleteMany({ where: { id: { in: createdIds } } });
      createdIds.length = 0;
    }
    const current = await prisma.legalPage.findMany({
      where: { slug: { startsWith: "faq-" } },
    });
    const keep = new Set(faqSnapshot.map((r) => r.id));
    const extras = current.filter((r) => !keep.has(r.id));
    if (extras.length > 0) {
      await prisma.legalPage.deleteMany({ where: { id: { in: extras.map((r) => r.id) } } });
    }
    for (const row of faqSnapshot) {
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

  const track = async (data: Prisma.LegalPageCreateInput) => {
    const created = await prisma.legalPage.create({ data });
    createdIds.push(created.id);
    return created;
  };

  try {
    await run("FAQ1", async () => {
      await restoreFaq();
      const live = await track({
        slug: `faq-live-${stamp}`,
        countryCode: "DE",
        version: `faq1-${stamp}`,
        title: "FAQ Live",
        body: `FAQ1 published body ${stamp}`,
        publishedAt: new Date(),
        publishNote: "must-not-leak-faq1",
      });
      const res = await call(server, "GET", FAQ_PATH);
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const items = asArray(res.body);
      if (items.length === 0) throw new Error("expected at least the live faq row");
      for (const item of items) {
        if (typeof item.slug !== "string" || !item.slug.startsWith("faq-")) {
          throw new Error(`non-faq slug ${String(item.slug)}`);
        }
        assertItemAllowlist(item);
      }
      const found = items.find((item) => item.slug === live.slug);
      if (!found) throw new Error("published faq-* missing");
      if (found.title !== "FAQ Live") throw new Error("title");
      if (found.body !== `FAQ1 published body ${stamp}`) throw new Error("body");
    });

    await run("FAQ2", async () => {
      await restoreFaq();
      const draftSecret = `DRAFT-FAQ-SECRET-${stamp}`;
      const supersededSecret = `SUPERSEDED-FAQ-SECRET-${stamp}`;
      const atSecret = `AT-FAQ-SECRET-${stamp}`;
      const bareFaqSecret = `BARE-FAQ-SECRET-${stamp}`;
      await track({
        slug: `faq-draft-${stamp}`,
        countryCode: "DE",
        version: "v1",
        title: "Draft FAQ",
        body: draftSecret,
        publishedAt: null,
        publishNote: "draft-note-internal",
        consentMigrationPolicy: { kind: "NO_ACTION", determinedByActorId: "actor-faq2" },
      });
      await track({
        slug: `faq-old-${stamp}`,
        countryCode: "DE",
        version: "v1",
        title: "Old FAQ",
        body: supersededSecret,
        publishedAt: new Date(),
        supersededAt: new Date(),
        publishNote: "superseded-note",
      });
      await track({
        slug: `faq-at-${stamp}`,
        countryCode: "AT",
        version: "v1",
        title: "AT FAQ",
        body: atSecret,
        publishedAt: new Date(),
      });
      await track({
        slug: `faq`,
        countryCode: "DE",
        version: `bare-${stamp}`,
        title: "Bare FAQ",
        body: bareFaqSecret,
        publishedAt: new Date(),
      });
      const live = await track({
        slug: `faq-keep-${stamp}`,
        countryCode: "DE",
        version: "v1",
        title: "Keep",
        body: "keep-published",
        publishedAt: new Date(),
      });

      const res = await call(server, "GET", FAQ_PATH);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const dumped = JSON.stringify(res.body);
      if (dumped.includes(draftSecret)) throw new Error("draft body leaked");
      if (dumped.includes("draft-note-internal")) throw new Error("publishNote leaked");
      if (dumped.includes("actor-faq2")) throw new Error("actor leaked");
      if (dumped.includes(supersededSecret)) throw new Error("superseded leaked");
      if (dumped.includes(atSecret)) throw new Error("other-country leaked");
      if (dumped.includes(bareFaqSecret)) throw new Error("non-prefix faq slug leaked");

      const items = asArray(res.body);
      const slugs = items.map((item) => item.slug);
      if (slugs.includes(`faq-draft-${stamp}`)) throw new Error("draft included");
      if (slugs.includes(`faq-old-${stamp}`)) throw new Error("superseded included");
      if (slugs.includes(`faq-at-${stamp}`)) throw new Error("AT included");
      if (slugs.includes("faq")) throw new Error("bare faq slug included");
      if (slugs.includes("impressum") || slugs.includes("agb") || slugs.includes("datenschutz") || slugs.includes("widerruf")) {
        throw new Error("closed legal slug included");
      }
      if (!slugs.includes(live.slug)) throw new Error("published faq-* missing");

      const single = await call(server, "GET", `/v1/legal/pages/faq-keep-${stamp}`);
      if (single.status !== 200) throw new Error(`single-slug status ${single.status}`);
      const listAsSlug = await call(server, "GET", "/v1/legal/pages/faq");
      if (listAsSlug.status === 200 && Array.isArray(listAsSlug.body)) {
        throw new Error("pages/:slug must not become a list");
      }
    });

    await run("FAQ3", async () => {
      await restoreFaq();
      await track({
        slug: `faq-fields-${stamp}`,
        countryCode: "DE",
        version: `faq3-${stamp}`,
        title: "Fields",
        body: "FAQ3 public body",
        publishedAt: new Date(),
        publishNote: "OWNER-ONLY-NOTE",
        consentMigrationPolicy: { kind: "NO_ACTION", determinedByActorId: "admin-faq3" },
        contentHash: "hash-must-not-appear",
      });
      const res = await call(server, "GET", FAQ_PATH);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const items = asArray(res.body);
      if (items.length === 0) throw new Error("expected items");
      const dumped = JSON.stringify(items);
      if (dumped.includes("OWNER-ONLY-NOTE")) throw new Error("publishNote value leaked");
      if (dumped.includes("admin-faq3")) throw new Error("actor leaked");
      if (dumped.includes("hash-must-not-appear")) throw new Error("contentHash leaked");
      if (dumped.includes("consentMigrationPolicy")) throw new Error("policy leaked");
      for (const item of items) {
        assertItemAllowlist(item);
      }
    });

    await run("FAQ4", async () => {
      await restoreFaq();
      await track({
        slug: `faq-zzz-${stamp}`,
        countryCode: "DE",
        version: "v1",
        title: "Z",
        body: "z-body",
        publishedAt: new Date(),
      });
      await track({
        slug: `faq-aaa-${stamp}`,
        countryCode: "DE",
        version: "v1",
        title: "A",
        body: "a-body",
        publishedAt: new Date(),
      });
      const res = await call(server, "GET", FAQ_PATH);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const items = asArray(res.body);
      const slugs = items.map((item) => String(item.slug));
      for (let i = 1; i < slugs.length; i += 1) {
        if (slugs[i - 1] > slugs[i]) {
          throw new Error(`not slug ASC: ${slugs[i - 1]} > ${slugs[i]}`);
        }
      }
      const aaa = slugs.indexOf(`faq-aaa-${stamp}`);
      const zzz = slugs.indexOf(`faq-zzz-${stamp}`);
      if (aaa < 0 || zzz < 0) throw new Error("ordered fixtures missing");
      if (aaa >= zzz) throw new Error("aaa must sort before zzz");
    });

    await run("FAQ5", async () => {
      await restoreFaq();
      await prisma.legalPage.updateMany({
        where: {
          slug: { startsWith: "faq-" },
          countryCode: "DE",
          publishedAt: { not: null },
          supersededAt: null,
        },
        data: { supersededAt: new Date() },
      });
      try {
        const res = await call(server, "GET", FAQ_PATH);
        if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
        if (!Array.isArray(res.body)) throw new Error("empty set must be an array");
        if (res.body.length !== 0) {
          throw new Error(`expected [], got ${JSON.stringify(res.body)}`);
        }
      } finally {
        await restoreFaq();
      }
    });
  } finally {
    await restoreFaq().catch(() => undefined);
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nGET /v1/legal/faq: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nGET /v1/legal/faq: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
