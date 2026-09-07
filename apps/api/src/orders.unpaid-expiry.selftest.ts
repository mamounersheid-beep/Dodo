/**
 * Focused Verification — Auto-Cancel unpaid / UNPAID_ORDER_TTL (#4)
 * Complements inventory.residual (R3/R4), R2.2-C (C1), R2.2-F (F1–F8).
 *
 * Requires: DATABASE_URL (+ seed MAIN)
 * Run (after build): node dist/orders.unpaid-expiry.selftest.js
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { OrderStatus, PaymentStatus, TaxMode } from "@dodo/database";
import { hashToken } from "./auth/crypto.util";
import { StockMovementReason, UNPAID_ORDER_TTL_MS } from "./inventory/inventory.constants";
import { InventoryService } from "./inventory/inventory.service";
import { OrdersService } from "./orders/orders.service";
import { PrismaService } from "./prisma/prisma.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

const IDS = [
  "U1_within_ttl_skipped",
  "U2_paid_not_expired",
  "U3_failed_past_ttl_expires",
  "U4_no_cancel_restock_on_unpaid",
  "U5_concurrent_expire_once",
] as const;

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function ck(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

async function main() {
  console.log("Focused Verification — Unpaid Order Auto-Cancel (#4)\n");
  const results: Result[] = [];
  const prisma = new PrismaService();
  await prisma.$connect();
  const inv = new InventoryService(prisma);
  const orders = new OrdersService(prisma, inv);

  const stamp = `${Date.now()}`;
  const createdOrderIds: string[] = [];
  let locationId = "";
  let variantId = "";
  let inventoryId = "";

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

  const location = await prisma.location.findFirst({
    where: { code: "MAIN", isActive: true },
  });
  if (!location) throw new Error("MAIN location missing — seed required");
  locationId = location.id;
  const invRow = await prisma.inventory.findFirst({ where: { locationId } });
  if (!invRow) throw new Error("Inventory missing");
  variantId = invRow.variantId;
  inventoryId = invRow.id;

  const resetStock = async () => {
    await prisma.reservation.updateMany({
      where: { variantId, locationId, releasedAt: null, convertedAt: null },
      data: { releasedAt: new Date() },
    });
    await prisma.inventory.update({
      where: { id: inventoryId },
      data: { quantityOnHand: 40 },
    });
  };

  const seedPlaced = async (opts: {
    placedAt: Date;
    paymentStatus?: PaymentStatus;
    status?: OrderStatus;
  }) => {
    await resetStock();
    const key = ck("u");
    await inv.reserve(key, variantId, locationId, 1);
    const order = await prisma.order.create({
      data: {
        orderNumber: `U4-${stamp}-${randomBytes(3).toString("hex")}`,
        guestEmail: `u4-${stamp}-${randomBytes(2).toString("hex")}@test.local`,
        guestAccessTokenHash: hashToken(randomBytes(16).toString("hex")),
        status: opts.status ?? OrderStatus.PLACED,
        paymentStatus: opts.paymentStatus ?? PaymentStatus.PENDING,
        currencyCode: "EUR",
        locale: "de",
        shippingCountryCode: "DE",
        taxMode: TaxMode.KLEINUNTERNEHMER,
        companyIsKleinunternehmer: true,
        invoiceExemptionTextSnapshot: "§19",
        itemsSubtotal: "10.00",
        shippingTotal: "0.00",
        grandTotal: "10.00",
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: "0.00",
        shippingAddressJson: { line1: "U4" },
        billingAddressJson: { line1: "U4" },
        sellerIdentitySnapshotJson: {
          legalName: "U4 UG",
          line1: "Str 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        placedAt: opts.placedAt,
        items: {
          create: [
            {
              variantId,
              skuSnapshot: "U4",
              nameSnapshot: "Unpaid expiry",
              quantity: 1,
              unitPriceSnapshot: "10.00",
              lineTotalSnapshot: "10.00",
              weightGramsSnapshot: 100,
            },
          ],
        },
      },
    });
    createdOrderIds.push(order.id);
    if (opts.status === OrderStatus.PLACED || opts.status === undefined) {
      await inv.bind(key, order.id);
    } else {
      await prisma.reservation.updateMany({
        where: { checkoutKey: key },
        data: { releasedAt: new Date() },
      });
    }
    return order.id;
  };

  // U1 — still within UNPAID_ORDER_TTL → not cancelled
  await run("U1_within_ttl_skipped", async () => {
    const id = await seedPlaced({ placedAt: new Date() });
    const out = await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    if (out.orderIds.includes(id)) throw new Error("fresh order expired");
    const o = await prisma.order.findUniqueOrThrow({ where: { id } });
    if (o.status !== OrderStatus.PLACED) throw new Error(`status ${o.status}`);
  });

  // U2 — PAID (even if old placedAt) not in unpaid auto-cancel path
  await run("U2_paid_not_expired", async () => {
    const old = new Date(Date.now() - UNPAID_ORDER_TTL_MS - 60_000);
    const id = await seedPlaced({
      placedAt: old,
      paymentStatus: PaymentStatus.PAID,
      status: OrderStatus.CONFIRMED,
    });
    const out = await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    if (out.orderIds.includes(id)) throw new Error("PAID/CONFIRMED expired");
    const o = await prisma.order.findUniqueOrThrow({ where: { id } });
    if (o.status !== OrderStatus.CONFIRMED) throw new Error(`status ${o.status}`);
  });

  // U3 — FAILED past TTL is eligible (same unpaid window as PENDING)
  await run("U3_failed_past_ttl_expires", async () => {
    const old = new Date(Date.now() - UNPAID_ORDER_TTL_MS - 60_000);
    const id = await seedPlaced({
      placedAt: old,
      paymentStatus: PaymentStatus.FAILED,
    });
    const out = await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    if (!out.orderIds.includes(id)) throw new Error("FAILED unpaid not expired");
    const o = await prisma.order.findUniqueOrThrow({ where: { id } });
    if (o.status !== OrderStatus.CANCELLED) throw new Error(`status ${o.status}`);
    if (o.paymentStatus !== PaymentStatus.FAILED) throw new Error("paymentStatus mutated");
  });

  // U4 — unpaid auto-cancel uses release, never cancel_restock
  await run("U4_no_cancel_restock_on_unpaid", async () => {
    const old = new Date(Date.now() - UNPAID_ORDER_TTL_MS - 60_000);
    const id = await seedPlaced({ placedAt: old });
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    const restock = await prisma.stockMovement.count({
      where: { orderId: id, reason: StockMovementReason.CANCEL_RESTOCK },
    });
    if (restock !== 0) throw new Error("cancel_restock on unpaid auto-cancel");
    const sales = await prisma.stockMovement.count({
      where: { orderId: id, reason: StockMovementReason.SALE },
    });
    if (sales !== 0) throw new Error("sale on unpaid auto-cancel");
    const res = await prisma.reservation.findMany({ where: { orderId: id } });
    if (!res.length || !res.every((r) => r.releasedAt != null)) {
      throw new Error("reservation not released");
    }
  });

  // U5 — concurrent expire sweeps do not double-cancel / double history
  await run("U5_concurrent_expire_once", async () => {
    const old = new Date(Date.now() - UNPAID_ORDER_TTL_MS - 60_000);
    const id = await seedPlaced({ placedAt: old });
    const [a, b] = await Promise.all([
      orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 }),
      orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 }),
    ]);
    const hits = [a, b].filter((x) => x.orderIds.includes(id)).length;
    if (hits !== 1) throw new Error(`expire hits ${hits}`);
    const hist = await prisma.orderStatusHistory.count({
      where: {
        orderId: id,
        fromStatus: OrderStatus.PLACED,
        toStatus: OrderStatus.CANCELLED,
        actorType: "SYSTEM",
      },
    });
    if (hist !== 1) throw new Error(`history rows ${hist}`);
    const o = await prisma.order.findUniqueOrThrow({ where: { id } });
    if (o.status !== OrderStatus.CANCELLED) throw new Error("not CANCELLED");
  });

  for (const orderId of createdOrderIds) {
    await prisma.stockMovement.deleteMany({ where: { orderId } });
    await prisma.reservation.deleteMany({ where: { orderId } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId } });
    await prisma.couponUsage.deleteMany({ where: { orderId } });
    await prisma.payment.deleteMany({ where: { orderId } });
    await prisma.orderItem.deleteMany({ where: { orderId } });
    await prisma.order.delete({ where: { id: orderId } }).catch(() => undefined);
  }

  await prisma.$disconnect();
  printSummary(results);
  const failed = results.filter((r) => r.status === "FAIL").length;
  if (failed > 0) process.exit(1);
  console.log(`\n${results.length}/${results.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
