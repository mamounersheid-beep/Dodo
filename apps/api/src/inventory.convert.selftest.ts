/**
 * InventoryService.convert — 10.3 convert(orderId, tx)
 *
 * Requires: DATABASE_URL (+ seed Location MAIN + Inventory)
 * Run (after build): node dist/inventory.convert.selftest.js
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import { hashToken } from "./auth/crypto.util";
import { InventoryError } from "./inventory/inventory.constants";
import { InventoryService } from "./inventory/inventory.service";
import { PrismaService } from "./prisma/prisma.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

const IDS = ["CONV1", "CONV2", "CONV3", "CONV4", "CONV5", "CONV6", "CONV7"] as const;

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
  let prisma: PrismaService | undefined;
  let svc: InventoryService | undefined;
  let locationId = "";
  let variantId = "";
  let inventoryId = "";
  let onHandBefore = 0;
  const createdOrderIds: string[] = [];
  const createdReservationIds: string[] = [];

  const run = async (id: (typeof IDS)[number], fn: () => Promise<void>) => {
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

  const resetStock = async () => {
    await prisma!.reservation.updateMany({
      where: {
        variantId,
        locationId,
        releasedAt: null,
        convertedAt: null,
      },
      data: { releasedAt: new Date() },
    });
    await prisma!.inventory.update({
      where: { id: inventoryId },
      data: { quantityOnHand: 10 },
    });
  };

  const createBound = async (qty: number) => {
    const key = ck("cv");
    const reserved = await svc!.reserve(key, variantId, locationId, qty);
    createdReservationIds.push(reserved.reservationId);
    const order = await prisma!.order.create({
      data: {
        orderNumber: `CV-${Date.now()}-${randomBytes(2).toString("hex")}`,
        guestEmail: `inv-convert-${Date.now()}@order.invalid`,
        guestAccessTokenHash: hashToken(randomBytes(16).toString("hex")),
        status: "PLACED",
        paymentStatus: "PENDING",
        currencyCode: "EUR",
        locale: "de",
        shippingCountryCode: "DE",
        taxMode: "KLEINUNTERNEHMER",
        companyIsKleinunternehmer: true,
        invoiceExemptionTextSnapshot: "§19",
        itemsSubtotal: String(qty),
        shippingTotal: "0",
        grandTotal: String(qty),
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: "0",
        shippingAddressJson: { line1: "Inv Convert" },
        billingAddressJson: { line1: "Inv Convert" },
        sellerIdentitySnapshotJson: {
          legalName: "Inv Convert UG",
          line1: "Convert Str. 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        items: {
          create: [
            {
              variantId,
              skuSnapshot: "INV-CV",
              nameSnapshot: "Convert",
              quantity: qty,
              unitPriceSnapshot: "1",
              lineTotalSnapshot: String(qty),
              weightGramsSnapshot: 100,
            },
          ],
        },
      },
    });
    createdOrderIds.push(order.id);
    await svc!.bind(key, order.id);
    return { orderId: order.id, reservationId: reserved.reservationId, qty };
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
    });
    if (!inv) throw new Error("Inventory row missing — seed required");
    variantId = inv.variantId;
    inventoryId = inv.id;
    onHandBefore = inv.quantityOnHand;

    await resetStock();

    await run("CONV1", async () => {
      await resetStock();
      const movBefore = await prisma!.stockMovement.count({
        where: { inventoryId, reason: "sale" },
      });
      const bound = await createBound(3);
      const out = await svc!.convert(bound.orderId);
      if (out.convertedCount !== 1) throw new Error(`convertedCount expected 1 got ${out.convertedCount}`);

      const row = await prisma!.reservation.findUniqueOrThrow({
        where: { id: bound.reservationId },
      });
      if (row.convertedAt == null) throw new Error("convertedAt must be set");
      if (row.releasedAt != null) throw new Error("convert must not set releasedAt");

      const onHand = (
        await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
      ).quantityOnHand;
      if (onHand !== 7) throw new Error(`quantityOnHand expected 7 got ${onHand}`);

      const avail = await svc!.available(variantId, locationId);
      if (avail !== 7) throw new Error(`available expected 7 got ${avail}`);

      const movements = await prisma!.stockMovement.findMany({
        where: { inventoryId, orderId: bound.orderId, reason: "sale" },
      });
      if (movements.length !== 1) throw new Error(`expected 1 sale movement got ${movements.length}`);
      if (movements[0].delta !== -3) throw new Error(`delta expected -3 got ${movements[0].delta}`);
      if (movements[0].orderId !== bound.orderId) throw new Error("sale movement must tie orderId");

      const saleCount = await prisma!.stockMovement.count({
        where: { inventoryId, reason: "sale" },
      });
      if (saleCount !== movBefore + 1) throw new Error("unexpected extra sale movements");
    });

    await run("CONV2", async () => {
      await resetStock();
      const order = await prisma!.order.create({
        data: {
          orderNumber: `CV-MISS-${Date.now()}-${randomBytes(2).toString("hex")}`,
          guestEmail: `inv-convert-miss-${Date.now()}@order.invalid`,
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
        },
      });
      createdOrderIds.push(order.id);
      const onHand = (await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } }))
        .quantityOnHand;
      const mov = await prisma!.stockMovement.count({ where: { inventoryId } });
      try {
        await svc!.convert(order.id);
        throw new Error("expected missing reservation");
      } catch (e) {
        if (!(e instanceof NotFoundException) || errCode(e) !== InventoryError.RESERVATION_NOT_FOUND) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
      const onHandAfter = (await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } }))
        .quantityOnHand;
      if (onHandAfter !== onHand) throw new Error("missing convert must not change on-hand");
      const movAfter = await prisma!.stockMovement.count({ where: { inventoryId } });
      if (movAfter !== mov) throw new Error("missing convert must not write StockMovement");
    });

    await run("CONV3", async () => {
      await resetStock();
      const bound = await createBound(2);
      await prisma!.reservation.update({
        where: { id: bound.reservationId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const onHand = 10;
      const mov = await prisma!.stockMovement.count({
        where: { inventoryId, orderId: bound.orderId },
      });
      try {
        await svc!.convert(bound.orderId);
        throw new Error("expected expired reservation");
      } catch (e) {
        if (!(e instanceof ConflictException) || errCode(e) !== InventoryError.RESERVATION_NOT_ACTIVE) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
      const row = await prisma!.reservation.findUniqueOrThrow({ where: { id: bound.reservationId } });
      if (row.convertedAt != null) throw new Error("expired convert must not set convertedAt");
      const onHandAfter = (await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } }))
        .quantityOnHand;
      if (onHandAfter !== onHand) throw new Error("expired convert must not change on-hand");
      const movAfter = await prisma!.stockMovement.count({
        where: { inventoryId, orderId: bound.orderId },
      });
      if (movAfter !== mov) throw new Error("expired convert must not write sale");
    });

    await run("CONV4", async () => {
      await resetStock();
      const bound = await createBound(2);
      await prisma!.reservation.update({
        where: { id: bound.reservationId },
        data: { releasedAt: new Date() },
      });
      try {
        await svc!.convert(bound.orderId);
        throw new Error("expected released reservation");
      } catch (e) {
        if (!(e instanceof ConflictException) || errCode(e) !== InventoryError.RESERVATION_NOT_ACTIVE) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
      const row = await prisma!.reservation.findUniqueOrThrow({ where: { id: bound.reservationId } });
      if (row.convertedAt != null) throw new Error("released convert must not set convertedAt");
      const onHandAfter = (await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } }))
        .quantityOnHand;
      if (onHandAfter !== 10) throw new Error("released convert must not change on-hand");
    });

    await run("CONV5", async () => {
      await resetStock();
      const bound = await createBound(5);
      await prisma!.inventory.update({
        where: { id: inventoryId },
        data: { quantityOnHand: 4 },
      });
      const mov = await prisma!.stockMovement.count({
        where: { inventoryId, orderId: bound.orderId },
      });
      try {
        await svc!.convert(bound.orderId);
        throw new Error("expected insufficient on-hand");
      } catch (e) {
        if (!(e instanceof ConflictException) || errCode(e) !== InventoryError.INSUFFICIENT_STOCK) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
      const row = await prisma!.reservation.findUniqueOrThrow({ where: { id: bound.reservationId } });
      if (row.convertedAt != null) throw new Error("unsafe convert must not set convertedAt");
      const onHandAfter = (await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } }))
        .quantityOnHand;
      if (onHandAfter !== 4) throw new Error("unsafe convert must not decrement on-hand");
      const movAfter = await prisma!.stockMovement.count({
        where: { inventoryId, orderId: bound.orderId },
      });
      if (movAfter !== mov) throw new Error("unsafe convert must not write sale");
    });

    await run("CONV6", async () => {
      await resetStock();
      const bound = await createBound(2);
      await svc!.convert(bound.orderId);
      const onHand = (await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } }))
        .quantityOnHand;
      const mov = await prisma!.stockMovement.count({
        where: { inventoryId, orderId: bound.orderId, reason: "sale" },
      });
      if (mov !== 1) throw new Error("first convert must write exactly one sale");
      try {
        await svc!.convert(bound.orderId);
        throw new Error("expected already-converted refusal");
      } catch (e) {
        if (!(e instanceof ConflictException) || errCode(e) !== InventoryError.RESERVATION_NOT_ACTIVE) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
      const onHandAfter = (await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } }))
        .quantityOnHand;
      if (onHandAfter !== onHand) throw new Error("repeat convert must not decrement again");
      const movAfter = await prisma!.stockMovement.count({
        where: { inventoryId, orderId: bound.orderId, reason: "sale" },
      });
      if (movAfter !== 1) throw new Error("repeat convert must not write a second sale");
    });

    await run("CONV7", async () => {
      await resetStock();
      const bound = await createBound(3);
      const movBefore = await prisma!.stockMovement.count({
        where: { inventoryId, orderId: bound.orderId },
      });
      try {
        await prisma!.$transaction(async (tx) => {
          const out = await svc!.convert(bound.orderId, tx);
          if (out.convertedCount !== 1) {
            throw new Error(`convertedCount expected 1 got ${out.convertedCount}`);
          }
          const inner = await tx.reservation.findUniqueOrThrow({
            where: { id: bound.reservationId },
          });
          if (inner.convertedAt == null) throw new Error("tx convert must set convertedAt inside caller tx");
          const innerInv = await tx.inventory.findUniqueOrThrow({ where: { id: inventoryId } });
          if (innerInv.quantityOnHand !== 7) throw new Error("tx convert must decrement inside caller tx");
          throw new Error("CONV7_ROLLBACK");
        });
        throw new Error("expected transaction abort");
      } catch (e) {
        if (!(e instanceof Error) || e.message !== "CONV7_ROLLBACK") {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
      const row = await prisma!.reservation.findUniqueOrThrow({ where: { id: bound.reservationId } });
      if (row.convertedAt != null) throw new Error("aborted tx must roll back convertedAt");
      const onHandAfter = (await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } }))
        .quantityOnHand;
      if (onHandAfter !== 10) throw new Error("aborted tx must roll back quantityOnHand");
      const movAfter = await prisma!.stockMovement.count({
        where: { inventoryId, orderId: bound.orderId },
      });
      if (movAfter !== movBefore) throw new Error("aborted tx must roll back StockMovement");
    });
  } catch (e) {
    for (const id of IDS) {
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
        await prisma.reservation.updateMany({
          where: {
            variantId,
            locationId,
            releasedAt: null,
            convertedAt: null,
          },
          data: { releasedAt: new Date() },
        });
        if (inventoryId) {
          await prisma.inventory.update({
            where: { id: inventoryId },
            data: { quantityOnHand: onHandBefore },
          });
        }
        for (const id of createdOrderIds) {
          await prisma.stockMovement.deleteMany({ where: { orderId: id } });
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
  if (failed || results.length !== IDS.length) process.exit(1);
  console.log("\nInventory convert: ALL PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
