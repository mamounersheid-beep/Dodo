/**
 * Homepage Sections V1 B′ — focused verification (11 §1b / 12 §12.4a).
 *
 * Requires: DATABASE_URL + JWT secrets + migrated HomeSection* + seed sections
 * Run (after build): node dist/home.selftest.js
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
import { HomeTestAppModule } from "./home-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { hashPassword } from "./auth/crypto.util";
import {
  HOME_SECTION_PRODUCTS_AUDIT,
  HOME_SECTION_UPDATE_AUDIT,
} from "./home/home.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

const PUBLIC = "/v1/store/home";
const ADMIN = "/v1/admin/home/sections";
const PICKS = "/v1/admin/home/sections/store_picks/products";

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
  opts?: { bearer?: string; json?: unknown; headers?: Record<string, string> },
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
          ...(opts?.headers ?? {}),
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

async function ensureSections(prisma: PrismaService): Promise<void> {
  const defs = [
    {
      key: "new_arrivals",
      type: "rule",
      sortOrder: 0,
      names: { de: "Neu eingetroffen", en: "New arrivals", ar: "وصل حديثاً" },
    },
    {
      key: "store_picks",
      type: "manual",
      sortOrder: 1,
      names: { de: "Unsere Auswahl", en: "Store picks", ar: "مختارات المتجر" },
    },
  ] as const;
  for (const def of defs) {
    const existing = await prisma.homeSection.findUnique({ where: { key: def.key } });
    if (!existing) {
      await prisma.homeSection.create({
        data: {
          key: def.key,
          type: def.type,
          enabled: true,
          sortOrder: def.sortOrder,
          itemLimit: 8,
          translations: {
            create: [
              { locale: "de", name: def.names.de },
              { locale: "en", name: def.names.en },
              { locale: "ar", name: def.names.ar },
            ],
          },
        },
      });
    }
  }
}

async function main(): Promise<void> {
  console.log("Focused Verification — Homepage Sections V1\n");
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = [
    "HS1",
    "HS2",
    "HS3",
    "HS4",
    "HS5",
    "HS6",
    "HS7",
    "HS8",
    "HS9",
    "HS10",
    "HS11",
    "HS12",
    "HS13",
    "HS14",
    "HS15",
    "HS16",
    "HS17",
    "HS18",
    "HS19",
    "HS20",
  ] as const;

  const run = async (id: (typeof ids)[number], fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ id, status: "PASS" });
      console.log(`  ✓ ${id}`);
    } catch (e) {
      results.push({
        id,
        status: "FAIL",
        note: e instanceof Error ? e.message : String(e),
      });
      console.error(`  ✗ ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const app = await NestFactory.create(HomeTestAppModule, { logger: false });
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
  const createdProductIds: string[] = [];
  let categoryId: string | null = null;
  let brandId: string | null = null;
  let origArrivals: { enabled: boolean; sortOrder: number; itemLimit: number } | null = null;
  let origPicks: { enabled: boolean; sortOrder: number; itemLimit: number } | null = null;

  const staffUser = async (code: RoleCode): Promise<{ bearer: string; userId: string }> => {
    const role = await prisma.role.findUniqueOrThrow({ where: { code } });
    const user = await prisma.user.create({
      data: {
        email: `hs_${code}_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
        passwordHash: await hashPassword("HsPass1!"),
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

  const makeProduct = async (opts: {
    slug: string;
    name: string;
    active: boolean;
    variantActive: boolean;
    createdAt?: Date;
  }) => {
    if (!categoryId) {
      const cat = await prisma.category.create({
        data: {
          slug: `hs-cat-${stamp}`,
          name: "HS Cat",
          path: `/hs-cat-${stamp}`,
          depth: 0,
          sortOrder: 0,
          isActive: true,
        },
      });
      categoryId = cat.id;
    }
    if (!brandId) {
      const brand = await prisma.brand.create({
        data: { slug: `hs-brand-${stamp}`, name: "HS Brand" },
      });
      brandId = brand.id;
    }
    const product = await prisma.product.create({
      data: {
        slug: opts.slug,
        name: opts.name,
        description: "hs test",
        categoryId: categoryId!,
        brandId: brandId!,
        isActive: opts.active,
        createdAt: opts.createdAt ?? new Date(),
        variants: {
          create: {
            sku: `HS-SKU-${opts.slug}`,
            name: "One",
            price: 19.9,
            weightGrams: 100,
            isActive: opts.variantActive,
          },
        },
        translations: {
          create: [
            { locale: "de", name: `${opts.name} DE`, description: "de" },
            { locale: "en", name: `${opts.name} EN`, description: "en" },
            { locale: "ar", name: `${opts.name} AR`, description: "ar" },
          ],
        },
      },
    });
    createdProductIds.push(product.id);
    return product;
  };

  try {
    await ensureSections(prisma);

    const admin = await staffUser(RoleCode.ADMIN);
    const owner = await staffUser(RoleCode.OWNER);
    const support = await staffUser(RoleCode.SUPPORT);

    const newestA = await makeProduct({
      slug: `hs-new-a-${stamp}`,
      name: "NewestA",
      active: true,
      variantActive: true,
      createdAt: new Date(Date.now() - 1000),
    });
    const newestB = await makeProduct({
      slug: `hs-new-b-${stamp}`,
      name: "NewestB",
      active: true,
      variantActive: true,
      createdAt: new Date(),
    });
    const inactive = await makeProduct({
      slug: `hs-inactive-${stamp}`,
      name: "Inactive",
      active: false,
      variantActive: true,
    });
    const pick1 = await makeProduct({
      slug: `hs-pick1-${stamp}`,
      name: "Pick1",
      active: true,
      variantActive: true,
    });
    const pick2 = await makeProduct({
      slug: `hs-pick2-${stamp}`,
      name: "Pick2",
      active: true,
      variantActive: true,
    });
    const pick3 = await makeProduct({
      slug: `hs-pick3-${stamp}`,
      name: "Pick3",
      active: true,
      variantActive: true,
    });

    const arrivals = await prisma.homeSection.findUniqueOrThrow({ where: { key: "new_arrivals" } });
    const picks = await prisma.homeSection.findUniqueOrThrow({ where: { key: "store_picks" } });

    origArrivals = {
      enabled: arrivals.enabled,
      sortOrder: arrivals.sortOrder,
      itemLimit: arrivals.itemLimit,
    };
    origPicks = {
      enabled: picks.enabled,
      sortOrder: picks.sortOrder,
      itemLimit: picks.itemLimit,
    };

    await prisma.homeSection.update({
      where: { id: arrivals.id },
      data: { enabled: true, sortOrder: 0, itemLimit: 8 },
    });
    await prisma.homeSection.update({
      where: { id: picks.id },
      data: { enabled: true, sortOrder: 1, itemLimit: 8 },
    });
    await prisma.homeSectionProduct.deleteMany({ where: { sectionId: picks.id } });
    await prisma.homeSectionProduct.createMany({
      data: [
        { sectionId: picks.id, productId: pick1.id, sortOrder: 0 },
        { sectionId: picks.id, productId: inactive.id, sortOrder: 1 },
        { sectionId: picks.id, productId: pick2.id, sortOrder: 2 },
      ],
    });

    await run("HS1", async () => {
      const res = await call(server, "GET", PUBLIC);
      if (res.status !== 200) throw new Error(`expected 200 got ${res.status}`);
      const body = res.body as { sections: Array<{ key: string }> };
      if (!Array.isArray(body.sections)) throw new Error("sections missing");
      if (body.sections.some((s) => s.key !== "new_arrivals" && s.key !== "store_picks")) {
        throw new Error("unexpected section key");
      }
    });

    await run("HS2", async () => {
      await prisma.homeSection.update({ where: { id: arrivals.id }, data: { enabled: false } });
      const res = await call(server, "GET", PUBLIC);
      const keys = (res.body as { sections: Array<{ key: string }> }).sections.map((s) => s.key);
      if (keys.includes("new_arrivals")) throw new Error("disabled section leaked");
      if (!keys.includes("store_picks")) throw new Error("store_picks missing");
      await prisma.homeSection.update({ where: { id: arrivals.id }, data: { enabled: true } });
    });

    await run("HS3", async () => {
      await prisma.homeSection.update({ where: { id: arrivals.id }, data: { sortOrder: 5 } });
      await prisma.homeSection.update({ where: { id: picks.id }, data: { sortOrder: 1 } });
      const res = await call(server, "GET", PUBLIC);
      const keys = (res.body as { sections: Array<{ key: string }> }).sections.map((s) => s.key);
      if (keys[0] !== "store_picks" || keys[1] !== "new_arrivals") {
        throw new Error(`order wrong: ${keys.join(",")}`);
      }
      await prisma.homeSection.update({ where: { id: arrivals.id }, data: { sortOrder: 0 } });
      await prisma.homeSection.update({ where: { id: picks.id }, data: { sortOrder: 1 } });
    });

    await run("HS4", async () => {
      await prisma.homeSection.update({
        where: { id: arrivals.id },
        data: { sortOrder: 1 },
      });
      await prisma.homeSection.update({
        where: { id: picks.id },
        data: { sortOrder: 1 },
      });
      const res = await call(server, "GET", PUBLIC);
      const keys = (res.body as { sections: Array<{ key: string }> }).sections.map((s) => s.key);
      if (keys[0] !== "new_arrivals" || keys[1] !== "store_picks") {
        throw new Error(`tie-break failed: ${keys.join(",")}`);
      }
      await prisma.homeSection.update({ where: { id: arrivals.id }, data: { sortOrder: 0 } });
    });

    await run("HS5", async () => {
      await prisma.homeSection.update({ where: { id: arrivals.id }, data: { itemLimit: 1 } });
      const home = await call(server, "GET", PUBLIC);
      const section = (
        home.body as { sections: Array<{ key: string; products: Array<{ id: string }> }> }
      ).sections.find((s) => s.key === "new_arrivals")!;
      if (section.products.length !== 1) throw new Error(`limit ${section.products.length}`);
      const catalog = await call(server, "GET", "/v1/catalog/products?sort=newest&pageSize=1");
      const catFirst = (catalog.body as { items: Array<{ id: string }> }).items[0]?.id;
      if (!catFirst) throw new Error("catalog newest empty");
      if (catFirst !== section.products[0].id) {
        throw new Error(`newest diverged from catalog: home=${section.products[0].id} cat=${catFirst}`);
      }
      await prisma.homeSection.update({ where: { id: arrivals.id }, data: { itemLimit: 8 } });
    });

    await run("HS6", async () => {
      const res = await call(server, "GET", PUBLIC);
      const section = (
        res.body as {
          sections: Array<{ key: string; products: Array<{ id: string }> }>;
        }
      ).sections.find((s) => s.key === "store_picks")!;
      const idsOrder = section.products.map((p) => p.id);
      if (idsOrder.includes(inactive.id)) throw new Error("non-sellable leaked");
      if (idsOrder[0] !== pick1.id || idsOrder[1] !== pick2.id) {
        throw new Error(`order/skip failed: ${idsOrder.join(",")}`);
      }
      if (idsOrder.length !== 2) throw new Error("unexpected backfill or count");
    });

    await run("HS7", async () => {
      await prisma.homeSectionProduct.deleteMany({ where: { sectionId: picks.id } });
      const res = await call(server, "GET", PUBLIC);
      const section = (
        res.body as { sections: Array<{ key: string; products: unknown[] }> }
      ).sections.find((s) => s.key === "store_picks");
      if (!section) throw new Error("enabled empty section omitted");
      if (!Array.isArray(section.products) || section.products.length !== 0) {
        throw new Error("expected products: []");
      }
    });

    await run("HS8", async () => {
      const de = await call(server, "GET", `${PUBLIC}?locale=de`);
      const en = await call(server, "GET", `${PUBLIC}?locale=en`);
      const ar = await call(server, "GET", PUBLIC, { headers: { "Accept-Language": "ar" } });
      const fr = await call(server, "GET", `${PUBLIC}?locale=fr`);
      const name = (body: unknown, key: string) =>
        (body as { sections: Array<{ key: string; name: string }> }).sections.find((s) => s.key === key)
          ?.name;
      if (name(de.body, "new_arrivals") !== "Neu eingetroffen") throw new Error("de name");
      if (name(en.body, "new_arrivals") !== "New arrivals") throw new Error("en name");
      if (name(ar.body, "new_arrivals") !== "وصل حديثاً") throw new Error("ar name");
      if (name(fr.body, "new_arrivals") !== "Neu eingetroffen") throw new Error("fallback de");
    });

    await run("HS9", async () => {
      await prisma.homeSectionProduct.deleteMany({ where: { sectionId: picks.id } });
      await prisma.homeSectionProduct.createMany({
        data: [
          { sectionId: picks.id, productId: pick1.id, sortOrder: 0 },
          { sectionId: picks.id, productId: pick2.id, sortOrder: 1 },
        ],
      });
      const res = await call(server, "GET", `${PUBLIC}?locale=en`);
      const card = (
        res.body as {
          sections: Array<{
            key: string;
            products: Array<Record<string, unknown>>;
          }>;
        }
      ).sections.find((s) => s.key === "store_picks")!.products[0];
      for (const k of ["id", "slug", "name", "brand", "category", "primaryImageUrl", "sellable", "priceFrom"]) {
        if (!(k in card)) throw new Error(`card missing ${k}`);
      }
      if (card.sellable !== true) throw new Error("sellable not true");
      if (typeof card.name !== "string" || !String(card.name).includes("EN")) {
        throw new Error("product locale not applied");
      }
    });

    await run("HS10", async () => {
      const res = await call(server, "GET", ADMIN, { bearer: support.bearer });
      if (res.status !== 403 || errCode(res.body) !== "FORBIDDEN") {
        throw new Error(`SUPPORT expected 403 FORBIDDEN got ${res.status} ${errCode(res.body)}`);
      }
    });

    await run("HS11", async () => {
      const a = await call(server, "GET", ADMIN, { bearer: admin.bearer });
      const o = await call(server, "GET", ADMIN, { bearer: owner.bearer });
      if (a.status !== 200 || o.status !== 200) throw new Error("ADMIN/OWNER GET failed");
      if (!Array.isArray(a.body) || (a.body as unknown[]).length !== 2) {
        throw new Error("expected 2 sections");
      }
    });

    await run("HS12", async () => {
      const res = await call(server, "GET", `${ADMIN}/does_not_exist`, { bearer: admin.bearer });
      if (res.status !== 404 || errCode(res.body) !== "NOT_FOUND") {
        throw new Error(`expected 404 NOT_FOUND got ${res.status} ${errCode(res.body)}`);
      }
    });

    await run("HS13", async () => {
      const bad = await call(server, "PATCH", `${ADMIN}/new_arrivals`, {
        bearer: admin.bearer,
        json: { itemLimit: 0 },
      });
      if (bad.status !== 400) {
        throw new Error(`itemLimit 0 expected 400 got ${bad.status} code=${errCode(bad.body)}`);
      }
      const bad2 = await call(server, "PATCH", `${ADMIN}/new_arrivals`, {
        bearer: admin.bearer,
        json: { itemLimit: 25 },
      });
      if (bad2.status !== 400) throw new Error(`itemLimit 25 expected 400 got ${bad2.status}`);
    });

    await run("HS14", async () => {
      const res = await call(server, "PUT", PICKS, {
        bearer: admin.bearer,
        json: { productIds: [pick1.id, pick1.id] },
      });
      if (res.status !== 400 || errCode(res.body) !== "VALIDATION_ERROR") {
        throw new Error(`duplicate expected 400 got ${res.status}`);
      }
    });

    await run("HS15", async () => {
      const empty = await call(server, "PATCH", `${ADMIN}/store_picks`, {
        bearer: admin.bearer,
        json: { names: { en: "   " } },
      });
      if (empty.status !== 400) throw new Error("empty name expected 400");
      const badLoc = await call(server, "PATCH", `${ADMIN}/store_picks`, {
        bearer: admin.bearer,
        json: { names: { fr: "Bonjour" } },
      });
      if (badLoc.status !== 400) throw new Error("fr locale expected 400");
    });

    await run("HS16", async () => {
      const before = await prisma.auditLog.count({
        where: { action: HOME_SECTION_PRODUCTS_AUDIT, entityId: picks.id },
      });
      const res = await call(server, "PUT", PICKS, {
        bearer: admin.bearer,
        json: { productIds: [pick3.id, pick1.id, pick2.id] },
      });
      if (res.status !== 200) throw new Error(`PUT failed ${res.status}`);
      const body = res.body as { productIds: string[] };
      if (body.productIds.join(",") !== [pick3.id, pick1.id, pick2.id].join(",")) {
        throw new Error("replace order wrong");
      }
      const after = await prisma.auditLog.count({
        where: { action: HOME_SECTION_PRODUCTS_AUDIT, entityId: picks.id },
      });
      if (after !== before + 1) throw new Error("expected products.replace audit");
      const pub = await call(server, "GET", PUBLIC);
      const order = (
        pub.body as { sections: Array<{ key: string; products: Array<{ id: string }> }> }
      ).sections
        .find((s) => s.key === "store_picks")!
        .products.map((p) => p.id);
      if (order[0] !== pick3.id || order[1] !== pick1.id || order[2] !== pick2.id) {
        throw new Error(`public order ${order.join(",")}`);
      }
    });

    await run("HS17", async () => {
      const before = await prisma.auditLog.count({
        where: { action: HOME_SECTION_UPDATE_AUDIT, entityId: arrivals.id, actorId: admin.userId },
      });
      const current = await call(server, "GET", `${ADMIN}/new_arrivals`, { bearer: admin.bearer });
      const cur = current.body as { enabled: boolean; itemLimit: number };
      const noop = await call(server, "PATCH", `${ADMIN}/new_arrivals`, {
        bearer: admin.bearer,
        json: { itemLimit: cur.itemLimit, enabled: cur.enabled },
      });
      if (noop.status !== 200) throw new Error("noop patch failed");
      const mid = await prisma.auditLog.count({
        where: { action: HOME_SECTION_UPDATE_AUDIT, entityId: arrivals.id, actorId: admin.userId },
      });
      if (mid !== before) throw new Error("noop must not audit");
      const mut = await call(server, "PATCH", `${ADMIN}/new_arrivals`, {
        bearer: admin.bearer,
        json: { names: { en: "Arrivals EN edited" } },
      });
      if (mut.status !== 200) throw new Error(`mut patch ${mut.status}`);
      const after = await prisma.auditLog.count({
        where: { action: HOME_SECTION_UPDATE_AUDIT, entityId: arrivals.id, actorId: admin.userId },
      });
      if (after !== before + 1) throw new Error("expected update audit");
      await prisma.homeSectionTranslation.update({
        where: { sectionId_locale: { sectionId: arrivals.id, locale: "en" } },
        data: { name: "New arrivals" },
      });
    });

    await run("HS18", async () => {
      const unauth = await call(server, "GET", ADMIN);
      if (unauth.status !== 401) throw new Error(`expected 401 got ${unauth.status}`);
    });

    await run("HS19", async () => {
      const missing = await call(server, "PUT", PICKS, {
        bearer: admin.bearer,
        json: { productIds: ["does-not-exist-product"] },
      });
      if (missing.status !== 400 || errCode(missing.body) !== "VALIDATION_ERROR") {
        throw new Error("missing productId expected 400");
      }
    });

    await run("HS20", async () => {
      const idBody = await call(server, "GET", "/v1/store/identity").catch(() => null);
      // identity may be absent in this narrow module — ensure /home has no identity fields
      const home = await call(server, "GET", PUBLIC);
      const body = home.body as Record<string, unknown>;
      if ("legalName" in body || "logoUrl" in body) throw new Error("identity leaked into /home");
      if (!("sections" in body)) throw new Error("sections missing");
      void newestA;
      void newestB;
    });
  } finally {
    try {
      await prisma.homeSectionProduct.deleteMany({
        where: { productId: { in: createdProductIds } },
      });
      for (const id of createdProductIds) {
        await prisma.productTranslation.deleteMany({ where: { productId: id } });
        await prisma.productVariant.deleteMany({ where: { productId: id } });
        await prisma.product.delete({ where: { id } }).catch(() => undefined);
      }
      if (brandId) await prisma.brand.delete({ where: { id: brandId } }).catch(() => undefined);
      if (categoryId) await prisma.category.delete({ where: { id: categoryId } }).catch(() => undefined);
      await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { action: HOME_SECTION_UPDATE_AUDIT },
            { action: HOME_SECTION_PRODUCTS_AUDIT },
          ],
          actorId: { in: createdUserIds },
        },
      });
      const arrivalsRow = await prisma.homeSection.findUnique({ where: { key: "new_arrivals" } });
      const picksSec = await prisma.homeSection.findUnique({ where: { key: "store_picks" } });
      if (arrivalsRow && origArrivals) {
        await prisma.homeSection.update({
          where: { id: arrivalsRow.id },
          data: {
            enabled: origArrivals.enabled,
            sortOrder: origArrivals.sortOrder,
            itemLimit: origArrivals.itemLimit,
          },
        });
        await prisma.homeSectionTranslation.update({
          where: { sectionId_locale: { sectionId: arrivalsRow.id, locale: "en" } },
          data: { name: "New arrivals" },
        });
      }
      if (picksSec && origPicks) {
        await prisma.homeSectionProduct.deleteMany({ where: { sectionId: picksSec.id } });
        await prisma.homeSection.update({
          where: { id: picksSec.id },
          data: {
            enabled: origPicks.enabled,
            sortOrder: origPicks.sortOrder,
            itemLimit: origPicks.itemLimit,
          },
        });
      }
    } catch {
      /* best-effort cleanup */
    }
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status === "FAIL").length;
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
