/**
 * Production placeOrder Slice 2 — Inventory Phase 1 (test harness).
 *
 * Requires: DATABASE_URL (+ seed Location MAIN + Inventory)
 * Run (after build): node dist/inventory.phase1.selftest.js
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { ConflictException, HttpException } from "@nestjs/common";
import { hashToken } from "./auth/crypto.util";
import {
  CHECKOUT_RESERVATION_TTL_MS,
  InventoryError,
  UNPAID_ORDER_TTL_MS,
} from "./inventory/inventory.constants";
import { InventoryService } from "./inventory/inventory.service";
import { PrismaService } from "./prisma/prisma.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function errCode(e: unknown): string | undefined {
  if (!(e instanceof HttpException)) return undefined;
  const body = e.getResponse();
  if (typeof body === "object" && body && "error" in body) {
    return String((body as { error: string }).error);
  }
  return undefined;
}

function ck(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

async function main() {
  const results: Result[] = [];
  const scenarioIds = [
    "INV1",
    "INV2",
    "INV3",
    "INV4",
    "INV5",
    "INV6",
    "INV7",
    "INV8",
    "INV9",
    "INV10",
    "INV11",
  ] as const;

  let prisma: PrismaService | undefined;
  let svc: InventoryService | undefined;

  let locationId = "";
  let variantId = "";
  let onHandBefore = 0;
  const createdReservationIds: string[] = [];
  const createdOrderIds: string[] = [];
  let movementCountBefore = 0;
  let orderCountBefore = 0;
  let paymentCountBefore = 0;

  const run = async (id: (typeof scenarioIds)[number], fn: () => Promise<void>) => {
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

  try {
    prisma = new PrismaService();
    await prisma.$connect();
    svc = new InventoryService(prisma);

    const location = await prisma.location.findFirst({
      where: { code: "MAIN", isActive: true },
    });
    if (!location) throw new Error("MAIN location missing — seed required");
    locationId = location.id;

    const inv = await prisma.inventory.findFirst({
      where: { locationId },
      include: { variant: true },
    });
    if (!inv) throw new Error("Inventory row missing — seed required");
    variantId = inv.variantId;
    onHandBefore = inv.quantityOnHand;

    // Isolate harness: set known on-hand and clear any leftover active reservations for this variant
    await prisma.reservation.updateMany({
      where: {
        variantId,
        locationId,
        releasedAt: null,
        convertedAt: null,
      },
      data: { releasedAt: new Date() },
    });
    await prisma.inventory.update({
      where: { id: inv.id },
      data: { quantityOnHand: 10 },
    });

    movementCountBefore = await prisma.stockMovement.count({
      where: { inventoryId: inv.id },
    });
    orderCountBefore = await prisma.order.count();
    paymentCountBefore = await prisma.payment.count();

    await run("INV1", async () => {
      const avail = await svc!.available(variantId, locationId);
      if (avail !== 10) throw new Error(`available expected 10 got ${avail}`);
      if (!(await svc!.stockOK(variantId, locationId, 10))) throw new Error("stockOK(10) should be true");
      if (await svc!.stockOK(variantId, locationId, 11)) throw new Error("stockOK(11) should be false");
    });

    await run("INV2", async () => {
      const key = ck("r1");
      const r = await svc!.reserve(key, variantId, locationId, 3);
      createdReservationIds.push(r.reservationId);
      const avail = await svc!.available(variantId, locationId);
      if (avail !== 7) throw new Error(`after reserve available expected 7 got ${avail}`);
      if (r.availableAfter !== 7) throw new Error(`availableAfter expected 7 got ${r.availableAfter}`);
      const ttlMs = r.expiresAt.getTime() - Date.now();
      if (ttlMs < CHECKOUT_RESERVATION_TTL_MS - 5_000 || ttlMs > CHECKOUT_RESERVATION_TTL_MS + 5_000) {
        throw new Error(`reserve TTL out of range: ${ttlMs}`);
      }
      await svc!.release(key);
    });

    await run("INV3", async () => {
      try {
        await svc!.reserve(ck("oversell"), variantId, locationId, 11);
        throw new Error("expected insufficient stock");
      } catch (e) {
        if (errCode(e) !== InventoryError.INSUFFICIENT_STOCK && !(e instanceof ConflictException)) {
          throw e instanceof Error ? e : new Error(String(e));
        }
        if (errCode(e) !== InventoryError.INSUFFICIENT_STOCK) {
          throw new Error(`expected INSUFFICIENT_STOCK got ${errCode(e)}`);
        }
      }
      const avail = await svc!.available(variantId, locationId);
      if (avail !== 10) throw new Error(`available should remain 10 got ${avail}`);
    });

    await run("INV4", async () => {
      // Concurrent oversell: onHand=10, 20 parallel reserves of qty=1 with distinct keys
      const keys = Array.from({ length: 20 }, (_, i) => ck(`c${i}`));
      const settled = await Promise.allSettled(
        keys.map((key) => svc!.reserve(key, variantId, locationId, 1)),
      );
      const ok = settled.filter((s) => s.status === "fulfilled");
      const rejected = settled.filter((s) => s.status === "rejected");
      for (const s of ok) {
        if (s.status === "fulfilled") createdReservationIds.push(s.value.reservationId);
      }
      if (ok.length !== 10) {
        throw new Error(`expected exactly 10 successful reserves, got ${ok.length}`);
      }
      if (rejected.length !== 10) {
        throw new Error(`expected 10 rejections, got ${rejected.length}`);
      }
      for (const s of rejected) {
        if (s.status !== "rejected") continue;
        if (errCode(s.reason) !== InventoryError.INSUFFICIENT_STOCK) {
          throw new Error(`concurrent reject code=${errCode(s.reason)}`);
        }
      }
      const avail = await svc!.available(variantId, locationId);
      if (avail !== 0) throw new Error(`available after concurrent expected 0 got ${avail}`);

      const activeSum = await prisma!.reservation.aggregate({
        where: {
          variantId,
          locationId,
          releasedAt: null,
          convertedAt: null,
          expiresAt: { gt: new Date() },
        },
        _sum: { quantity: true },
      });
      if ((activeSum._sum.quantity ?? 0) !== 10) {
        throw new Error(`active reserved sum expected 10 got ${activeSum._sum.quantity}`);
      }

      for (const key of keys) {
        await svc!.release(key);
      }
      const avail2 = await svc!.available(variantId, locationId);
      if (avail2 !== 10) throw new Error(`after release all available expected 10 got ${avail2}`);
    });

    await run("INV5", async () => {
      const key = ck("upd");
      const a = await svc!.reserve(key, variantId, locationId, 2);
      createdReservationIds.push(a.reservationId);
      const b = await svc!.reserve(key, variantId, locationId, 4);
      if (b.reservationId !== a.reservationId) {
        throw new Error("repeated reserve must update same row");
      }
      const rows = await prisma!.reservation.count({
        where: { checkoutKey: key, variantId, locationId },
      });
      if (rows !== 1) throw new Error(`expected 1 row got ${rows}`);
      const avail = await svc!.available(variantId, locationId);
      if (avail !== 6) throw new Error(`available expected 6 got ${avail}`);
      await svc!.release(key);
    });

    await run("INV6", async () => {
      const key = ck("rel");
      await svc!.reserve(key, variantId, locationId, 5);
      const beforeOnHand = (
        await prisma!.inventory.findUniqueOrThrow({
          where: { locationId_variantId: { locationId, variantId } },
        })
      ).quantityOnHand;
      const movBefore = await prisma!.stockMovement.count({
        where: { inventory: { locationId, variantId } },
      });
      const { releasedCount } = await svc!.release(key);
      if (releasedCount !== 1) throw new Error(`releasedCount expected 1 got ${releasedCount}`);
      const avail = await svc!.available(variantId, locationId);
      if (avail !== 10) throw new Error(`available after release expected 10 got ${avail}`);
      const afterOnHand = (
        await prisma!.inventory.findUniqueOrThrow({
          where: { locationId_variantId: { locationId, variantId } },
        })
      ).quantityOnHand;
      if (afterOnHand !== beforeOnHand) {
        throw new Error("release must not change quantityOnHand");
      }
      const movAfter = await prisma!.stockMovement.count({
        where: { inventory: { locationId, variantId } },
      });
      if (movAfter !== movBefore) throw new Error("release must not create StockMovement");
    });

    await run("INV7", async () => {
      const key = ck("bind");
      const reserved = await svc!.reserve(key, variantId, locationId, 2);
      createdReservationIds.push(reserved.reservationId);

      const order = await prisma!.order.create({
        data: {
          orderNumber: `INV-B-${Date.now()}-${randomBytes(2).toString("hex")}`,
          guestEmail: `inv-bind-${Date.now()}@order.invalid`,
          guestAccessTokenHash: hashToken(randomBytes(16).toString("hex")),
          status: "PLACED",
          paymentStatus: "PENDING",
          currencyCode: "EUR",
          locale: "de",
          shippingCountryCode: "DE",
          taxMode: "KLEINUNTERNEHMER",
          companyIsKleinunternehmer: true,
          invoiceExemptionTextSnapshot: "§19",
          itemsSubtotal: "10",
          shippingTotal: "0",
          grandTotal: "10",
          shippingMethodCodeSnapshot: "standard",
          shippingStandardAmountSnapshot: "0",
          shippingAddressJson: { line1: "Inv Bind" },
          billingAddressJson: { line1: "Inv Bind" },
          sellerIdentitySnapshotJson: {
            legalName: "Inv Bind UG",
            line1: "Bind Str. 1",
            postalCode: "10115",
            city: "Berlin",
            countryCode: "DE",
          },
          items: {
            create: [
              {
                variantId,
                skuSnapshot: "INV-BIND",
                nameSnapshot: "Bind",
                quantity: 2,
                unitPriceSnapshot: "5",
                lineTotalSnapshot: "10",
                weightGramsSnapshot: 100,
              },
            ],
          },
        },
      });
      createdOrderIds.push(order.id);

      const bound = await svc!.bind(key, order.id);
      if (bound.boundCount !== 1) throw new Error(`boundCount expected 1 got ${bound.boundCount}`);

      const row = await prisma!.reservation.findUniqueOrThrow({
        where: { id: reserved.reservationId },
      });
      if (row.orderId !== order.id) throw new Error("bind must set orderId");
      if (row.checkoutKey !== null) throw new Error("bind must clear checkoutKey");
      if (row.convertedAt !== null) throw new Error("bind must not convert");
      if (row.releasedAt !== null) throw new Error("bind must not release");

      const ttlMs = row.expiresAt.getTime() - Date.now();
      if (ttlMs < UNPAID_ORDER_TTL_MS - 60_000 || ttlMs > UNPAID_ORDER_TTL_MS + 60_000) {
        throw new Error(`bind TTL out of range: ${ttlMs}`);
      }

      const onHand = (
        await prisma!.inventory.findUniqueOrThrow({
          where: { locationId_variantId: { locationId, variantId } },
        })
      ).quantityOnHand;
      if (onHand !== 10) throw new Error("bind must not change quantityOnHand");

      // release bound via releasedAt for cleanup (simulate unpaid release by id)
      await prisma!.reservation.update({
        where: { id: row.id },
        data: { releasedAt: new Date() },
      });
    });

    await run("INV8", async () => {
      // covered in INV7 — checkoutKey invalidated
      const key = ck("gone");
      await svc!.reserve(key, variantId, locationId, 1);
      const order = await prisma!.order.create({
        data: {
          orderNumber: `INV-K-${Date.now()}-${randomBytes(2).toString("hex")}`,
          guestEmail: `inv-key-${Date.now()}@order.invalid`,
          guestAccessTokenHash: hashToken(randomBytes(16).toString("hex")),
          status: "PLACED",
          paymentStatus: "PENDING",
          currencyCode: "EUR",
          locale: "de",
          shippingCountryCode: "DE",
          taxMode: "KLEINUNTERNEHMER",
          companyIsKleinunternehmer: true,
          itemsSubtotal: "1",
          shippingTotal: "0",
          grandTotal: "1",
          shippingMethodCodeSnapshot: "standard",
          shippingStandardAmountSnapshot: "0",
          shippingAddressJson: {},
          billingAddressJson: {},
          sellerIdentitySnapshotJson: {
            legalName: "X",
            line1: "Y",
            postalCode: "1",
            city: "Z",
            countryCode: "DE",
          },
          items: {
            create: [
              {
                variantId,
                skuSnapshot: "K",
                nameSnapshot: "K",
                quantity: 1,
                unitPriceSnapshot: "1",
                lineTotalSnapshot: "1",
                weightGramsSnapshot: 100,
              },
            ],
          },
        },
      });
      createdOrderIds.push(order.id);
      await svc!.bind(key, order.id);
      const still = await prisma!.reservation.findFirst({ where: { checkoutKey: key } });
      if (still) throw new Error("checkoutKey must not remain on any reservation");
      await prisma!.reservation.updateMany({
        where: { orderId: order.id, releasedAt: null },
        data: { releasedAt: new Date() },
      });
    });

    await run("INV9", async () => {
      // no sale/conversion already asserted in INV7; ensure no StockMovement since suite start for this inventory
      const mov = await prisma!.stockMovement.count({
        where: { inventory: { locationId, variantId } },
      });
      if (mov !== movementCountBefore) {
        throw new Error(`StockMovement count changed: before=${movementCountBefore} after=${mov}`);
      }
    });

    await run("INV10", async () => {
      const orders = await prisma!.order.count();
      const payments = await prisma!.payment.count();
      // Orders created only as bind fixtures — no placeOrder / payment / email path
      if (payments !== paymentCountBefore) {
        throw new Error("Payment side effect detected");
      }
      if (orders < orderCountBefore) throw new Error("unexpected order count drop");
      // fixture orders are expected; no Payment rows
    });

    await run("INV11", async () => {
      // final available restored
      const avail = await svc!.available(variantId, locationId);
      if (avail !== 10) throw new Error(`final available expected 10 got ${avail}`);
    });
  } catch (e) {
    for (const id of scenarioIds) {
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
      if (prisma) {
        // Release any leftover actives for this variant from harness
        await prisma.reservation.updateMany({
          where: {
            variantId,
            locationId,
            releasedAt: null,
            convertedAt: null,
          },
          data: { releasedAt: new Date() },
        });
        if (variantId && locationId) {
          await prisma.inventory.update({
            where: { locationId_variantId: { locationId, variantId } },
            data: { quantityOnHand: onHandBefore },
          });
        }
        // Delete fixture orders (items cascade? OrderItem — check onDelete)
        for (const id of createdOrderIds) {
          await prisma.orderItem.deleteMany({ where: { orderId: id } });
          await prisma.reservation.updateMany({
            where: { orderId: id },
            data: { orderId: null, releasedAt: new Date() },
          });
          await prisma.order.delete({ where: { id } }).catch(() => undefined);
        }
      }
    } catch (restoreErr) {
      console.error("restore failed", restoreErr);
    }
    await prisma?.$disconnect();
  }

  printSummary(results);
  const failed = results.some((r) => r.status !== "PASS");
  if (failed || results.length !== scenarioIds.length) process.exit(1);
  console.log("\nSlice 2 Inventory Phase 1: ALL PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
