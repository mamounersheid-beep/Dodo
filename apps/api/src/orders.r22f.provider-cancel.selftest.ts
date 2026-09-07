/**
 * R2.2-F — Provider payment intent cancel after unpaid Order → CANCELLED.
 * SoT: docs/10.9-payments-webhooks.md §2c
 *
 * Requires: DATABASE_URL (+ seed MAIN)
 * Run: pnpm --filter @dodo/api run test:r22f-provider-cancel
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { OrderStatus, PaymentStatus, TaxMode } from "@dodo/database";
import { hashToken } from "./auth/crypto.util";
import { UNPAID_ORDER_TTL_MS } from "./inventory/inventory.constants";
import { InventoryService } from "./inventory/inventory.service";
import { OrdersService } from "./orders/orders.service";
import { InMemoryFirstAttemptProviders } from "./payments/in-memory.first-attempt.providers";
import { PaymentsService } from "./payments/payments.service";
import { PayPalFirstAttemptAdapter } from "./payments/paypal.first-attempt.adapter";
import { StripeFirstAttemptAdapter } from "./payments/stripe.first-attempt.adapter";
import { PrismaService } from "./prisma/prisma.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

const IDS = [
  "F1_unpaid_cancel_commits",
  "F2_provider_after_commit",
  "F3_success_audited",
  "F4_provider_failure_keeps_cancelled",
  "F5_already_canceled_safe",
  "F6_reentry_no_duplicate_call",
  "F7_paid_admin_cancel_skips",
  "F8_no_intent_skipped",
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
  console.log("Focused Verification — R2.2-F Provider Intent Cancel\n");
  const results: Result[] = [];
  const prisma = new PrismaService();
  await prisma.$connect();

  const memory = new InMemoryFirstAttemptProviders();
  const inv = new InventoryService(prisma);
  const payments = new PaymentsService(
    prisma,
    inv,
    new StripeFirstAttemptAdapter(),
    new PayPalFirstAttemptAdapter(),
    memory,
  );
  const orders = new OrdersService(prisma, inv, payments);

  const stamp = `${Date.now()}`;
  const createdOrderIds: string[] = [];
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
  if (!invRow) throw new Error("Inventory missing");
  variantId = invRow.variantId;
  inventoryId = invRow.id;

  const actor = await prisma.user.create({
    data: {
      email: `r22f_actor_${stamp}@test.local`,
      passwordHash: "x",
      locale: "de",
    },
  });
  actorId = actor.id;

  const pm = await prisma.paymentMethod.upsert({
    where: { code: "stripe_card" },
    create: { code: "stripe_card", provider: "stripe", isEnabled: true, sortOrder: 1 },
    update: { isEnabled: true },
  });
  paymentMethodId = pm.id;

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

  const seedUnpaidPlaced = async (opts?: {
    withIntent?: boolean;
    providerIntentId?: string;
  }) => {
    await resetStock();
    memory.reset();
    memory.stripeCancelMode = "ok";
    const key = ck("f");
    await inv.reserve(key, variantId, locationId, 1);
    const order = await prisma.order.create({
      data: {
        orderNumber: `R22F-${stamp}-${randomBytes(3).toString("hex")}`,
        guestEmail: `f-${stamp}-${randomBytes(2).toString("hex")}@test.local`,
        guestAccessTokenHash: hashToken(randomBytes(16).toString("hex")),
        status: OrderStatus.PLACED,
        paymentStatus: PaymentStatus.PENDING,
        currencyCode: "EUR",
        locale: "de",
        shippingCountryCode: "DE",
        taxMode: TaxMode.KLEINUNTERNEHMER,
        companyIsKleinunternehmer: true,
        invoiceExemptionTextSnapshot: "§19",
        itemsSubtotal: "10.00",
        shippingTotal: "0.00",
        discountCoupon: "0.00",
        discountBonus: "0.00",
        grandTotal: "10.00",
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: "0.00",
        shippingAddressJson: { line1: "R22F" },
        billingAddressJson: { line1: "R22F" },
        sellerIdentitySnapshotJson: {
          legalName: "R22F UG",
          line1: "Str 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        paymentMethodCodeSnapshot: "stripe",
        placedAt: new Date(Date.now() - UNPAID_ORDER_TTL_MS - 60_000),
        items: {
          create: [
            {
              variantId,
              skuSnapshot: "R22F",
              nameSnapshot: "Provider cancel",
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
    await inv.bind(key, order.id);

    let paymentId: string | null = null;
    let intentId: string | null = null;
    if (opts?.withIntent !== false) {
      intentId = opts?.providerIntentId ?? `pi_r22f_${order.id}`;
      // Register in memory so cancelOpenIntent finds it
      const created = await memory.adapters()[0].createOrRecover({
        orderId: order.id,
        amount: "10.00",
        currencyCode: "EUR",
        idempotencyKey: `dodo:first-intent:${order.id}`,
      });
      intentId = created.providerIntentId;
      const payment = await prisma.payment.create({
        data: {
          orderId: order.id,
          paymentMethodId,
          provider: "stripe",
          providerIntentId: intentId,
          amount: "10.00",
          currencyCode: "EUR",
          status: PaymentStatus.PENDING,
        },
      });
      paymentId = payment.id;
    }
    return { orderId: order.id, paymentId, intentId };
  };

  // ── F1 unpaid cancel commits ─────────────────────────────────────
  await run("F1_unpaid_cancel_commits", async () => {
    const s = await seedUnpaidPlaced();
    const out = await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 20 });
    if (!out.orderIds.includes(s.orderId)) throw new Error("not expired");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });
    if (order.status !== OrderStatus.CANCELLED) throw new Error("not CANCELLED");
  });

  // ── F2 provider called only after CANCELLED committed ────────────
  await run("F2_provider_after_commit", async () => {
    const s = await seedUnpaidPlaced();
    let statusAtCancelCall: OrderStatus | null = null;
    memory.onCancelOpenIntent = async () => {
      const o = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });
      statusAtCancelCall = o.status;
    };
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 20 });
    memory.onCancelOpenIntent = undefined;
    if (statusAtCancelCall !== OrderStatus.CANCELLED) {
      throw new Error(`cancel called while status=${statusAtCancelCall}`);
    }
    if (memory.cancelCalls < 1) throw new Error("cancel not called");
  });

  // ── F3 success audited ───────────────────────────────────────────
  await run("F3_success_audited", async () => {
    const s = await seedUnpaidPlaced();
    memory.stripeCancelMode = "ok";
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 20 });
    const audit = await prisma.auditLog.findFirst({
      where: {
        action: "provider_payment_cancel_attempt",
        entityType: "Payment",
        entityId: s.paymentId!,
      },
      orderBy: { createdAt: "desc" },
    });
    if (!audit) throw new Error("audit missing");
    const after = audit.afterJson as { outcome?: string; provider?: string; providerIntentId?: string };
    if (after.outcome !== "succeeded") throw new Error(`outcome ${after.outcome}`);
    if (after.provider !== "stripe") throw new Error("provider");
    if (!after.providerIntentId) throw new Error("intent id");
  });

  // ── F4 provider failure keeps CANCELLED ──────────────────────────
  await run("F4_provider_failure_keeps_cancelled", async () => {
    const s = await seedUnpaidPlaced();
    memory.stripeCancelMode = "network_failure";
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 20 });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });
    if (order.status !== OrderStatus.CANCELLED) throw new Error("rolled back CANCELLED");
    const audit = await prisma.auditLog.findFirst({
      where: {
        action: "provider_payment_cancel_attempt",
        entityId: s.paymentId!,
      },
      orderBy: { createdAt: "desc" },
    });
    const after = audit?.afterJson as { outcome?: string };
    if (after?.outcome !== "network_failure") throw new Error(`outcome ${after?.outcome}`);
  });

  // ── F5 already canceled / not_cancellable ─────────────────────────
  await run("F5_already_canceled_safe", async () => {
    const s = await seedUnpaidPlaced();
    memory.stripeCancelMode = "already_canceled";
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 20 });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });
    if (order.status !== OrderStatus.CANCELLED) throw new Error("not CANCELLED");
    const audit = await prisma.auditLog.findFirst({
      where: { action: "provider_payment_cancel_attempt", entityId: s.paymentId! },
      orderBy: { createdAt: "desc" },
    });
    const after = audit?.afterJson as { outcome?: string };
    if (after?.outcome !== "not_cancellable") throw new Error(`outcome ${after?.outcome}`);
  });

  // ── F6 re-entry does not duplicate provider call ─────────────────
  await run("F6_reentry_no_duplicate_call", async () => {
    const s = await seedUnpaidPlaced();
    memory.stripeCancelMode = "ok";
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 20 });
    const callsAfterFirst = memory.cancelCalls;
    // Re-run expiry — order already CANCELLED, should not re-expire, and attempt not re-invoked
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 20 });
    // Also explicit re-entry of attempt (simulates safe re-call)
    const second = await payments.attemptProviderCancelAfterUnpaidOrderCancel(s.orderId);
    if (memory.cancelCalls !== callsAfterFirst) {
      throw new Error(`duplicate cancel calls ${memory.cancelCalls} vs ${callsAfterFirst}`);
    }
    if (second.audited !== false) throw new Error("should skip re-audit");
    const audits = await prisma.auditLog.count({
      where: { action: "provider_payment_cancel_attempt", entityId: s.paymentId! },
    });
    if (audits !== 1) throw new Error(`audit rows ${audits}`);
  });

  // ── F7 paid Admin Cancel does not invoke R2.2-F ──────────────────
  await run("F7_paid_admin_cancel_skips", async () => {
    await resetStock();
    memory.reset();
    const key = ck("paid");
    await inv.reserve(key, variantId, locationId, 1);
    const order = await prisma.order.create({
      data: {
        orderNumber: `R22F-P-${stamp}-${randomBytes(2).toString("hex")}`,
        userId: actorId,
        status: OrderStatus.PLACED,
        paymentStatus: PaymentStatus.PENDING,
        currencyCode: "EUR",
        locale: "de",
        shippingCountryCode: "DE",
        taxMode: TaxMode.KLEINUNTERNEHMER,
        companyIsKleinunternehmer: true,
        invoiceExemptionTextSnapshot: "§19",
        itemsSubtotal: "10.00",
        shippingTotal: "0.00",
        discountCoupon: "0.00",
        discountBonus: "0.00",
        grandTotal: "10.00",
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: "0.00",
        shippingAddressJson: { line1: "R22F" },
        billingAddressJson: { line1: "R22F" },
        sellerIdentitySnapshotJson: {
          legalName: "R22F UG",
          line1: "Str 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        paymentMethodCodeSnapshot: "stripe",
        items: {
          create: [
            {
              variantId,
              skuSnapshot: "R22F",
              nameSnapshot: "Paid cancel",
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
    await inv.bind(key, order.id);
    await inv.convert(order.id);
    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.PAID },
    });
    const created = await memory.adapters()[0].createOrRecover({
      orderId: order.id,
      amount: "10.00",
      currencyCode: "EUR",
      idempotencyKey: `dodo:first-intent:${order.id}`,
    });
    await prisma.payment.create({
      data: {
        orderId: order.id,
        paymentMethodId,
        provider: "stripe",
        providerIntentId: created.providerIntentId,
        amount: "10.00",
        currencyCode: "EUR",
        status: PaymentStatus.PAID,
      },
    });
    const cancelCallsBefore = memory.cancelCalls;
    await orders.adminCancelPostSale(order.id, actorId);
    if (memory.cancelCalls !== cancelCallsBefore) {
      throw new Error("R2.2-F invoked on paid Admin Cancel");
    }
    const audits = await prisma.auditLog.count({
      where: {
        action: "provider_payment_cancel_attempt",
        entityId: order.id,
      },
    });
    // Also check Payment entity audits for this order's payments
    const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
    for (const p of payments) {
      const n = await prisma.auditLog.count({
        where: { action: "provider_payment_cancel_attempt", entityId: p.id },
      });
      if (n !== 0) throw new Error("audit on paid cancel");
    }
    void audits;
  });

  // ── F8 no providerIntentId → skipped ─────────────────────────────
  await run("F8_no_intent_skipped", async () => {
    const s = await seedUnpaidPlaced({ withIntent: false });
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 20 });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });
    if (order.status !== OrderStatus.CANCELLED) throw new Error("not CANCELLED");
    if (memory.cancelCalls !== 0) throw new Error("adapter called without intent");
    const audit = await prisma.auditLog.findFirst({
      where: {
        action: "provider_payment_cancel_attempt",
        entityType: "Order",
        entityId: s.orderId,
      },
      orderBy: { createdAt: "desc" },
    });
    const after = audit?.afterJson as { outcome?: string };
    if (after?.outcome !== "skipped") throw new Error(`outcome ${after?.outcome}`);
  });

  // cleanup
  for (const orderId of createdOrderIds) {
    const pays = await prisma.payment.findMany({ where: { orderId } });
    for (const p of pays) {
      await prisma.auditLog.deleteMany({
        where: { action: "provider_payment_cancel_attempt", entityId: p.id },
      });
    }
    await prisma.auditLog.deleteMany({
      where: { action: "provider_payment_cancel_attempt", entityId: orderId },
    });
    await prisma.refund.deleteMany({ where: { orderId } });
    await prisma.payment.deleteMany({ where: { orderId } });
    await prisma.stockMovement.deleteMany({ where: { orderId } });
    await prisma.reservation.deleteMany({ where: { orderId } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId } });
    await prisma.couponUsage.deleteMany({ where: { orderId } });
    await prisma.orderItem.deleteMany({ where: { orderId } });
    await prisma.order.delete({ where: { id: orderId } }).catch(() => undefined);
  }
  await prisma.user.delete({ where: { id: actorId } }).catch(() => undefined);

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
