/**
 * Gate 10.4 — Postgres catalog list/search focused verification.
 *
 * Requires: DATABASE_URL + JWT secrets + seed (roles, MAIN, CompanySettings)
 * Run (after build): node dist/catalog.10.4.selftest.js
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { CatalogTestAppModule } from "./catalog-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";

type Result = { id: string; status: "PASS" | "FAIL"; note?: string };
type HttpResult = { status: number; body: unknown };
type Card = { id: string; name: string; primaryImageUrl?: string | null; sellable?: boolean };

function call(
  server: Server,
  path: string,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  const addr = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: addr.port, path, method: "GET", headers: headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text || null;
          if (text) {
            try {
              body = JSON.parse(text);
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

async function main() {
  console.log("Focused Verification — Catalog 10.4\n");
  const results: Result[] = [];
  const stamp = Date.now();
  const run = async (id: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ id, status: "PASS" });
      console.log(`  ✓ ${id}`);
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      results.push({ id, status: "FAIL", note });
      console.error(`  ✗ ${id}: ${note}`);
    }
  };

  const app = await NestFactory.create(CatalogTestAppModule, { logger: false });
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

  const catIds: string[] = [];
  const productIds: string[] = [];
  const brandIds: string[] = [];

  try {
    const brand = await prisma.brand.create({
      data: { name: `B104 ${stamp}`, slug: `b104-${stamp}` },
    });
    brandIds.push(brand.id);

    const catA = await prisma.category.create({
      data: {
        name: `CatA ${stamp}`,
        slug: `c104-a-${stamp}`,
        path: `/c104-a-${stamp}`,
        depth: 0,
        isActive: true,
        sortOrder: 10,
      },
    });
    const catB = await prisma.category.create({
      data: {
        name: `CatB ${stamp}`,
        slug: `c104-b-${stamp}`,
        path: `/c104-b-${stamp}`,
        depth: 0,
        isActive: true,
        sortOrder: 5,
      },
    });
    const catInact = await prisma.category.create({
      data: {
        name: `CatIn ${stamp}`,
        slug: `c104-in-${stamp}`,
        path: `/c104-in-${stamp}`,
        depth: 0,
        isActive: false,
        sortOrder: 1,
      },
    });
    catIds.push(catA.id, catB.id, catInact.id);

    const mkProduct = async (input: {
      name: string;
      slug: string;
      categoryId: string;
      brandId?: string;
      price: string;
      size?: string;
      color?: string;
      isActive?: boolean;
      createdAt?: Date;
      enName?: string;
    }) => {
      const p = await prisma.product.create({
        data: {
          categoryId: input.categoryId,
          brandId: input.brandId,
          name: input.name,
          slug: input.slug,
          description: `desc ${input.name}`,
          isActive: input.isActive ?? true,
          createdAt: input.createdAt ?? new Date(),
        },
      });
      productIds.push(p.id);
      const attrs: Record<string, string> = {};
      if (input.size) attrs.size = input.size;
      if (input.color) attrs.color = input.color;
      await prisma.productVariant.create({
        data: {
          productId: p.id,
          sku: `SKU-${input.slug}`.toUpperCase().slice(0, 40),
          price: input.price,
          weightGrams: 100,
          isActive: true,
          attributesJson: attrs,
        },
      });
      await prisma.productImage.create({
        data: {
          productId: p.id,
          objectKey: `catalog/${p.id}/a.jpg`,
          aspectRatio: "4:5",
          sortOrder: 0,
        },
      });
      if (input.enName) {
        await prisma.productTranslation.create({
          data: {
            productId: p.id,
            locale: "en",
            name: input.enName,
            description: `EN ${input.enName}`,
          },
        });
      }
      return p;
    };

    const older = new Date("2024-01-01T00:00:00.000Z");
    const newer = new Date("2025-06-01T00:00:00.000Z");

    const pAlpha = await mkProduct({
      name: `AlphaShirt ${stamp}`,
      slug: `p104-alpha-${stamp}`,
      categoryId: catA.id,
      brandId: brand.id,
      price: "30.00",
      size: "M",
      color: "Black",
      createdAt: newer,
      enName: `EnglishAlpha ${stamp}`,
    });
    const pBeta = await mkProduct({
      name: `BetaShirt ${stamp}`,
      slug: `p104-beta-${stamp}`,
      categoryId: catB.id,
      brandId: brand.id,
      price: "10.00",
      size: "L",
      color: "Red",
      createdAt: older,
    });
    const pGamma = await mkProduct({
      name: `GammaHat ${stamp}`,
      slug: `p104-gamma-${stamp}`,
      categoryId: catB.id,
      price: "20.00",
      size: "M",
      color: "Black",
      createdAt: newer,
    });
    const pInactive = await mkProduct({
      name: `HiddenDead ${stamp}`,
      slug: `p104-dead-${stamp}`,
      categoryId: catA.id,
      price: "1.00",
      isActive: false,
    });
    const pInInactCat = await mkProduct({
      name: `StillSellable ${stamp}`,
      slug: `p104-sell-${stamp}`,
      categoryId: catInact.id,
      price: "15.00",
      size: "M",
      color: "Black",
      createdAt: older,
    });
    void pInactive;

    const list = async (qs: string, headers?: Record<string, string>) => {
      const res = await call(server, `/v1/catalog/products?${qs}`, headers);
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as {
        page: number;
        pageSize: number;
        total: number;
        sort: string;
        items: Card[];
      };
    };

    await run("S1 text query hit", async () => {
      const body = await list(`q=AlphaShirt`);
      if (!body.items.some((i) => i.id === pAlpha.id)) throw new Error("miss alpha");
    });

    await run("S2 text query miss", async () => {
      const body = await list(`q=ZZZNoSuch-${stamp}`);
      if (body.items.length !== 0) throw new Error("expected empty");
    });

    await run("S3 translation locale en", async () => {
      const body = await list(`q=EnglishAlpha&locale=en`);
      const hit = body.items.find((i) => i.id === pAlpha.id);
      if (!hit) throw new Error("en translation miss");
      if (hit.name !== `EnglishAlpha ${stamp}`) throw new Error(`name ${hit.name}`);
    });

    await run("S4 filter size", async () => {
      const body = await list(`size=M&q=${stamp}`);
      const ids = body.items.map((i) => i.id);
      if (!ids.includes(pAlpha.id) || !ids.includes(pGamma.id)) throw new Error("size M");
      if (ids.includes(pBeta.id)) throw new Error("L leaked");
    });

    await run("S5 filter color", async () => {
      const body = await list(`color=Red&q=${stamp}`);
      if (body.items.length !== 1 || body.items[0].id !== pBeta.id) throw new Error("red");
    });

    await run("S6 filter price", async () => {
      const body = await list(`priceMin=15&priceMax=25&q=${stamp}`);
      const ids = new Set(body.items.map((i) => i.id));
      if (!ids.has(pGamma.id) || !ids.has(pInInactCat.id)) throw new Error("price range");
      if (ids.has(pAlpha.id) || ids.has(pBeta.id)) throw new Error("out of range");
    });

    await run("S7 filter brand", async () => {
      const body = await list(`brand=b104-${stamp}`);
      const ids = body.items.map((i) => i.id);
      if (!ids.includes(pAlpha.id) || !ids.includes(pBeta.id)) throw new Error("brand");
      if (ids.includes(pGamma.id)) throw new Error("unbranded");
    });

    await run("S8 filter category effectiveActive", async () => {
      const body = await list(`category=c104-a-${stamp}`);
      if (!body.items.some((i) => i.id === pAlpha.id)) throw new Error("cat A");
      const bad = await call(server, `/v1/catalog/products?category=c104-in-${stamp}`);
      if (bad.status !== 404) throw new Error(`inactive cat ${bad.status}`);
    });

    await run("S9 combined filters", async () => {
      const body = await list(`size=M&color=Black&brand=b104-${stamp}&q=${stamp}`);
      if (body.items.length !== 1 || body.items[0].id !== pAlpha.id) {
        throw new Error(JSON.stringify(body.items.map((i) => i.id)));
      }
    });

    await run("S10 sort default", async () => {
      const body = await list(`q=${stamp}&sort=default&pageSize=50`);
      const ids = body.items.map((i) => i.id);
      // CatB sortOrder 5 before CatA 10; within CatB older createdAt first (beta before gamma if same cat)
      const iBeta = ids.indexOf(pBeta.id);
      const iGamma = ids.indexOf(pGamma.id);
      const iAlpha = ids.indexOf(pAlpha.id);
      const iSell = ids.indexOf(pInInactCat.id);
      if (iBeta < 0 || iGamma < 0 || iAlpha < 0 || iSell < 0) throw new Error("missing");
      // inactive-cat product still listed globally; its cat sortOrder=1 → first among fixtures with q=stamp
      if (iSell !== 0) throw new Error(`inactive-cat-first got ${ids[0]}`);
      if (!(iBeta < iGamma && iGamma < iAlpha)) {
        throw new Error(`order ${ids.join(",")}`);
      }
      if (body.sort !== "default") throw new Error("sort field");
    });

    await run("S11 sort newest", async () => {
      const body = await list(`q=${stamp}&sort=newest&pageSize=50`);
      const ids = body.items.map((i) => i.id);
      // newer createdAt first: alpha & gamma before beta; id DESC among same timestamp
      const iBeta = ids.indexOf(pBeta.id);
      const iAlpha = ids.indexOf(pAlpha.id);
      if (!(iAlpha < iBeta)) throw new Error(`newest ${ids.join(",")}`);
    });

    await run("S12 sort price_asc", async () => {
      const body = await list(`q=${stamp}&sort=price_asc&pageSize=50`);
      const order = body.items.map((i) => i.id);
      if (order.indexOf(pBeta.id) > order.indexOf(pInInactCat.id)) throw new Error("asc");
      if (order.indexOf(pInInactCat.id) > order.indexOf(pGamma.id)) throw new Error("asc2");
      if (order.indexOf(pGamma.id) > order.indexOf(pAlpha.id)) throw new Error("asc3");
    });

    await run("S13 sort price_desc", async () => {
      const body = await list(`q=${stamp}&sort=price_desc&pageSize=50`);
      const order = body.items.map((i) => i.id);
      if (order.indexOf(pAlpha.id) > order.indexOf(pGamma.id)) throw new Error("desc");
      if (order.indexOf(pGamma.id) > order.indexOf(pBeta.id)) throw new Error("desc2");
    });

    await run("S14 sellable-only", async () => {
      const body = await list(`q=HiddenDead`);
      if (body.items.some((i) => i.id === pInactive.id)) throw new Error("inactive listed");
    });

    await run("S15 inactive category does not hide global search", async () => {
      const body = await list(`q=StillSellable`);
      if (!body.items.some((i) => i.id === pInInactCat.id)) throw new Error("hidden wrongly");
    });

    await run("S16 pagination", async () => {
      const p1 = await list(`q=${stamp}&sort=price_asc&page=1&pageSize=2`);
      const p2 = await list(`q=${stamp}&sort=price_asc&page=2&pageSize=2`);
      if (p1.items.length !== 2) throw new Error("page1 size");
      if (p1.total < 4) throw new Error("total");
      const overlap = p1.items.filter((a) => p2.items.some((b) => b.id === a.id));
      if (overlap.length) throw new Error("overlap");
    });

    await run("S17 primaryImageUrl", async () => {
      const body = await list(`q=AlphaShirt`);
      const hit = body.items.find((i) => i.id === pAlpha.id);
      if (!hit?.primaryImageUrl?.startsWith("http")) throw new Error("url");
      if (JSON.stringify(hit).includes("objectKey")) throw new Error("objectKey leaked");
    });

    await run("S18 invalid sort 400", async () => {
      const res = await call(server, `/v1/catalog/products?sort=rating`);
      if (res.status !== 400) throw new Error(`status ${res.status}`);
    });

    await run("S19 no meili in list path", async () => {
      // Structural: listProducts uses Prisma only — smoke that endpoint works without MEILI
      const body = await list(`page=1&pageSize=1`);
      if (!("items" in body)) throw new Error("shape");
    });
  } finally {
    try {
      for (const pid of productIds) {
        await prisma.productTranslation.deleteMany({ where: { productId: pid } });
        await prisma.productImage.deleteMany({ where: { productId: pid } });
        await prisma.productVariant.deleteMany({ where: { productId: pid } });
        await prisma.product.deleteMany({ where: { id: pid } });
      }
      for (const id of catIds) await prisma.category.deleteMany({ where: { id } });
      for (const id of brandIds) await prisma.brand.deleteMany({ where: { id } });
    } catch {
      /* best-effort */
    }
    await app.close();
  }

  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length) {
    console.log(`\nFocused Verification 10.4: FAIL (${results.length - failed.length}/${results.length})`);
    process.exit(1);
  }
  console.log(`\nFocused Verification 10.4: ${results.length}/${results.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
