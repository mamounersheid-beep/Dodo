/**
 * Gate 10.3 residual — order-bound release, auto-cancel, adjust, cancel_restock, return restock.
 *
 * Requires: DATABASE_URL (+ seed MAIN + Inventory)
 * Run (after build): node dist/inventory.residual.selftest.js
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { ConflictException, HttpException } from "@nestjs/common";
import { OrderStatus, PaymentStatus } from "@dodo/database";
import { hashToken } from "./auth/crypto.util";
import {
  InventoryError,
  StockMovementReason,
  UNPAID_ORDER_TTL_MS,
} from "./inventory/inventory.constants";
import { InventoryService } from "./inventory/inventory.service";
import { OrdersService } from "./orders/orders.service";
import { PrismaService } from "./prisma/prisma.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

const IDS = [
  "R1_release_orderId",
  "R2_release_checkoutKey_preserved",
  "R3_auto_cancel_release",
  "R4_auto_cancel_idempotent",
  "R5_adjust_audit",
  "R6_cancel_restock",
  "R7_cancel_restock_idempotent",
  "R7b_cancel_restock_concurrent",
  "R7c_cancel_restock_shipped_blocked",
  "R7d_unpaid_admin_cancel_blocked",
  "R8_return_restock",
  "R9_return_no_restock",
  "R10_phase1_smoke",
  "R11_convert_smoke",
  "R12_no_public_commerce",
] as const;

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
  console.log("Focused Verification — Inventory 10.3 residual\n");
  const results: Result[] = [];
  let prisma: PrismaService | undefined;
  let inv: InventoryService | undefined;
  let orders: OrdersService | undefined;
  let locationId = "";
  let variantId = "";
  let inventoryId = "";
  const createdOrderIds: string[] = [];
  let actorId = "";

  const run = async (id: (typeof IDS)[number], fn: () => Promise<void>) => {
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

  const resetStock = async (onHand = 20) => {
    await prisma!.reservation.updateMany({
      where: { variantId, locationId, releasedAt: null, convertedAt: null },
      data: { releasedAt: new Date() },
    });
    await prisma!.inventory.update({
      where: { id: inventoryId },
      data: { quantityOnHand: onHand },
    });
  };

  const createPlacedBound = async (opts?: {
    qty?: number;
    placedAt?: Date;
    guest?: boolean;
  }) => {
    const qty = opts?.qty ?? 2;
    const key = ck("r");
    const reserved = await inv!.reserve(key, variantId, locationId, qty);
    const stamp = `${Date.now()}-${randomBytes(2).toString("hex")}`;
    const order = await prisma!.order.create({
      data: {
        orderNumber: `R103-${stamp}`,
        guestEmail: opts?.guest === false ? undefined : `r103-${stamp}@order.invalid`,
        guestAccessTokenHash:
          opts?.guest === false ? undefined : hashToken(randomBytes(16).toString("hex")),
        status: OrderStatus.PLACED,
        paymentStatus: PaymentStatus.PENDING,
        currencyCode: "EUR",
        locale: "de",
        shippingCountryCode: "DE",
        taxMode: "KLEINUNTERNEHMER",
        companyIsKleinunternehmer: true,
        invoiceExemptionTextSnapshot: "§19",
        itemsSubtotal: String(qty * 10),
        shippingTotal: "0",
        grandTotal: String(qty * 10),
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: "0",
        shippingAddressJson: { line1: "R103" },
        billingAddressJson: { line1: "R103" },
        sellerIdentitySnapshotJson: {
          legalName: "R103 UG",
          line1: "Str. 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        placedAt: opts?.placedAt ?? new Date(),
        items: {
          create: [
            {
              variantId,
              skuSnapshot: "R103",
              nameSnapshot: "Residual",
              quantity: qty,
              unitPriceSnapshot: "10",
              lineTotalSnapshot: String(qty * 10),
              weightGramsSnapshot: 100,
            },
          ],
        },
      },
    });
    createdOrderIds.push(order.id);
    await inv!.bind(key, order.id);
    return { orderId: order.id, reservationId: reserved.reservationId, key, qty };
  };

  try {
    prisma = new PrismaService();
    await prisma.$connect();
    inv = new InventoryService(prisma);
    orders = new OrdersService(prisma, inv);

    const location = await prisma.location.findFirst({
      where: { code: "MAIN", isActive: true },
    });
    if (!location) throw new Error("MAIN location missing — seed required");
    locationId = location.id;
    const row = await prisma.inventory.findFirst({ where: { locationId } });
    if (!row) throw new Error("Inventory row missing — seed required");
    variantId = row.variantId;
    inventoryId = row.id;
    const actor = await prisma.user.create({
      data: {
        email: `r103-actor-${Date.now()}@test.local`,
        passwordHash: "x",
        locale: "de",
      },
    });
    actorId = actor.id;
    await resetStock();

    await run("R1_release_orderId", async () => {
      await resetStock();
      const avail0 = await inv!.available(variantId, locationId);
      const bound = await createPlacedBound({ qty: 3 });
      const avail1 = await inv!.available(variantId, locationId);
      if (avail1 !== avail0 - 3) throw new Error(`avail after bind ${avail1}`);
      const out = await inv!.releaseByOrderId(bound.orderId);
      if (out.releasedCount < 1) throw new Error("releasedCount");
      const res = await prisma!.reservation.findUniqueOrThrow({
        where: { id: bound.reservationId },
      });
      if (!res.releasedAt) throw new Error("releasedAt not set");
      const onHand = (
        await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
      ).quantityOnHand;
      if (onHand !== 20) throw new Error("onHand must not change on release");
      const mov = await prisma!.stockMovement.count({
        where: { orderId: bound.orderId },
      });
      if (mov !== 0) throw new Error("release must not write StockMovement");
      const avail2 = await inv!.available(variantId, locationId);
      if (avail2 !== avail0) throw new Error(`avail after release ${avail2}`);
    });

    await run("R2_release_checkoutKey_preserved", async () => {
      await resetStock();
      const key = ck("ck");
      await inv!.reserve(key, variantId, locationId, 1);
      const out = await inv!.release(key);
      if (out.releasedCount !== 1) throw new Error(`released ${out.releasedCount}`);
      const avail = await inv!.available(variantId, locationId);
      if (avail !== 20) throw new Error(`avail ${avail}`);
    });

    await run("R3_auto_cancel_release", async () => {
      await resetStock();
      const old = new Date(Date.now() - UNPAID_ORDER_TTL_MS - 60_000);
      const guest = await createPlacedBound({ qty: 2, placedAt: old, guest: true });
      const regUser = await prisma!.user.create({
        data: {
          email: `r103u-${Date.now()}@test.local`,
          passwordHash: "x",
          locale: "de",
        },
      });
      const key2 = ck("reg");
      await inv!.reserve(key2, variantId, locationId, 1);
      const regOrder = await prisma!.order.create({
        data: {
          orderNumber: `R103R-${Date.now()}`,
          userId: regUser.id,
          status: OrderStatus.PLACED,
          paymentStatus: PaymentStatus.PENDING,
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
          shippingAddressJson: { line1: "x" },
          billingAddressJson: { line1: "x" },
          sellerIdentitySnapshotJson: {
            legalName: "R",
            line1: "1",
            postalCode: "10115",
            city: "Berlin",
            countryCode: "DE",
          },
          placedAt: old,
          items: {
            create: {
              variantId,
              skuSnapshot: "R",
              nameSnapshot: "R",
              quantity: 1,
              unitPriceSnapshot: "10",
              lineTotalSnapshot: "10",
              weightGramsSnapshot: 50,
            },
          },
        },
      });
      createdOrderIds.push(regOrder.id);
      await inv!.bind(key2, regOrder.id);

      const result = await orders!.expireUnpaidPlacedOrders({ now: new Date() });
      if (!result.orderIds.includes(guest.orderId)) throw new Error("guest not expired");
      if (!result.orderIds.includes(regOrder.id)) throw new Error("registered not expired");

      for (const oid of [guest.orderId, regOrder.id]) {
        const o = await prisma!.order.findUniqueOrThrow({ where: { id: oid } });
        if (o.status !== OrderStatus.CANCELLED) throw new Error(`status ${o.status}`);
        if (o.paymentStatus !== PaymentStatus.PENDING) throw new Error("paymentStatus changed");
        const resRows = await prisma!.reservation.findMany({ where: { orderId: oid } });
        if (!resRows.every((r) => r.releasedAt != null)) throw new Error("not released");
        const sales = await prisma!.stockMovement.count({
          where: { orderId: oid, reason: StockMovementReason.SALE },
        });
        if (sales !== 0) throw new Error("sale written on auto-cancel");
      }
      await prisma!.user.delete({ where: { id: regUser.id } }).catch(() => undefined);
    });

    await run("R4_auto_cancel_idempotent", async () => {
      const old = new Date(Date.now() - UNPAID_ORDER_TTL_MS - 60_000);
      const bound = await createPlacedBound({ qty: 1, placedAt: old });
      const a = await orders!.expireUnpaidPlacedOrders({ now: new Date() });
      if (!a.orderIds.includes(bound.orderId)) throw new Error("first expire");
      const b = await orders!.expireUnpaidPlacedOrders({ now: new Date() });
      if (b.orderIds.includes(bound.orderId)) throw new Error("second expire should skip");
      const o = await prisma!.order.findUniqueOrThrow({ where: { id: bound.orderId } });
      if (o.status !== OrderStatus.CANCELLED) throw new Error("status");
    });

    await run("R5_adjust_audit", async () => {
      await resetStock(20);
      const beforeAudits = await prisma!.auditLog.count({
        where: { action: "inventory.adjust", entityId: inventoryId },
      });
      const out = await inv!.adjust({
        variantId,
        locationId,
        delta: 5,
        actorId,
      });
      if (out.quantityOnHand !== 25) throw new Error(`onHand ${out.quantityOnHand}`);
      const mov = await prisma!.stockMovement.findUniqueOrThrow({
        where: { id: out.movementId },
      });
      if (mov.reason !== StockMovementReason.ADJUST || mov.delta !== 5) {
        throw new Error("adjust movement");
      }
      const audits = await prisma!.auditLog.count({
        where: { action: "inventory.adjust", entityId: inventoryId },
      });
      if (audits !== beforeAudits + 1) throw new Error("audit missing");

      try {
        await inv!.adjust({ variantId, locationId, delta: -1000, actorId });
        throw new Error("negative adjust allowed");
      } catch (e) {
        if (errCode(e) !== InventoryError.ADJUST_NEGATIVE_ON_HAND && !(e instanceof ConflictException)) {
          throw e;
        }
      }
    });

    await run("R6_cancel_restock", async () => {
      await resetStock(20);
      const bound = await createPlacedBound({ qty: 4 });
      await inv!.convert(bound.orderId);
      await prisma!.order.update({
        where: { id: bound.orderId },
        data: { status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.PAID },
      });
      const sales = await prisma!.stockMovement.findMany({
        where: { orderId: bound.orderId, reason: StockMovementReason.SALE },
      });
      const saleQty = sales.reduce((s, m) => s + -m.delta, 0);
      if (saleQty !== 4) throw new Error(`sale qty ${saleQty}`);
      const onHandAfterSale = (
        await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
      ).quantityOnHand;
      if (onHandAfterSale !== 16) throw new Error(`after sale ${onHandAfterSale}`);

      const cancel = await orders!.adminCancelPostSale(bound.orderId, actorId);
      if (cancel.status !== OrderStatus.CANCELLED) throw new Error("not cancelled");
      if (cancel.restockedQuantity !== saleQty) {
        throw new Error(`restock qty ${cancel.restockedQuantity} ≠ sale ${saleQty}`);
      }

      const onHand = (
        await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
      ).quantityOnHand;
      if (onHand !== 20) throw new Error(`after restock ${onHand}`);

      const movs = await prisma!.stockMovement.findMany({
        where: { orderId: bound.orderId, reason: StockMovementReason.CANCEL_RESTOCK },
      });
      if (movs.length < 1) throw new Error("cancel_restock movement missing");
      if (movs.reduce((s, m) => s + m.delta, 0) !== saleQty) throw new Error("delta sum");
      if (movs.some((m) => m.orderId !== bound.orderId)) throw new Error("orderId mismatch");
    });

    await run("R7_cancel_restock_idempotent", async () => {
      await resetStock(20);
      const bound = await createPlacedBound({ qty: 2 });
      await inv!.convert(bound.orderId);
      await prisma!.order.update({
        where: { id: bound.orderId },
        data: { status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.PAID },
      });
      await orders!.adminCancelPostSale(bound.orderId, actorId);
      const countAfterFirst = await prisma!.stockMovement.count({
        where: { orderId: bound.orderId, reason: StockMovementReason.CANCEL_RESTOCK },
      });
      const second = await orders!.adminCancelPostSale(bound.orderId, actorId);
      if (!second.idempotent) throw new Error("expected idempotent");
      const countAfterSecond = await prisma!.stockMovement.count({
        where: { orderId: bound.orderId, reason: StockMovementReason.CANCEL_RESTOCK },
      });
      if (countAfterSecond !== countAfterFirst) {
        throw new Error(`second set written: ${countAfterFirst} → ${countAfterSecond}`);
      }
      const onHand = (
        await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
      ).quantityOnHand;
      if (onHand !== 20) throw new Error(`double restock onHand=${onHand}`);
    });

    await run("R7b_cancel_restock_concurrent", async () => {
      await resetStock(20);
      const bound = await createPlacedBound({ qty: 3 });
      await inv!.convert(bound.orderId);
      await prisma!.order.update({
        where: { id: bound.orderId },
        data: { status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.PAID },
      });
      const [a, b] = await Promise.all([
        orders!.adminCancelPostSale(bound.orderId, actorId),
        orders!.adminCancelPostSale(bound.orderId, actorId),
      ]);
      if (a.status !== OrderStatus.CANCELLED || b.status !== OrderStatus.CANCELLED) {
        throw new Error("both must end CANCELLED");
      }
      const movs = await prisma!.stockMovement.findMany({
        where: { orderId: bound.orderId, reason: StockMovementReason.CANCEL_RESTOCK },
      });
      const restocked = movs.reduce((s, m) => s + m.delta, 0);
      if (restocked !== 3) throw new Error(`concurrent restock total ${restocked}`);
      const onHand = (
        await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
      ).quantityOnHand;
      if (onHand !== 20) throw new Error(`concurrent onHand ${onHand}`);
    });

    await run("R7c_cancel_restock_shipped_blocked", async () => {
      await resetStock(20);
      const bound = await createPlacedBound({ qty: 1 });
      await inv!.convert(bound.orderId);
      await prisma!.order.update({
        where: { id: bound.orderId },
        data: { status: OrderStatus.SHIPPED, paymentStatus: PaymentStatus.PAID },
      });
      try {
        await orders!.adminCancelPostSale(bound.orderId, actorId);
        throw new Error("SHIPPED cancel allowed");
      } catch (e) {
        if (!(e instanceof ConflictException) && errCode(e) !== "ORDER_NOT_CANCELLABLE") {
          if (e instanceof Error && e.message === "SHIPPED cancel allowed") throw e;
          if (!(e instanceof ConflictException)) throw e;
        }
      }
      const movs = await prisma!.stockMovement.count({
        where: { orderId: bound.orderId, reason: StockMovementReason.CANCEL_RESTOCK },
      });
      if (movs !== 0) throw new Error("cancel_restock on SHIPPED");
      const o = await prisma!.order.findUniqueOrThrow({ where: { id: bound.orderId } });
      if (o.status !== OrderStatus.SHIPPED) throw new Error(`status ${o.status}`);
    });

    await run("R7d_unpaid_admin_cancel_blocked", async () => {
      await resetStock(20);
      const bound = await createPlacedBound({ qty: 2 });
      try {
        await orders!.adminCancelPostSale(bound.orderId, actorId);
        throw new Error("unpaid admin cancel_restock allowed");
      } catch (e) {
        if (e instanceof Error && e.message === "unpaid admin cancel_restock allowed") throw e;
        if (!(e instanceof ConflictException)) throw e;
      }
      const movs = await prisma!.stockMovement.count({
        where: { orderId: bound.orderId, reason: StockMovementReason.CANCEL_RESTOCK },
      });
      if (movs !== 0) throw new Error("cancel_restock on unpaid");
      const o = await prisma!.order.findUniqueOrThrow({ where: { id: bound.orderId } });
      if (o.status !== OrderStatus.PLACED) throw new Error("unpaid order mutated");
    });

    await run("R8_return_restock", async () => {
      await resetStock(20);
      const returnItemId = `ri-${Date.now()}`;
      const out = await inv!.applyReturnRestock(
        [{ returnItemId, variantId, quantity: 3, restock: true }],
        { actorId },
      );
      if (out.restockedLines !== 1 || out.skippedLines !== 0) throw new Error("lines");
      const onHand = (
        await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
      ).quantityOnHand;
      if (onHand !== 23) throw new Error(`onHand ${onHand}`);
      const again = await inv!.applyReturnRestock(
        [{ returnItemId, variantId, quantity: 3, restock: true }],
        { actorId },
      );
      if (again.restockedLines !== 1) throw new Error("idempotent lines");
      const onHand2 = (
        await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
      ).quantityOnHand;
      if (onHand2 !== 23) throw new Error("double return restock");
    });

    await run("R9_return_no_restock", async () => {
      await resetStock(20);
      const returnItemId = `ri-skip-${Date.now()}`;
      const out = await inv!.applyReturnRestock(
        [{ returnItemId, variantId, quantity: 2, restock: false }],
        { actorId },
      );
      if (out.skippedLines !== 1 || out.restockedLines !== 0) throw new Error("skip");
      const mov = await prisma!.stockMovement.count({
        where: { referenceId: returnItemId, reason: StockMovementReason.RETURN },
      });
      if (mov !== 0) throw new Error("silent restock");
      const onHand = (
        await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
      ).quantityOnHand;
      if (onHand !== 20) throw new Error("onHand changed");
    });

    await run("R10_phase1_smoke", async () => {
      await resetStock(10);
      const key = ck("p1");
      const r = await inv!.reserve(key, variantId, locationId, 2);
      if (r.availableAfter !== 8) throw new Error(`availAfter ${r.availableAfter}`);
      await inv!.release(key);
      if ((await inv!.available(variantId, locationId)) !== 10) throw new Error("release");
    });

    await run("R11_convert_smoke", async () => {
      await resetStock(10);
      const bound = await createPlacedBound({ qty: 1 });
      await inv!.convert(bound.orderId);
      const onHand = (
        await prisma!.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
      ).quantityOnHand;
      if (onHand !== 9) throw new Error(`convert onHand ${onHand}`);
    });

    await run("R12_no_public_commerce", async () => {
      const sk = inv!.skeleton();
      if (sk.commerce !== false) throw new Error("commerce flag");
      // Controller still only exposes _skeleton publicly — Admin adjust is under admin/
    });
  } finally {
    try {
      for (const oid of createdOrderIds) {
        await prisma?.orderStatusHistory.deleteMany({ where: { orderId: oid } });
        await prisma?.stockMovement.deleteMany({ where: { orderId: oid } });
        await prisma?.reservation.deleteMany({ where: { orderId: oid } });
        await prisma?.orderItem.deleteMany({ where: { orderId: oid } });
        await prisma?.order.deleteMany({ where: { id: oid } });
      }
      await prisma?.stockMovement.deleteMany({
        where: { reason: { in: [StockMovementReason.ADJUST, StockMovementReason.RETURN] }, actorId },
      });
      await prisma?.auditLog.deleteMany({
        where: { action: "inventory.adjust", actorId },
      });
      if (inventoryId) {
        await prisma?.inventory.update({
          where: { id: inventoryId },
          data: { quantityOnHand: 20 },
        });
      }
      if (actorId) {
        await prisma?.user.delete({ where: { id: actorId } }).catch(() => undefined);
      }
    } catch {
      /* cleanup best-effort */
    }
    await prisma?.$disconnect();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length) {
    console.log(`\nResidual 10.3: FAIL (${results.length - failed.length}/${results.length})`);
    process.exit(1);
  }
  console.log(`\nResidual 10.3: ${results.length}/${results.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
