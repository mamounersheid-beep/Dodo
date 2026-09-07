/**
 * R2.2-C — CouponUsage release on Order → CANCELLED (C10).
 * SoT: docs/10.5-cart-pricing.md §CouponUsage / C10
 *
 * Requires: DATABASE_URL (+ seed MAIN for inventory bind on cancel paths)
 * Run: pnpm --filter @dodo/api run test:r22c-coupon-release
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import {
  CouponType,
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
  TaxMode,
} from "@dodo/database";
import { hashToken } from "./auth/crypto.util";
import { UNPAID_ORDER_TTL_MS } from "./inventory/inventory.constants";
import { InventoryService } from "./inventory/inventory.service";
import { OrdersService } from "./orders/orders.service";
import { PaymentsService } from "./payments/payments.service";
import { PrismaService } from "./prisma/prisma.service";
import { PayPalFirstAttemptAdapter } from "./payments/paypal.first-attempt.adapter";
import { StripeFirstAttemptAdapter } from "./payments/stripe.first-attempt.adapter";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

const IDS = [
  "C1_placed_auto_cancel_releases",
  "C2_admin_cancel_releases",
  "C3_idempotent_no_second_release",
  "C4_concurrent_once_only",
  "C5_row_retained",
  "C6_released_excluded_from_quota",
  "C7_refund_does_not_release",
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
  console.log("Focused Verification — R2.2-C Coupon Release\n");
  const results: Result[] = [];
  const prisma = new PrismaService();
  await prisma.$connect();
  const inv = new InventoryService(prisma);
  const orders = new OrdersService(prisma, inv);
  const payments = new PaymentsService(
    prisma,
    inv,
    new StripeFirstAttemptAdapter(),
    new PayPalFirstAttemptAdapter(),
  );

  const stamp = `${Date.now()}`;
  const createdOrderIds: string[] = [];
  const createdCouponIds: string[] = [];
  const createdUserIds: string[] = [];
  let locationId = "";
  let variantId = "";
  let inventoryId = "";
  let actorId = "";
  let paymentMethodId = "";

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
  if (!invRow) throw new Error("Inventory missing — seed required");
  variantId = invRow.variantId;
  inventoryId = invRow.id;

  const actor = await prisma.user.create({
    data: {
      email: `r22c_actor_${stamp}@test.local`,
      passwordHash: "x",
      locale: "de",
    },
  });
  actorId = actor.id;
  createdUserIds.push(actor.id);

  const pm = await prisma.paymentMethod.upsert({
    where: { code: "stripe_card" },
    create: { code: "stripe_card", provider: "stripe", isEnabled: true, sortOrder: 1 },
    update: { isEnabled: true },
  });
  paymentMethodId = pm.id;

  const resetStock = async (onHand = 30) => {
    await prisma.reservation.updateMany({
      where: { variantId, locationId, releasedAt: null, convertedAt: null },
      data: { releasedAt: new Date() },
    });
    await prisma.inventory.update({
      where: { id: inventoryId },
      data: { quantityOnHand: onHand },
    });
  };

  const createCoupon = async (opts?: { globalLimit?: number }) => {
    const coupon = await prisma.coupon.create({
      data: {
        code: `R22C_${stamp}_${randomBytes(3).toString("hex")}`.toUpperCase(),
        type: CouponType.FIXED,
        value: new Prisma.Decimal("5.00"),
        usageLimitGlobal: opts?.globalLimit ?? 10,
        validFrom: new Date(Date.now() - 86_400_000),
        isActive: true,
      },
    });
    createdCouponIds.push(coupon.id);
    return coupon;
  };

  const seedOrderWithUsage = async (opts: {
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    placedAt?: Date;
    couponId: string;
    userId?: string | null;
  }) => {
    await resetStock();
    const key = ck("c");
    const qty = 1;
    await inv.reserve(key, variantId, locationId, qty);
    const order = await prisma.order.create({
      data: {
        orderNumber: `R22C-${stamp}-${randomBytes(3).toString("hex")}`,
        userId: opts.userId === undefined ? actorId : opts.userId,
        guestEmail: opts.userId === null ? `g-${stamp}@test.local` : undefined,
        guestAccessTokenHash:
          opts.userId === null ? hashToken(randomBytes(16).toString("hex")) : undefined,
        status: opts.status,
        paymentStatus: opts.paymentStatus,
        currencyCode: "EUR",
        locale: "de",
        shippingCountryCode: "DE",
        taxMode: TaxMode.KLEINUNTERNEHMER,
        companyIsKleinunternehmer: true,
        invoiceExemptionTextSnapshot: "§19",
        itemsSubtotal: "20.00",
        shippingTotal: "0.00",
        discountCoupon: "5.00",
        discountBonus: "0.00",
        grandTotal: "15.00",
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: "0.00",
        shippingAddressJson: { line1: "R22C" },
        billingAddressJson: { line1: "R22C" },
        sellerIdentitySnapshotJson: {
          legalName: "R22C UG",
          line1: "Str 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        couponId: opts.couponId,
        couponCodeSnapshot: "R22C",
        paymentMethodCodeSnapshot: "stripe",
        placedAt: opts.placedAt ?? new Date(),
        confirmedAt:
          opts.status === OrderStatus.CONFIRMED || opts.status === OrderStatus.PROCESSING
            ? new Date()
            : undefined,
        items: {
          create: [
            {
              variantId,
              skuSnapshot: "R22C",
              nameSnapshot: "Coupon release",
              quantity: qty,
              unitPriceSnapshot: "20.00",
              lineTotalSnapshot: "20.00",
              weightGramsSnapshot: 100,
            },
          ],
        },
      },
    });
    createdOrderIds.push(order.id);
    await inv.bind(key, order.id);

    const usage = await prisma.couponUsage.create({
      data: {
        couponId: opts.couponId,
        orderId: order.id,
        userId: opts.userId === undefined ? actorId : opts.userId,
        releasedAt: null,
      },
    });
    return { orderId: order.id, usageId: usage.id, key };
  };

  await resetStock();

  // ── C1 PLACED unpaid auto-cancel ─────────────────────────────────
  await run("C1_placed_auto_cancel_releases", async () => {
    const coupon = await createCoupon();
    const placedAt = new Date(Date.now() - UNPAID_ORDER_TTL_MS - 60_000);
    const s = await seedOrderWithUsage({
      status: OrderStatus.PLACED,
      paymentStatus: PaymentStatus.PENDING,
      placedAt,
      couponId: coupon.id,
    });
    const before = await prisma.couponUsage.findUniqueOrThrow({ where: { id: s.usageId } });
    if (before.releasedAt != null) throw new Error("precondition releasedAt");

    const out = await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    if (!out.orderIds.includes(s.orderId)) throw new Error("order not expired");

    const after = await prisma.couponUsage.findUniqueOrThrow({ where: { id: s.usageId } });
    if (after.releasedAt == null) throw new Error("releasedAt not set");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });
    if (order.status !== OrderStatus.CANCELLED) throw new Error("not CANCELLED");
  });

  // ── C2 Admin Cancel post-sale ────────────────────────────────────
  await run("C2_admin_cancel_releases", async () => {
    const coupon = await createCoupon();
    const s = await seedOrderWithUsage({
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      couponId: coupon.id,
    });
    await inv.convert(s.orderId);
    await orders.adminCancelPostSale(s.orderId, actorId);
    const after = await prisma.couponUsage.findUniqueOrThrow({ where: { id: s.usageId } });
    if (after.releasedAt == null) throw new Error("releasedAt not set");
  });

  // ── C3 idempotent ────────────────────────────────────────────────
  await run("C3_idempotent_no_second_release", async () => {
    const coupon = await createCoupon();
    const s = await seedOrderWithUsage({
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      couponId: coupon.id,
    });
    await inv.convert(s.orderId);
    await orders.adminCancelPostSale(s.orderId, actorId);
    const first = await prisma.couponUsage.findUniqueOrThrow({ where: { id: s.usageId } });
    if (first.releasedAt == null) throw new Error("first release missing");
    const ts = first.releasedAt.getTime();
    await orders.adminCancelPostSale(s.orderId, actorId);
    const second = await prisma.couponUsage.findUniqueOrThrow({ where: { id: s.usageId } });
    if (second.releasedAt!.getTime() !== ts) throw new Error("releasedAt rewritten");
  });

  // ── C4 concurrent ────────────────────────────────────────────────
  await run("C4_concurrent_once_only", async () => {
    const coupon = await createCoupon();
    const s = await seedOrderWithUsage({
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      couponId: coupon.id,
    });
    await inv.convert(s.orderId);
    await Promise.all([
      orders.adminCancelPostSale(s.orderId, actorId),
      orders.adminCancelPostSale(s.orderId, actorId),
    ]);
    const usage = await prisma.couponUsage.findUniqueOrThrow({ where: { id: s.usageId } });
    if (usage.releasedAt == null) throw new Error("not released");
    const count = await prisma.couponUsage.count({ where: { orderId: s.orderId } });
    if (count !== 1) throw new Error(`usage rows ${count}`);
  });

  // ── C5 row retained ──────────────────────────────────────────────
  await run("C5_row_retained", async () => {
    const coupon = await createCoupon();
    const s = await seedOrderWithUsage({
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      couponId: coupon.id,
    });
    await inv.convert(s.orderId);
    await orders.adminCancelPostSale(s.orderId, actorId);
    const row = await prisma.couponUsage.findUnique({ where: { id: s.usageId } });
    if (!row) throw new Error("CouponUsage deleted");
    if (row.releasedAt == null) throw new Error("not released");
    if (row.orderId !== s.orderId || row.couponId !== coupon.id) throw new Error("row corrupted");
  });

  // ── C6 released excluded from active quota ───────────────────────
  await run("C6_released_excluded_from_quota", async () => {
    const coupon = await createCoupon({ globalLimit: 1 });
    const s = await seedOrderWithUsage({
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      couponId: coupon.id,
    });
    const activeBefore = await prisma.couponUsage.count({
      where: { couponId: coupon.id, releasedAt: null },
    });
    if (activeBefore !== 1) throw new Error(`active before ${activeBefore}`);
    await inv.convert(s.orderId);
    await orders.adminCancelPostSale(s.orderId, actorId);
    const activeAfter = await prisma.couponUsage.count({
      where: { couponId: coupon.id, releasedAt: null },
    });
    if (activeAfter !== 0) throw new Error(`active after ${activeAfter}`);
    const totalRows = await prisma.couponUsage.count({ where: { couponId: coupon.id } });
    if (totalRows !== 1) throw new Error("historical row missing");
  });

  // ── C7 Refund does not release ───────────────────────────────────
  await run("C7_refund_does_not_release", async () => {
    const coupon = await createCoupon();
    const s = await seedOrderWithUsage({
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      couponId: coupon.id,
    });
    const payment = await prisma.payment.create({
      data: {
        orderId: s.orderId,
        paymentMethodId,
        provider: "stripe",
        providerIntentId: `pi_r22c_${s.orderId}`,
        amount: new Prisma.Decimal("15.00"),
        currencyCode: "EUR",
        status: PaymentStatus.PAID,
      },
    });
    const refund = await prisma.refund.create({
      data: {
        orderId: s.orderId,
        paymentId: payment.id,
        returnRequestId: null,
        amount: new Prisma.Decimal("15.00"),
        currencyCode: "EUR",
        status: RefundStatus.PENDING,
        reason: "r22c-no-release",
        refundTotal: new Prisma.Decimal("15.00"),
      },
    });
    await payments.markRefundSucceeded(refund.id);
    const usage = await prisma.couponUsage.findUniqueOrThrow({ where: { id: s.usageId } });
    if (usage.releasedAt != null) throw new Error("Refund must not release CouponUsage");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });
    if (order.status === OrderStatus.CANCELLED) throw new Error("order should stay non-CANCELLED");
  });

  // cleanup best-effort
  for (const orderId of createdOrderIds) {
    await prisma.couponUsage.deleteMany({ where: { orderId } });
    await prisma.refund.deleteMany({ where: { orderId } });
    await prisma.payment.deleteMany({ where: { orderId } });
    await prisma.stockMovement.deleteMany({ where: { orderId } });
    await prisma.reservation.deleteMany({ where: { orderId } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId } });
    await prisma.orderItem.deleteMany({ where: { orderId } });
    await prisma.order.delete({ where: { id: orderId } }).catch(() => undefined);
  }
  for (const couponId of createdCouponIds) {
    await prisma.couponUsage.deleteMany({ where: { couponId } });
    await prisma.coupon.delete({ where: { id: couponId } }).catch(() => undefined);
  }
  for (const userId of createdUserIds) {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
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
