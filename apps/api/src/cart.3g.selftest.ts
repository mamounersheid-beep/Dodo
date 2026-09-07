/**
 * Execute 3g — CartRecalcResponse.deliveryTime on POST /v1/cart/recalculate.
 *
 * Requires: DATABASE_URL (+ seed MAIN inventory + DE shipping + processing/transit values)
 * Run (after build): node dist/cart.3g.selftest.js
 *
 * Scenarios:
 *   3g-1  — both sources known → present, V1 3–7 Werktage, isPreview true
 *   3g-2  — exact property names / no G3 snapshot fields
 *   3g-3  — processing NULL → omitted, recalculate still 200
 *   3g-4  — processing min>max → omitted, 200
 *   3g-5  — transit min>max → omitted, 200
 *   3g-6  — stored 0 is valid
 *   3g-7  — merge / CartState / GET cart / item add have no deliveryTime
 *   3g-8  — 4xx recalculate has no deliveryTime
 *   3g-9  — no Order / deliveryTimeDisclosureSnapshot write
 *   3g-10 — FREE_SHIPPING still reads the 3c-selected rate
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser = require("cookie-parser");
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { CouponType, Prisma } from "@dodo/database";
import type { CartDeliveryTimePreview, CartRecalcResponse } from "@dodo/shared-types";
import { Cart3bTestAppModule, cart3bEmailCalls } from "./cart.3b-test.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { PrismaService } from "./prisma/prisma.service";
import { GUEST_KEY_HEADER } from "./cart/cart.types";
import type { CartMergeResponse, CartStateResponse } from "./cart/cart.types";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };
type HttpResult = { status: number; body: unknown };

const EN_DASH = "\u2013";
const SHAPE_KEYS = [
  "disclosureLevel",
  "isPreview",
  "labelShown",
  "deliveryTimeDaysMax",
  "deliveryTimeDaysMin",
  "processingDaysMax",
  "processingDaysMin",
  "transitDaysMax",
  "transitDaysMin",
] as const;

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
  opts?: { bearer?: string; guestKey?: string; json?: unknown },
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
          ...(opts?.guestKey ? { [GUEST_KEY_HEADER]: opts.guestKey } : {}),
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

function asCart(body: unknown): CartStateResponse {
  return body as CartStateResponse;
}

function asRecalc(body: unknown): CartRecalcResponse {
  return body as CartRecalcResponse;
}

function assertOmitted(body: CartRecalcResponse): void {
  const obj = body as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, "deliveryTime")) {
    throw new Error(`deliveryTime must be omitted, got ${JSON.stringify(obj.deliveryTime)}`);
  }
}

function assertPreview(dt: CartDeliveryTimePreview | undefined): CartDeliveryTimePreview {
  if (!dt) throw new Error("deliveryTime missing");
  return dt;
}

function assertShape(dt: CartDeliveryTimePreview): void {
  const keys = Object.keys(dt).sort();
  const expected = [...SHAPE_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`shape keys [${keys.join(",")}] != [${expected.join(",")}]`);
  }
  if (dt.disclosureLevel !== "composite") throw new Error("disclosureLevel");
  if (dt.isPreview !== true) throw new Error("isPreview");
  if (
    "locale" in dt ||
    "sources" in dt ||
    "shippingRateId" in dt ||
    "lieferzeitDaysMin" in dt ||
    "lieferzeitDaysMax" in dt
  ) {
    throw new Error("G3/snapshot fields must not appear on cart deliveryTime");
  }
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const ids = [
    "3g-1",
    "3g-2",
    "3g-3",
    "3g-4",
    "3g-5",
    "3g-6",
    "3g-7",
    "3g-8",
    "3g-9",
    "3g-10",
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

  const app = await NestFactory.create(Cart3bTestAppModule, { logger: false });
  app.setGlobalPrefix("v1");
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0);
  const server = app.getHttpServer() as Server;
  const prisma = app.get(PrismaService);

  const createdCartIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdCouponIds: string[] = [];
  let variantId = "";
  let productId = "";
  let invId = "";
  let rateId = "";
  let onHandBefore = 0;
  let priceBefore: Prisma.Decimal | null = null;
  let processingMinBefore: number | null = null;
  let processingMaxBefore: number | null = null;
  let transitMinBefore = 0;
  let transitMaxBefore = 0;

  const guestKey = () => `gk_3g_${stamp}_${randomBytes(4).toString("hex")}`;
  const userEmail = () => `g3g_${stamp}_${randomBytes(4).toString("hex")}@test.local`;

  const restoreSources = async () => {
    await prisma.companySettings.update({
      where: { id: "default" },
      data: {
        orderProcessingDaysMin: processingMinBefore,
        orderProcessingDaysMax: processingMaxBefore,
      },
    });
    if (rateId) {
      await prisma.shippingRate.update({
        where: { id: rateId },
        data: {
          estimatedTransitDaysMin: transitMinBefore,
          estimatedTransitDaysMax: transitMaxBefore,
        },
      });
    }
  };

  try {
    const inv = await prisma.inventory.findFirst({
      include: { location: true, variant: { include: { product: true } } },
    });
    if (!inv || inv.location.code !== "MAIN") {
      throw new Error("MAIN inventory + variant required — seed");
    }
    invId = inv.id;
    variantId = inv.variantId;
    productId = inv.variant.productId;
    onHandBefore = inv.quantityOnHand;
    priceBefore = inv.variant.price;

    const company = await prisma.companySettings.findUnique({ where: { id: "default" } });
    if (!company) throw new Error("CompanySettings default required");
    processingMinBefore = company.orderProcessingDaysMin;
    processingMaxBefore = company.orderProcessingDaysMax;

    const method = await prisma.shippingMethod.findUnique({ where: { code: "standard" } });
    const zone = await prisma.shippingZone.findFirst({ where: { countryCode: "DE" } });
    if (!method || !zone) throw new Error("DE standard shipping required");
    const rate = await prisma.shippingRate.findFirst({
      where: { zoneId: zone.id, methodId: method.id },
    });
    if (!rate) throw new Error("DE ShippingRate required");
    rateId = rate.id;
    transitMinBefore = rate.estimatedTransitDaysMin;
    transitMaxBefore = rate.estimatedTransitDaysMax;

    await prisma.inventory.update({ where: { id: invId }, data: { quantityOnHand: 50 } });
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { isActive: true, price: new Prisma.Decimal("19.99") },
    });
    await prisma.product.update({ where: { id: productId }, data: { isActive: true } });
    await prisma.companySettings.update({
      where: { id: "default" },
      data: { orderProcessingDaysMin: 1, orderProcessingDaysMax: 3 },
    });
    await prisma.shippingRate.update({
      where: { id: rateId },
      data: { estimatedTransitDaysMin: 2, estimatedTransitDaysMax: 4 },
    });

    cart3bEmailCalls.reset();

    const addItem = (bearer?: string, gk?: string, qty = 1) =>
      call(server, "POST", "/v1/cart/items", {
        bearer,
        guestKey: gk,
        json: { variantId, quantity: qty },
      });

    const recalc = (
      opts: { bearer?: string; gk?: string },
      body?: Record<string, unknown>,
    ) =>
      call(server, "POST", "/v1/cart/recalculate", {
        bearer: opts.bearer,
        guestKey: opts.gk,
        json: body,
      });

    const seedCart = async () => {
      const gk = guestKey();
      createdCartIds.push(asCart((await call(server, "GET", "/v1/cart", { guestKey: gk })).body).id);
      await addItem(undefined, gk);
      return gk;
    };

    await run("3g-1", async () => {
      const gk = await seedCart();
      const res = await recalc({ gk }, { shippingCountryCode: "DE" });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecalc(res.body);
      if (typeof body.grandTotal !== "string") throw new Error("grandTotal missing");
      const dt = assertPreview(body.deliveryTime);
      if (dt.processingDaysMin !== 1 || dt.processingDaysMax !== 3) {
        throw new Error(`processing ${dt.processingDaysMin}/${dt.processingDaysMax}`);
      }
      if (dt.transitDaysMin !== 2 || dt.transitDaysMax !== 4) {
        throw new Error(`transit ${dt.transitDaysMin}/${dt.transitDaysMax}`);
      }
      if (dt.deliveryTimeDaysMin !== 3 || dt.deliveryTimeDaysMax !== 7) {
        throw new Error(`composite ${dt.deliveryTimeDaysMin}/${dt.deliveryTimeDaysMax}`);
      }
      if (dt.labelShown !== `Lieferzeit: 3${EN_DASH}7 Werktage`) {
        throw new Error(`labelShown ${JSON.stringify(dt.labelShown)}`);
      }
      if (dt.isPreview !== true) throw new Error("isPreview");
      if (dt.disclosureLevel !== "composite") throw new Error("disclosureLevel");
    });

    await run("3g-2", async () => {
      const gk = await seedCart();
      const res = await recalc({ gk }, { shippingCountryCode: "DE" });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      assertShape(assertPreview(asRecalc(res.body).deliveryTime));
    });

    await run("3g-3", async () => {
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { orderProcessingDaysMin: null, orderProcessingDaysMax: null },
      });
      try {
        const gk = await seedCart();
        const res = await recalc({ gk }, { shippingCountryCode: "DE" });
        if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
        const body = asRecalc(res.body);
        if (typeof body.grandTotal !== "string") throw new Error("recalculate failed");
        assertOmitted(body);
      } finally {
        await prisma.companySettings.update({
          where: { id: "default" },
          data: { orderProcessingDaysMin: 1, orderProcessingDaysMax: 3 },
        });
      }
    });

    await run("3g-4", async () => {
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { orderProcessingDaysMin: 5, orderProcessingDaysMax: 2 },
      });
      try {
        const gk = await seedCart();
        const res = await recalc({ gk }, { shippingCountryCode: "DE" });
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        assertOmitted(asRecalc(res.body));
      } finally {
        await prisma.companySettings.update({
          where: { id: "default" },
          data: { orderProcessingDaysMin: 1, orderProcessingDaysMax: 3 },
        });
      }
    });

    await run("3g-5", async () => {
      await prisma.shippingRate.update({
        where: { id: rateId },
        data: { estimatedTransitDaysMin: 9, estimatedTransitDaysMax: 1 },
      });
      try {
        const gk = await seedCart();
        const res = await recalc({ gk }, { shippingCountryCode: "DE" });
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        assertOmitted(asRecalc(res.body));
      } finally {
        await prisma.shippingRate.update({
          where: { id: rateId },
          data: { estimatedTransitDaysMin: 2, estimatedTransitDaysMax: 4 },
        });
      }
    });

    await run("3g-6", async () => {
      await prisma.companySettings.update({
        where: { id: "default" },
        data: { orderProcessingDaysMin: 0, orderProcessingDaysMax: 0 },
      });
      await prisma.shippingRate.update({
        where: { id: rateId },
        data: { estimatedTransitDaysMin: 0, estimatedTransitDaysMax: 0 },
      });
      try {
        const gk = await seedCart();
        const res = await recalc({ gk }, { shippingCountryCode: "DE" });
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const dt = assertPreview(asRecalc(res.body).deliveryTime);
        if (dt.processingDaysMin !== 0 || dt.transitDaysMin !== 0) {
          throw new Error("zero must be valid");
        }
        if (dt.deliveryTimeDaysMin !== 0 || dt.deliveryTimeDaysMax !== 0) {
          throw new Error("zero composite");
        }
        if (dt.labelShown !== `Lieferzeit: 0${EN_DASH}0 Werktage`) {
          throw new Error(`labelShown ${JSON.stringify(dt.labelShown)}`);
        }
      } finally {
        await prisma.companySettings.update({
          where: { id: "default" },
          data: { orderProcessingDaysMin: 1, orderProcessingDaysMax: 3 },
        });
        await prisma.shippingRate.update({
          where: { id: rateId },
          data: { estimatedTransitDaysMin: 2, estimatedTransitDaysMax: 4 },
        });
      }
    });

    await run("3g-7", async () => {
      const email = userEmail();
      const reg = await call(server, "POST", "/v1/auth/register", {
        json: { email, password: "Pass1234!", locale: "de" },
      });
      if (reg.status !== 200 && reg.status !== 201) {
        throw new Error(`register ${reg.status}`);
      }
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) throw new Error("user missing");
      createdUserIds.push(user.id);
      const bearer = (reg.body as { accessToken?: string }).accessToken;
      if (!bearer) throw new Error("no accessToken");

      const gk = await seedCart();
      const added = await addItem(undefined, gk);
      const state = asCart(added.body);
      if (Object.prototype.hasOwnProperty.call(state, "deliveryTime")) {
        throw new Error("CartState addItem must not include deliveryTime");
      }
      const got = await call(server, "GET", "/v1/cart", { guestKey: gk });
      if (Object.prototype.hasOwnProperty.call(got.body as object, "deliveryTime")) {
        throw new Error("GET /v1/cart must not include deliveryTime");
      }
      const merged = await call(server, "POST", "/v1/cart/merge", { bearer, guestKey: gk });
      if (merged.status !== 200) throw new Error(`merge ${merged.status} ${JSON.stringify(merged.body)}`);
      const mergeBody = merged.body as CartMergeResponse & { deliveryTime?: unknown };
      if (Object.prototype.hasOwnProperty.call(mergeBody, "deliveryTime")) {
        throw new Error("merge must not include deliveryTime");
      }
      if (mergeBody.id) createdCartIds.push(mergeBody.id);
    });

    await run("3g-8", async () => {
      const gk = await seedCart();
      const res = await recalc({ gk }, {});
      if (res.status === 200) throw new Error("missing country must 4xx");
      if (Object.prototype.hasOwnProperty.call(res.body as object, "deliveryTime")) {
        throw new Error("4xx must not include deliveryTime");
      }
    });

    await run("3g-9", async () => {
      const gk = await seedCart();
      cart3bEmailCalls.reset();
      const beforeOrders = await prisma.order.count();
      const res = await recalc({ gk }, { shippingCountryCode: "DE" });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      assertPreview(asRecalc(res.body).deliveryTime);
      if ((await prisma.order.count()) !== beforeOrders) throw new Error("Order written");
      if (cart3bEmailCalls.orderConfirmation !== 0) throw new Error("email side effect");
    });

    await run("3g-10", async () => {
      const gk = await seedCart();
      const fsCode = `G3G_FS_${stamp}`;
      const coupon = await prisma.coupon.create({
        data: {
          code: fsCode,
          type: CouponType.FREE_SHIPPING,
          value: new Prisma.Decimal(0),
          validFrom: new Date("2020-01-01"),
          isActive: true,
        },
      });
      createdCouponIds.push(coupon.id);
      const res = await recalc({ gk }, { shippingCountryCode: "DE", couponCode: fsCode });
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`);
      const body = asRecalc(res.body);
      if (body.shippingTotal !== "0.00") throw new Error(`shippingTotal ${body.shippingTotal}`);
      const dt = assertPreview(body.deliveryTime);
      if (dt.transitDaysMin !== 2 || dt.transitDaysMax !== 4) {
        throw new Error("FREE_SHIPPING must still use selected-rate transit");
      }
      if (dt.deliveryTimeDaysMin !== 3 || dt.deliveryTimeDaysMax !== 7) {
        throw new Error("FREE_SHIPPING composite");
      }
    });
  } catch (e) {
    for (const id of ids) {
      if (!results.some((r) => r.id === id)) {
        results.push({
          id,
          status: "BLOCKED",
          note: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    try {
      await restoreSources();
      for (const cartId of createdCartIds) {
        await prisma.cartItem.deleteMany({ where: { cartId } });
        await prisma.cart.delete({ where: { id: cartId } }).catch(() => undefined);
      }
      for (const id of createdCouponIds) {
        await prisma.coupon.delete({ where: { id } }).catch(() => undefined);
      }
      for (const userId of createdUserIds) {
        await prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
        await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      }
      if (invId) {
        await prisma.inventory.update({
          where: { id: invId },
          data: { quantityOnHand: onHandBefore },
        });
      }
      if (variantId && priceBefore) {
        await prisma.productVariant.update({
          where: { id: variantId },
          data: { isActive: true, price: priceBefore },
        });
      }
    } catch {
      /* best-effort cleanup */
    }
    await app.close();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    process.exitCode = 1;
  } else {
    console.log(`\nExecute 3g deliveryTime: ${results.length}/${ids.length} PASS`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
