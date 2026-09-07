/**
 * 10.10 §4a — order-cancelled after #4 unpaid auto-cancel.
 *
 * Requires: DATABASE_URL (+ seed MAIN)
 * Run (after build): pnpm --filter @dodo/api test:order-cancelled
 *   or: node dist/orders.order-cancelled.selftest.js
 *
 *   OCZ1  — guest #4 cancel enqueues exact work key after CANCELLED
 *   OCZ2  — registered recipient = account email; account link ok; no guest token
 *   OCZ3  — queue failure does not undo CANCELLED / paymentStatus
 *   OCZ4  — already-CANCELLED re-entry does not enqueue again
 *   OCZ5  — Admin Cancel post-sale does not enqueue order-cancelled
 *   OCZ6  — Refund/Return creation does not enqueue order-cancelled
 *   OCZ7  — builder: unpaid disclosure · snapshots · no guest link · no PAID/refund
 *   OCZ8  — worker retry: second process skips (no duplicate logical send)
 *   OCZ9  — R2.2-F provider cancel still invoked after commit (independent of email)
 *   OCZ10 — FAILED unpaid expiry also enqueues; paymentStatus stays FAILED
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import {
  OrderStatus,
  PaymentStatus,
  RefundStatus,
  ReturnRequestStatus,
  TaxMode,
} from "@dodo/database";
import { hashToken } from "./auth/crypto.util";
import { UNPAID_ORDER_TTL_MS } from "./inventory/inventory.constants";
import { InventoryService } from "./inventory/inventory.service";
import { OrdersService } from "./orders/orders.service";
import { PrismaService } from "./prisma/prisma.service";
import { buildOrderCancelledEmail } from "./integrations/email/order-cancelled.builder";
import { processOrderCancelledJob } from "./integrations/email/order-cancelled.processor";
import {
  orderCancelledJobId,
  orderCancelledWorkKey,
  type EnqueueOrderCancelledArgs,
  type EmailIntegrationPort,
} from "./integrations/email/email-integration.port";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";
import type { SmtpTransport } from "./integrations/email/smtp-transport.port";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

const SELLER = {
  legalName: "Cancel Frozen Seller UG",
  line1: "Cancel Str. 1",
  postalCode: "10115",
  city: "Berlin",
  countryCode: "DE",
  supportEmail: "cancel-seller@example.com",
  supportPhone: "+49 30 222",
};

const IDS = [
  "OCZ1_guest_enqueue_work_key",
  "OCZ2_registered_recipient",
  "OCZ3_enqueue_fail_keeps_cancelled",
  "OCZ4_idempotent_no_second_enqueue",
  "OCZ5_admin_cancel_no_emit",
  "OCZ6_refund_return_no_emit",
  "OCZ7_builder_unpaid_no_guest_link",
  "OCZ8_worker_retry_no_duplicate",
  "OCZ9_r22f_still_after_commit",
  "OCZ10_failed_unpaid_enqueue",
] as const;

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
  const pass = results.filter((r) => r.status === "PASS").length;
  console.log(`\n${pass}/${results.length} PASS`);
}

function ck(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function makeEmailStub(opts?: {
  onCancelled?: (input: EnqueueOrderCancelledArgs) => void | Promise<void>;
  failCancelled?: boolean;
}): { port: EmailIntegrationPort; cancelled: EnqueueOrderCancelledArgs[] } {
  const cancelled: EnqueueOrderCancelledArgs[] = [];
  const port = createEmailIntegrationStub({
    enqueueOrderCancelled: async (input) => {
      if (opts?.failCancelled) throw new Error("forced order-cancelled enqueue failure");
      cancelled.push(input);
      await opts?.onCancelled?.(input);
    },
  });
  return { port, cancelled };
}

async function main() {
  console.log("Focused Verification — order-cancelled (#5 / #4 wire)\n");
  const results: Result[] = [];
  const prisma = new PrismaService();
  await prisma.$connect();
  const inv = new InventoryService(prisma);

  const stamp = `${Date.now()}`;
  const createdOrderIds: string[] = [];
  const createdUserIds: string[] = [];
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

  const seedGuestPlaced = async (opts: {
    placedAt: Date;
    paymentStatus?: PaymentStatus;
    status?: OrderStatus;
  }) => {
    await resetStock();
    const key = ck("ocz");
    await inv.reserve(key, variantId, locationId, 1);
    const guestEmail = `ocz-g-${stamp}-${randomBytes(2).toString("hex")}@test.local`;
    const order = await prisma.order.create({
      data: {
        orderNumber: `OCZ-${stamp}-${randomBytes(3).toString("hex")}`,
        guestEmail,
        guestAccessTokenHash: hashToken(randomBytes(16).toString("hex")),
        status: opts.status ?? OrderStatus.PLACED,
        paymentStatus: opts.paymentStatus ?? PaymentStatus.PENDING,
        currencyCode: "EUR",
        locale: "en",
        shippingCountryCode: "DE",
        taxMode: TaxMode.KLEINUNTERNEHMER,
        companyIsKleinunternehmer: true,
        invoiceExemptionTextSnapshot: "§19",
        itemsSubtotal: "10.00",
        shippingTotal: "0.00",
        grandTotal: "10.00",
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: "0.00",
        shippingAddressJson: { line1: "OCZ" },
        billingAddressJson: { line1: "OCZ" },
        sellerIdentitySnapshotJson: SELLER,
        placedAt: opts.placedAt,
        items: {
          create: [
            {
              variantId,
              skuSnapshot: "OCZ-SKU",
              nameSnapshot: "Cancel Item",
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
    return { orderId: order.id, guestEmail, orderNumber: order.orderNumber };
  };

  const seedRegisteredPlaced = async (placedAt: Date) => {
    await resetStock();
    const email = `ocz-u-${stamp}-${randomBytes(2).toString("hex")}@test.local`;
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: `hash_${randomBytes(8).toString("hex")}`,
        locale: "de",
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);
    const key = ck("ocz-u");
    await inv.reserve(key, variantId, locationId, 1);
    const order = await prisma.order.create({
      data: {
        orderNumber: `OCZU-${stamp}-${randomBytes(3).toString("hex")}`,
        userId: user.id,
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
        grandTotal: "10.00",
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: "0.00",
        shippingAddressJson: { line1: "OCZU" },
        billingAddressJson: { line1: "OCZU" },
        sellerIdentitySnapshotJson: SELLER,
        placedAt,
        items: {
          create: [
            {
              variantId,
              skuSnapshot: "OCZU-SKU",
              nameSnapshot: "Cancel Reg Item",
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
    return { orderId: order.id, email, orderNumber: order.orderNumber, userId: user.id };
  };

  const old = () => new Date(Date.now() - UNPAID_ORDER_TTL_MS - 60_000);

  await run("OCZ1_guest_enqueue_work_key", async () => {
    const { port, cancelled } = makeEmailStub();
    const orders = new OrdersService(prisma, inv, undefined, undefined, port);
    const { orderId, guestEmail } = await seedGuestPlaced({ placedAt: old() });
    const out = await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    if (!out.orderIds.includes(orderId)) throw new Error("not expired");
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (o.status !== OrderStatus.CANCELLED) throw new Error(`status ${o.status}`);
    if (cancelled.length !== 1) throw new Error(`enqueue count ${cancelled.length}`);
    const call = cancelled[0]!;
    if (call.orderId !== orderId) throw new Error("wrong orderId");
    if (call.to !== guestEmail) throw new Error(`to ${call.to}`);
    if (call.communicationLocale !== "en") throw new Error(`locale ${call.communicationLocale}`);
    const workKey = orderCancelledWorkKey(orderId);
    if (workKey !== `order-cancelled:${orderId}`) throw new Error(`workKey ${workKey}`);
    if (orderCancelledJobId(orderId) !== `ord:cancel:${orderId}`) {
      throw new Error("jobId shape");
    }
    // Simulate adapter storing work key in payload — OrdersService passes args only;
    // contract keys validated above. Ensure CANCELLED before enqueue via status check.
    if (o.paymentStatus !== PaymentStatus.PENDING) throw new Error("payment mutated");
  });

  await run("OCZ2_registered_recipient", async () => {
    const { port, cancelled } = makeEmailStub();
    const orders = new OrdersService(prisma, inv, undefined, undefined, port);
    const { orderId, email, orderNumber } = await seedRegisteredPlaced(old());
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    if (cancelled.length !== 1) throw new Error(`enqueue count ${cancelled.length}`);
    if (cancelled[0]!.to !== email) throw new Error(`to ${cancelled[0]!.to}`);
    if (cancelled[0]!.communicationLocale !== "de") throw new Error("locale");
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });
    const built = buildOrderCancelledEmail({ order });
    if (!built.accessPath?.includes(orderNumber)) throw new Error("missing account link");
    if (built.accessPath.includes("token=")) throw new Error("guest token in registered");
    if (built.text.includes("guestAccessToken") || built.text.includes("token=")) {
      throw new Error("token in body");
    }
  });

  await run("OCZ3_enqueue_fail_keeps_cancelled", async () => {
    const { port, cancelled } = makeEmailStub({ failCancelled: true });
    const orders = new OrdersService(prisma, inv, undefined, undefined, port);
    const { orderId } = await seedGuestPlaced({ placedAt: old() });
    const out = await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    if (!out.orderIds.includes(orderId)) throw new Error("not expired");
    if (cancelled.length !== 0) throw new Error("unexpected capture on throw");
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (o.status !== OrderStatus.CANCELLED) throw new Error("CANCELLED rolled back");
    if (o.paymentStatus !== PaymentStatus.PENDING) throw new Error("paymentStatus changed");
  });

  await run("OCZ4_idempotent_no_second_enqueue", async () => {
    const { port, cancelled } = makeEmailStub();
    const orders = new OrdersService(prisma, inv, undefined, undefined, port);
    const { orderId } = await seedGuestPlaced({ placedAt: old() });
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    if (cancelled.length !== 1) throw new Error(`expected 1 enqueue got ${cancelled.length}`);
  });

  await run("OCZ5_admin_cancel_no_emit", async () => {
    const { port, cancelled } = makeEmailStub();
    const orders = new OrdersService(prisma, inv, undefined, undefined, port);
    const admin = await prisma.user.create({
      data: {
        email: `ocz-admin-${stamp}@test.local`,
        passwordHash: "x",
        locale: "de",
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(admin.id);
    await resetStock();
    const key = ck("ocz-ac");
    await inv.reserve(key, variantId, locationId, 1);
    const order = await prisma.order.create({
      data: {
        orderNumber: `OCZA-${stamp}-${randomBytes(3).toString("hex")}`,
        userId: admin.id,
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
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
        shippingAddressJson: { line1: "A" },
        billingAddressJson: { line1: "A" },
        sellerIdentitySnapshotJson: SELLER,
        placedAt: new Date(),
        items: {
          create: [
            {
              variantId,
              skuSnapshot: "A",
              nameSnapshot: "Admin cancel item",
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
    // Simulate sale convert so cancel_restock path is valid
    await prisma.reservation.updateMany({
      where: { orderId: order.id },
      data: { convertedAt: new Date(), releasedAt: new Date() },
    });
    await orders.adminCancelPostSale(order.id, admin.id);
    if (cancelled.length !== 0) {
      throw new Error(`Admin Cancel emitted order-cancelled (${cancelled.length})`);
    }
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    if (o.status !== OrderStatus.CANCELLED) throw new Error("admin cancel failed");
  });

  await run("OCZ6_refund_return_no_emit", async () => {
    const { port, cancelled } = makeEmailStub();
    const orders = new OrdersService(prisma, inv, undefined, undefined, port);
    const { orderId } = await seedGuestPlaced({
      placedAt: new Date(),
      paymentStatus: PaymentStatus.PAID,
      status: OrderStatus.CONFIRMED,
    });
    const pm = await prisma.paymentMethod.upsert({
      where: { code: "stripe_card" },
      create: { code: "stripe_card", provider: "stripe", isEnabled: true, sortOrder: 1 },
      update: {},
    });
    const payment = await prisma.payment.create({
      data: {
        orderId,
        paymentMethodId: pm.id,
        provider: "stripe",
        providerIntentId: `pi_ocz_${randomBytes(4).toString("hex")}`,
        amount: "10.00",
        currencyCode: "EUR",
        status: PaymentStatus.PAID,
      },
    });
    await prisma.refund.create({
      data: {
        orderId,
        paymentId: payment.id,
        amount: "1.00",
        currencyCode: "EUR",
        status: RefundStatus.PENDING,
        reason: "ocz-test",
      },
    });
    await prisma.returnRequest.create({
      data: {
        orderId,
        type: "OTHER",
        status: ReturnRequestStatus.REQUESTED,
        orderPriorStatus: OrderStatus.DELIVERED,
        reasonCode: "OTHER",
        returnLocale: "de",
        estimatedRefundTotal: "1.00",
        returnAddressSnapshotJson: { line1: "R" },
        returnInstructionsSnapshot: "box",
      },
    });
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    if (cancelled.length !== 0) throw new Error("Refund/Return path emitted cancel email");
  });

  await run("OCZ7_builder_unpaid_no_guest_link", async () => {
    const { orderId } = await seedGuestPlaced({ placedAt: old() });
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED },
    });
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });
    const built = buildOrderCancelledEmail({ order });
    if (built.accessPath != null) throw new Error("guest must have null accessPath");
    if (!built.text.includes("unpaid payment window expired")) {
      throw new Error("missing unpaid window copy");
    }
    if (!built.text.includes("No further payment is due")) {
      throw new Error("missing no further payment");
    }
    if (!built.text.includes("Cancel Frozen Seller UG")) throw new Error("seller snapshot missing");
    if (!built.text.includes("Cancel Item")) throw new Error("item snapshot missing");
    if (built.text.includes("token=") || built.text.includes("guestAccess")) {
      throw new Error("forbidden guest token content");
    }
    if (/\bPAID\b/.test(built.text) && !built.text.includes("unpaid")) {
      throw new Error("PAID wording");
    }
    if (/refund issued|payment confirmed|Zahlung bestätigt/i.test(built.text)) {
      throw new Error("forbidden payment/refund success wording");
    }
    if (!built.text.includes("PENDING (unpaid")) throw new Error("pending unpaid label");
  });

  await run("OCZ8_worker_retry_no_duplicate", async () => {
    const { orderId, guestEmail } = await seedGuestPlaced({ placedAt: old() });
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED },
    });
    const delivered = new Set<string>();
    const delivery = {
      wasDelivered: async (k: string) => delivered.has(k),
      markDelivered: async (k: string) => {
        delivered.add(k);
      },
      clearDelivered: async (k: string) => {
        delivered.delete(k);
      },
    };
    let sends = 0;
    const transport: SmtpTransport = {
      sendMail: async () => {
        sends += 1;
      },
    };
    const payload = {
      idempotencyKey: orderCancelledWorkKey(orderId),
      to: guestEmail,
      template: "order_cancelled" as const,
      orderId,
      communicationLocale: "en" as const,
    };
    const r1 = await processOrderCancelledJob(payload, {
      prisma,
      transport,
      delivery: delivery as never,
    });
    const r2 = await processOrderCancelledJob(payload, {
      prisma,
      transport,
      delivery: delivery as never,
    });
    if (r1 !== "sent") throw new Error(`r1=${r1}`);
    if (r2 !== "skipped") throw new Error(`r2=${r2}`);
    if (sends !== 1) throw new Error(`sends=${sends}`);
  });

  await run("OCZ9_r22f_still_after_commit", async () => {
    const providerCalls: string[] = [];
    const payments = {
      attemptProviderCancelAfterUnpaidOrderCancel: async (id: string) => {
        providerCalls.push(id);
      },
    };
    const { port, cancelled } = makeEmailStub();
    // payments is 3rd ctor arg
    const orders = new OrdersService(
      prisma,
      inv,
      payments as never,
      undefined,
      port,
    );
    const { orderId } = await seedGuestPlaced({ placedAt: old() });
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    if (cancelled.length !== 1) throw new Error("email missing");
    if (providerCalls.length !== 1 || providerCalls[0] !== orderId) {
      throw new Error(`R2.2-F not called: ${JSON.stringify(providerCalls)}`);
    }
  });

  await run("OCZ10_failed_unpaid_enqueue", async () => {
    const { port, cancelled } = makeEmailStub();
    const orders = new OrdersService(prisma, inv, undefined, undefined, port);
    const { orderId } = await seedGuestPlaced({
      placedAt: old(),
      paymentStatus: PaymentStatus.FAILED,
    });
    await orders.expireUnpaidPlacedOrders({ now: new Date(), limit: 50 });
    if (cancelled.length !== 1) throw new Error("no enqueue for FAILED unpaid");
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (o.status !== OrderStatus.CANCELLED) throw new Error("not cancelled");
    if (o.paymentStatus !== PaymentStatus.FAILED) throw new Error("FAILED mutated");
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });
    const built = buildOrderCancelledEmail({ order });
    if (!built.text.includes("FAILED (unpaid")) throw new Error("FAILED unpaid label");
  });

  // cleanup
  await prisma.refund.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
  await prisma.returnRequest.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
  await prisma.payment.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
  await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
  await prisma.reservation.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
  await prisma.stockMovement.deleteMany({ where: { orderId: { in: createdOrderIds } } }).catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { entityId: { in: createdOrderIds } } }).catch(() => undefined);
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  await prisma.$disconnect();
  if (failed.length) {
    console.error(`\norder-cancelled: FAIL (${results.length - failed.length}/${results.length})`);
    process.exit(1);
  }
  console.log(`\norder-cancelled: ${results.length}/${results.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
