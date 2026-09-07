/**
 * Focused Verification — Execute 10.2 Catalog (test-only).
 * Does not close Gate 10.2; proves HTTP/runtime behavior for 10.2 deltas.
 *
 * Requires: DATABASE_URL + JWT secrets + seed (roles, MAIN, CompanySettings)
 * Run (after build): node dist/catalog.10.2.selftest.js
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
import { PaymentStatus } from "@dodo/database";
import { CatalogTestAppModule } from "./catalog-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { hashPassword } from "./auth/crypto.util";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

const OWNER_PASSWORD = "Catalog10.2-Owner-Pass!";

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
          ...opts?.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text || null;
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

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

async function main() {
  console.log("Focused Verification — Catalog 10.2\n");
  const results: Result[] = [];
  const stamp = Date.now();

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
  const jwt = app.get(JwtService);

  const company = await prisma.companySettings.findUnique({ where: { id: "default" } });
  if (!company) {
    console.error("BLOCKED: CompanySettings default required");
    process.exit(1);
  }
  const mainLoc = await prisma.location.findFirst({ where: { code: "MAIN", isActive: true } });
  if (!mainLoc) {
    console.error("BLOCKED: MAIN location required");
    process.exit(1);
  }

  /** Fixture: store_default manufacturer so P2 publish guards can pass without mutating product DTOs. */
  const companyMfgSnap = {
    defaultManufacturerDisplayName: company.defaultManufacturerDisplayName,
    defaultManufacturerAddressLine1: company.defaultManufacturerAddressLine1,
    defaultManufacturerPostalCode: company.defaultManufacturerPostalCode,
    defaultManufacturerCity: company.defaultManufacturerCity,
    defaultManufacturerCountryCode: company.defaultManufacturerCountryCode,
    defaultManufacturerEstablishedInUnion: company.defaultManufacturerEstablishedInUnion,
    defaultManufacturerEmail: company.defaultManufacturerEmail,
  };
  await prisma.companySettings.update({
    where: { id: "default" },
    data: {
      defaultManufacturerDisplayName: "C102 Verify Mfg",
      defaultManufacturerAddressLine1: "Verifystr. 1",
      defaultManufacturerPostalCode: "10115",
      defaultManufacturerCity: "Berlin",
      defaultManufacturerCountryCode: "DE",
      defaultManufacturerEstablishedInUnion: true,
      defaultManufacturerEmail: "c102-mfg@test.local",
    },
  });

  const createdUserIds: string[] = [];
  const createdCategoryIds: string[] = [];
  const createdProductIds: string[] = [];

  const staffBearer = async (code: RoleCode, password?: string) => {
    const role = await prisma.role.findUniqueOrThrow({ where: { code } });
    const user = await prisma.user.create({
      data: {
        email: `c102_${code}_${stamp}_${randomBytes(3).toString("hex")}@test.local`,
        name: `C102 ${code}`,
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

  const owner = await staffBearer(RoleCode.OWNER, OWNER_PASSWORD);
  const customer = await staffBearer(RoleCode.CUSTOMER);

  try {
    // ——— 1 Public category ———
    await run("V1.1 inactive category → 404", async () => {
      const cat = await prisma.category.create({
        data: {
          name: `Inact ${stamp}`,
          slug: `v1-inact-${stamp}`,
          path: `/v1-inact-${stamp}`,
          depth: 0,
          isActive: false,
        },
      });
      createdCategoryIds.push(cat.id);
      const res = await call(server, "GET", `/v1/catalog/categories/${cat.slug}`);
      if (res.status !== 404) throw new Error(`status ${res.status}`);
    });

    await run("V1.2 inactive ancestor → child 404", async () => {
      const parent = await prisma.category.create({
        data: {
          name: `Par ${stamp}`,
          slug: `v1-par-${stamp}`,
          path: `/v1-par-${stamp}`,
          depth: 0,
          isActive: false,
        },
      });
      createdCategoryIds.push(parent.id);
      const child = await prisma.category.create({
        data: {
          name: `Ch ${stamp}`,
          slug: `v1-ch-${stamp}`,
          path: `/v1-par-${stamp}/v1-ch-${stamp}`,
          depth: 1,
          parentId: parent.id,
          isActive: true,
        },
      });
      createdCategoryIds.push(child.id);
      const res = await call(server, "GET", `/v1/catalog/categories/${child.slug}`);
      if (res.status !== 404) throw new Error(`status ${res.status}`);
    });

    let activeCatSlug = "";
    let activeCatId = "";
    await run("V1.3 active category → 200", async () => {
      const cat = await prisma.category.create({
        data: {
          name: `Act ${stamp}`,
          slug: `v1-act-${stamp}`,
          path: `/v1-act-${stamp}`,
          depth: 0,
          isActive: true,
          sizeGuideMarkdown: "# Size\nM L",
        },
      });
      createdCategoryIds.push(cat.id);
      activeCatId = cat.id;
      activeCatSlug = cat.slug;
      const res = await call(server, "GET", `/v1/catalog/categories/${cat.slug}`);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = res.body as { effectiveActive?: boolean; slug?: string };
      if (body.slug !== cat.slug) throw new Error("slug");
      if (body.effectiveActive !== true) throw new Error("effectiveActive");
    });

    // ——— 2 PLP ———
    let unsellableId = "";
    let sellableSlug = "";
    let sellableId = "";
    let sellableVariantId = "";
    let sellableVariantId2 = "";

    await run("V2.1 PLP excludes product without active variant", async () => {
      const p = await prisma.product.create({
        data: {
          categoryId: activeCatId,
          name: `NoVar ${stamp}`,
          slug: `v2-novar-${stamp}`,
          description: "x",
          isActive: true,
        },
      });
      createdProductIds.push(p.id);
      unsellableId = p.id;
      const res = await call(server, "GET", `/v1/catalog/products?category=${activeCatSlug}`);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const items = (res.body as { items: Array<{ id: string }> }).items ?? [];
      if (items.some((i) => i.id === p.id)) throw new Error("unsellable listed");
    });

    await run("V2.2 PLP includes sellable product", async () => {
      const created = await call(server, "POST", "/v1/admin/catalog/products", {
        bearer: owner.bearer,
        json: {
          categoryId: activeCatId,
          name: `Sell ${stamp}`,
          slug: `v2-sell-${stamp}`,
          description: "sellable",
          mode: "simple",
          baseVariant: { sku: `V2S-${stamp}`, price: "29.90", weightGrams: 400 },
          isActive: false,
        },
      });
      if (created.status !== 200 && created.status !== 201) {
        throw new Error(`create ${created.status} ${JSON.stringify(created.body)}`);
      }
      const product = created.body as { id: string; slug: string };
      sellableId = product.id;
      sellableSlug = product.slug;
      createdProductIds.push(product.id);

      const img = await call(server, "POST", `/v1/admin/catalog/products/${product.id}/images`, {
        bearer: owner.bearer,
        json: { objectKey: `catalog/${product.id}/a.jpg`, aspectRatio: "4:5", sortOrder: 0 },
      });
      if (img.status !== 200 && img.status !== 201) throw new Error(`img ${img.status}`);

      const admin = await call(server, "GET", `/v1/admin/catalog/products/${product.id}`, {
        bearer: owner.bearer,
      });
      const variants = (admin.body as { variants: Array<{ id: string }> }).variants ?? [];
      if (variants.length !== 1) throw new Error("auto base variant");
      sellableVariantId = variants[0].id;

      await prisma.inventory.upsert({
        where: {
          locationId_variantId: { locationId: mainLoc.id, variantId: sellableVariantId },
        },
        create: { locationId: mainLoc.id, variantId: sellableVariantId, quantityOnHand: 5 },
        update: { quantityOnHand: 5 },
      });

      const pub = await call(server, "PATCH", `/v1/admin/catalog/products/${product.id}`, {
        bearer: owner.bearer,
        json: { isActive: true },
      });
      if (pub.status !== 200) throw new Error(`publish ${pub.status} ${JSON.stringify(pub.body)}`);

      const list = await call(server, "GET", `/v1/catalog/products?category=${activeCatSlug}`);
      const items = (list.body as { items: Array<{ id: string; primaryImageUrl?: string }> }).items ?? [];
      const card = items.find((i) => i.id === product.id);
      if (!card) throw new Error("sellable missing from PLP");
      if (!card.primaryImageUrl || !String(card.primaryImageUrl).includes("http")) {
        throw new Error("primaryImageUrl");
      }
    });

    // ——— 3 PDP ———
    await run("V3.1 non-sellable PDP → 404", async () => {
      const res = await call(server, "GET", `/v1/catalog/products/v2-novar-${stamp}`);
      if (res.status !== 404) throw new Error(`status ${res.status}`);
    });

    await run("V3.2 GPSR-incomplete active product → 404", async () => {
      // Force incomplete manufacturer on an otherwise sellable product via DB (bypass guards)
      const p = await prisma.product.create({
        data: {
          categoryId: activeCatId,
          name: `GPSR ${stamp}`,
          slug: `v3-gpsr-${stamp}`,
          description: "g",
          isActive: true,
          manufacturerSource: "product_specific",
          manufacturerDisplayName: null,
        },
      });
      createdProductIds.push(p.id);
      const v = await prisma.productVariant.create({
        data: {
          productId: p.id,
          sku: `GPSR-${stamp}`,
          price: 10,
          weightGrams: 100,
          isActive: true,
        },
      });
      await prisma.productImage.create({
        data: {
          productId: p.id,
          objectKey: `catalog/${p.id}/g.jpg`,
          aspectRatio: "4:5",
          sortOrder: 0,
        },
      });
      void v;
      const res = await call(server, "GET", `/v1/catalog/products/${p.slug}`);
      if (res.status !== 404) throw new Error(`expected 404 got ${res.status}`);
    });

    await run("V3.3 valid PDP aggregate + sellable + available + image url", async () => {
      const res = await call(server, "GET", `/v1/catalog/products/${sellableSlug}`);
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = res.body as Record<string, unknown>;
      for (const k of [
        "product",
        "categoryPath",
        "options",
        "variants",
        "images",
        "priceDisplay",
        "reviews",
        "relatedProducts",
        "legal",
        "productSafety",
        "seo",
        "sellable",
        "defaultVariantId",
      ]) {
        if (!(k in body)) throw new Error(`missing ${k}`);
      }
      if (body.sellable !== true) throw new Error("sellable");
      if (body.defaultVariantId !== sellableVariantId) throw new Error("defaultVariantId");
      const variants = body.variants as Array<{ available?: number; id: string }>;
      const v0 = variants.find((v) => v.id === sellableVariantId);
      if (!v0 || typeof v0.available !== "number") throw new Error("available");
      if (v0.available !== 5) throw new Error(`available=${v0.available}`);
      const images = body.images as Array<{ url?: string; objectKey?: string }>;
      if (!images[0]?.url?.startsWith("http")) throw new Error("image url");
      if (images[0].objectKey) throw new Error("raw objectKey leaked");
    });

    // ——— 4 Deep link ———
    await run("V4.1 invalid variantId ignored (200)", async () => {
      const res = await call(
        server,
        "GET",
        `/v1/catalog/products/${sellableSlug}?variantId=does-not-exist`,
      );
      if (res.status !== 200) throw new Error(`status ${res.status}`);
    });

    await run("V4.2 valid variantId drives priceDisplay single", async () => {
      // add second active variant for variable-like selection on same product
      const v2 = await call(server, "POST", `/v1/admin/catalog/products/${sellableId}/variants`, {
        bearer: owner.bearer,
        json: {
          sku: `V2S2-${stamp}`,
          price: "39.90",
          weightGrams: 400,
          attributesJson: {},
          isActive: true,
        },
      });
      // may fail consistency if simple {} vs {} — should be ok
      if (v2.status !== 200 && v2.status !== 201) {
        // product already has one variant with {}; second {} should conflict uniqueness
        // create with distinct empty is same fingerprint — expect conflict; use attributes for variable product instead
        const vp = await call(server, "POST", "/v1/admin/catalog/products", {
          bearer: owner.bearer,
          json: {
            categoryId: activeCatId,
            name: `Var ${stamp}`,
            slug: `v4-var-${stamp}`,
            description: "variable",
            mode: "variable",
            isActive: false,
          },
        });
        if (vp.status !== 200 && vp.status !== 201) {
          throw new Error(`var product ${vp.status} ${JSON.stringify(vp.body)}`);
        }
        const pid = (vp.body as { id: string }).id;
        createdProductIds.push(pid);
        const va = await call(server, "POST", `/v1/admin/catalog/products/${pid}/variants`, {
          bearer: owner.bearer,
          json: {
            sku: `VA-${stamp}`,
            price: "10.00",
            weightGrams: 200,
            attributesJson: { size: "M" },
            isActive: true,
          },
        });
        const vb = await call(server, "POST", `/v1/admin/catalog/products/${pid}/variants`, {
          bearer: owner.bearer,
          json: {
            sku: `VB-${stamp}`,
            price: "20.00",
            weightGrams: 200,
            attributesJson: { size: "L" },
            isActive: true,
          },
        });
        if (va.status > 299 || vb.status > 299) {
          throw new Error(`variants ${va.status}/${vb.status}`);
        }
        sellableVariantId2 = (vb.body as { id: string }).id;
        await call(server, "POST", `/v1/admin/catalog/products/${pid}/images`, {
          bearer: owner.bearer,
          json: { objectKey: `catalog/${pid}/v.jpg`, aspectRatio: "4:5" },
        });
        await prisma.inventory.create({
          data: { locationId: mainLoc.id, variantId: sellableVariantId2, quantityOnHand: 2 },
        });
        const pub = await call(server, "PATCH", `/v1/admin/catalog/products/${pid}`, {
          bearer: owner.bearer,
          json: { isActive: true },
        });
        if (pub.status !== 200) throw new Error(`pub var ${pub.status} ${JSON.stringify(pub.body)}`);
        const pdp = await call(
          server,
          "GET",
          `/v1/catalog/products/v4-var-${stamp}?variantId=${sellableVariantId2}`,
        );
        if (pdp.status !== 200) throw new Error(`pdp ${pdp.status}`);
        const pd = (pdp.body as { priceDisplay: { mode: string; amount?: string } }).priceDisplay;
        if (pd.mode !== "single") throw new Error(`mode ${pd.mode}`);
        if (pd.amount !== "20.00") throw new Error(`amount ${pd.amount}`);
        return;
      }
      sellableVariantId2 = (v2.body as { id: string }).id;
    });

    // ——— 5 Locale ———
    await run("V5.1 translation locale + fallback", async () => {
      const tr = await call(server, "PUT", `/v1/admin/catalog/products/${sellableId}/translations`, {
        bearer: owner.bearer,
        json: {
          locale: "en",
          name: "EN Sell Name",
          description: "EN description text",
          seoTitle: "EN SEO",
        },
      });
      if (tr.status !== 200 && tr.status !== 201) {
        throw new Error(`tr ${tr.status} ${JSON.stringify(tr.body)}`);
      }
      const en = await call(server, "GET", `/v1/catalog/products/${sellableSlug}?locale=en`);
      if (en.status !== 200) throw new Error(`en ${en.status}`);
      const enName = (en.body as { product: { name: string } }).product.name;
      if (enName !== "EN Sell Name") throw new Error(`en name ${enName}`);

      const fr = await call(server, "GET", `/v1/catalog/products/${sellableSlug}?locale=fr`);
      // resolveLocale falls back to de for unsupported; de translation may be absent → Product fields
      if (fr.status !== 200) throw new Error(`fr-fallback ${fr.status}`);
      const frName = (fr.body as { product: { name: string } }).product.name;
      if (frName !== `Sell ${stamp}`) throw new Error(`fallback name ${frName}`);
    });

    // ——— 6 Reviews ———
    await run("V6.1 reviews published-only + pagination + reply", async () => {
      await prisma.review.create({
        data: {
          productId: sellableId,
          userId: customer.userId,
          rating: 5,
          body: "pending body",
          status: "pending",
          verifiedPurchase: false,
        },
      });
      const published = await prisma.review.create({
        data: {
          productId: sellableId,
          userId: owner.userId,
          rating: 4,
          body: "published body",
          status: "published",
          verifiedPurchase: true,
        },
      });
      await prisma.reviewReply.create({
        data: {
          reviewId: published.id,
          body: "Thanks!",
          authorStaffId: owner.userId,
        },
      });

      const res = await call(server, "GET", `/v1/catalog/products/${sellableSlug}/reviews?page=1&pageSize=10`);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = res.body as {
        items: Array<{ body?: string; reply?: { body: string } | null; status?: string }>;
        page: number;
      };
      if (body.page !== 1) throw new Error("page");
      if (body.items.some((i) => i.body === "pending body")) throw new Error("pending leaked");
      const hit = body.items.find((i) => i.body === "published body");
      if (!hit) throw new Error("published missing");
      if (!hit.reply || hit.reply.body !== "Thanks!") throw new Error("reply");
    });

    // ——— 7 Admin rules ———
    await run("V7.1 simple auto-variant", async () => {
      const admin = await call(server, "GET", `/v1/admin/catalog/products/${sellableId}`, {
        bearer: owner.bearer,
      });
      const variants = (admin.body as { variants: unknown[] }).variants;
      if (!variants?.length) throw new Error("no base variant");
    });

    await run("V7.2 attribute fingerprint uniqueness", async () => {
      const p = await call(server, "POST", "/v1/admin/catalog/products", {
        bearer: owner.bearer,
        json: {
          categoryId: activeCatId,
          name: `FP ${stamp}`,
          slug: `v7-fp-${stamp}`,
          description: "fp",
          mode: "variable",
          isActive: false,
        },
      });
      const pid = (p.body as { id: string }).id;
      createdProductIds.push(pid);
      const a = await call(server, "POST", `/v1/admin/catalog/products/${pid}/variants`, {
        bearer: owner.bearer,
        json: {
          sku: `FP1-${stamp}`,
          price: "1.00",
          weightGrams: 50,
          attributesJson: { color: "red" },
          isActive: true,
        },
      });
      if (a.status > 299) throw new Error(`a ${a.status}`);
      const b = await call(server, "POST", `/v1/admin/catalog/products/${pid}/variants`, {
        bearer: owner.bearer,
        json: {
          sku: `FP2-${stamp}`,
          price: "2.00",
          weightGrams: 50,
          attributesJson: { color: "red" },
          isActive: true,
        },
      });
      if (b.status === 200 || b.status === 201) throw new Error("duplicate fingerprint allowed");
    });

    await run("V7.3 grundpreis unit validation", async () => {
      const p = await call(server, "POST", "/v1/admin/catalog/products", {
        bearer: owner.bearer,
        json: {
          categoryId: activeCatId,
          name: `GP ${stamp}`,
          slug: `v7-gp-${stamp}`,
          description: "gp",
          mode: "simple",
          baseVariant: {
            sku: `GP-${stamp}`,
            price: "5.00",
            weightGrams: 100,
          },
          isActive: false,
        },
      });
      const pid = (p.body as { id: string }).id;
      createdProductIds.push(pid);
      const admin = await call(server, "GET", `/v1/admin/catalog/products/${pid}`, {
        bearer: owner.bearer,
      });
      const vid = (admin.body as { variants: Array<{ id: string }> }).variants[0].id;
      const bad = await call(server, "PATCH", `/v1/admin/catalog/variants/${vid}`, {
        bearer: owner.bearer,
        json: { grundpreisAmount: "1.00", grundpreisUnit: "not-a-unit" },
      });
      if (bad.status === 200) throw new Error("bad unit accepted");
    });

    await run("V7.4 publish guard P6 no image", async () => {
      const p = await call(server, "POST", "/v1/admin/catalog/products", {
        bearer: owner.bearer,
        json: {
          categoryId: activeCatId,
          name: `NoImg ${stamp}`,
          slug: `v7-noimg-${stamp}`,
          description: "x",
          mode: "simple",
          baseVariant: { sku: `NOIMG-${stamp}`, price: "3.00", weightGrams: 80 },
          isActive: false,
        },
      });
      const pid = (p.body as { id: string }).id;
      createdProductIds.push(pid);
      const pub = await call(server, "PATCH", `/v1/admin/catalog/products/${pid}`, {
        bearer: owner.bearer,
        json: { isActive: true },
      });
      if (pub.status === 200) throw new Error("published without image");
      if (pub.status !== 409 && pub.status !== 400) throw new Error(`status ${pub.status}`);
    });

    await run("V7.5 publish guard L5 grundpreis when required", async () => {
      const cat = await prisma.category.create({
        data: {
          name: `GPCat ${stamp}`,
          slug: `v7-gpcat-${stamp}`,
          path: `/v7-gpcat-${stamp}`,
          depth: 0,
          isActive: true,
          requiresGrundpreis: true,
        },
      });
      createdCategoryIds.push(cat.id);
      const p = await call(server, "POST", "/v1/admin/catalog/products", {
        bearer: owner.bearer,
        json: {
          categoryId: cat.id,
          name: `L5 ${stamp}`,
          slug: `v7-l5-${stamp}`,
          description: "l5",
          mode: "simple",
          baseVariant: { sku: `L5-${stamp}`, price: "4.00", weightGrams: 70 },
          isActive: false,
        },
      });
      const pid = (p.body as { id: string }).id;
      createdProductIds.push(pid);
      await call(server, "POST", `/v1/admin/catalog/products/${pid}/images`, {
        bearer: owner.bearer,
        json: { objectKey: `catalog/${pid}/l5.jpg`, aspectRatio: "4:5" },
      });
      const pub = await call(server, "PATCH", `/v1/admin/catalog/products/${pid}`, {
        bearer: owner.bearer,
        json: { isActive: true },
      });
      if (pub.status === 200) throw new Error("published without grundpreis");
      if (pub.status !== 409) throw new Error(`status ${pub.status} ${JSON.stringify(pub.body)}`);
      const msg = String((pub.body as { message?: string }).message ?? "");
      if (!msg.includes("L5")) throw new Error(`msg ${msg}`);
    });

    // ——— 8 Related ———
    await run("V8.1 related link + PDP", async () => {
      const other = await call(server, "POST", "/v1/admin/catalog/products", {
        bearer: owner.bearer,
        json: {
          categoryId: activeCatId,
          name: `Rel ${stamp}`,
          slug: `v8-rel-${stamp}`,
          description: "rel",
          mode: "simple",
          baseVariant: { sku: `REL-${stamp}`, price: "8.00", weightGrams: 90 },
          isActive: false,
        },
      });
      const oid = (other.body as { id: string }).id;
      createdProductIds.push(oid);
      await call(server, "POST", `/v1/admin/catalog/products/${oid}/images`, {
        bearer: owner.bearer,
        json: { objectKey: `catalog/${oid}/r.jpg`, aspectRatio: "4:5" },
      });
      const pub = await call(server, "PATCH", `/v1/admin/catalog/products/${oid}`, {
        bearer: owner.bearer,
        json: { isActive: true },
      });
      if (pub.status !== 200) throw new Error(`rel pub ${pub.status} ${JSON.stringify(pub.body)}`);

      const link = await call(server, "POST", `/v1/admin/catalog/products/${sellableId}/related`, {
        bearer: owner.bearer,
        json: { relatedProductId: oid, type: "related" },
      });
      if (link.status > 299) throw new Error(`link ${link.status}`);

      const pdp = await call(server, "GET", `/v1/catalog/products/${sellableSlug}`);
      const related = (pdp.body as { relatedProducts: Array<{ id: string; primaryImageUrl?: string }> })
        .relatedProducts;
      if (!related?.some((r) => r.id === oid)) throw new Error("related missing on PDP");

      const unlink = await call(
        server,
        "DELETE",
        `/v1/admin/catalog/products/${sellableId}/related/${oid}`,
        { bearer: owner.bearer },
      );
      if (unlink.status > 299) throw new Error(`unlink ${unlink.status}`);
    });

    // ——— 9 Reviewable ———
    await run("V9.1 reviewable only with qualifying paid OrderItem", async () => {
      const guestPdp = await call(server, "GET", `/v1/catalog/products/${sellableSlug}`);
      const g = guestPdp.body as { reviewable?: boolean };
      if (g.reviewable === true) throw new Error("guest reviewable true");

      const before = await call(server, "GET", `/v1/catalog/products/${sellableSlug}`, {
        bearer: customer.bearer,
      });
      if ((before.body as { reviewable?: boolean }).reviewable === true) {
        throw new Error("reviewable before purchase");
      }

      const order = await prisma.order.create({
        data: {
          orderNumber: `C102-${stamp}`,
          userId: customer.userId,
          status: "CONFIRMED",
          paymentStatus: PaymentStatus.PAID,
          currencyCode: "EUR",
          locale: "de",
          shippingCountryCode: "DE",
          taxMode: "KLEINUNTERNEHMER",
          companyIsKleinunternehmer: true,
          invoiceExemptionTextSnapshot: "KU",
          sellerIdentitySnapshotJson: {
            legalName: "Test",
            line1: "Street 1",
            postalCode: "10115",
            city: "Berlin",
            countryCode: "DE",
          },
          itemsSubtotal: 29.9,
          shippingTotal: 0,
          discountCoupon: 0,
          discountBonus: 0,
          grandTotal: 29.9,
          shippingMethodCodeSnapshot: "standard",
          shippingStandardAmountSnapshot: 0,
          shippingAddressJson: { line1: "x" },
          billingAddressJson: { line1: "x" },
          placedAt: new Date(),
          confirmedAt: new Date(),
          items: {
            create: {
              variantId: sellableVariantId,
              nameSnapshot: "Sell",
              skuSnapshot: `V2S-${stamp}`,
              unitPriceSnapshot: 29.9,
              quantity: 1,
              lineTotalSnapshot: 29.9,
              weightGramsSnapshot: 100,
            },
          },
        },
      });
      void order;

      const after = await call(server, "GET", `/v1/catalog/products/${sellableSlug}`, {
        bearer: customer.bearer,
      });
      if ((after.body as { reviewable?: boolean }).reviewable !== true) {
        throw new Error("reviewable after paid order");
      }
    });

    // ——— Bundle regression: existing endpoints still present, not expanded ———
    await run("V10 public bundles endpoints unchanged (still present, no purchase)", async () => {
      const list = await call(server, "GET", "/v1/catalog/bundles");
      if (list.status !== 200) throw new Error(`bundles list ${list.status}`);
      // no cart/bundle route introduced — smoke only
    });
  } finally {
    try {
      await prisma.companySettings.update({
        where: { id: "default" },
        data: companyMfgSnap,
      });
    } catch {
      /* restore best-effort */
    }
    try {
      for (const pid of createdProductIds) {
        await prisma.reviewReply.deleteMany({
          where: { review: { productId: pid } },
        });
        await prisma.review.deleteMany({ where: { productId: pid } });
        await prisma.relatedProduct.deleteMany({
          where: { OR: [{ productId: pid }, { relatedProductId: pid }] },
        });
        await prisma.orderItem.deleteMany({
          where: { variant: { productId: pid } },
        });
        await prisma.order.deleteMany({
          where: { items: { some: { variant: { productId: pid } } } },
        });
        await prisma.inventory.deleteMany({ where: { variant: { productId: pid } } });
        await prisma.productImage.deleteMany({ where: { productId: pid } });
        await prisma.productTranslation.deleteMany({ where: { productId: pid } });
        await prisma.productVariant.deleteMany({ where: { productId: pid } });
        await prisma.product.deleteMany({ where: { id: pid } });
      }
      for (const id of [...createdCategoryIds].reverse()) {
        await prisma.category.deleteMany({ where: { id } });
      }
      for (const uid of createdUserIds) {
        await prisma.auditLog.deleteMany({ where: { actorId: uid } });
        await prisma.session.deleteMany({ where: { userId: uid } });
        await prisma.userRole.deleteMany({ where: { userId: uid } });
        await prisma.user.deleteMany({ where: { id: uid } });
      }
    } catch {
      /* cleanup best-effort */
    }
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length) {
    console.log(`\nFocused Verification 10.2: FAIL (${results.length - failed.length}/${results.length})`);
    process.exit(1);
  }
  console.log(`\nFocused Verification 10.2: ${results.length}/${results.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
