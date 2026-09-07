/**
 * R2.2-D — Bonus CLAWBACK / REDEEM_RESTORE on Refund SUCCEEDED.
 * SoT: docs/10.13-returns-clawback.md §3b
 *
 * Requires: DATABASE_URL (+ seed MAIN optional for payment method)
 * Run: pnpm --filter @dodo/api run test:r22d-clawback
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { ConflictException, HttpException } from "@nestjs/common";
import {
  ActorType,
  BonusLedgerType,
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
  TaxMode,
} from "@dodo/database";
import { PaymentsService } from "./payments/payments.service";
import { PrismaService } from "./prisma/prisma.service";
import { InventoryService } from "./inventory/inventory.service";
import { StripeFirstAttemptAdapter } from "./payments/stripe.first-attempt.adapter";
import { PayPalFirstAttemptAdapter } from "./payments/paypal.first-attempt.adapter";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

const IDS = [
  "D1_full_refund",
  "D2_partial_proportional",
  "D3_restore_and_clawback",
  "D4_cap_remaining",
  "D5_zero_movement",
  "D6_idempotent",
  "D7_concurrent",
  "D8_negative_balance_409",
  "D9_standalone_null_returnRequestId",
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

async function main() {
  console.log("Focused Verification — R2.2-D Refund Bonus CLAWBACK / REDEEM_RESTORE\n");
  const results: Result[] = [];
  const prisma = new PrismaService();
  await prisma.$connect();

  const payments = new PaymentsService(
    prisma,
    new InventoryService(prisma),
    new StripeFirstAttemptAdapter(),
    new PayPalFirstAttemptAdapter(),
  );

  const stamp = `${Date.now()}`;
  const createdOrderIds: string[] = [];
  const createdUserIds: string[] = [];

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

  const paymentMethod = await prisma.paymentMethod.upsert({
    where: { code: "stripe_card" },
    create: { code: "stripe_card", provider: "stripe", isEnabled: true, sortOrder: 1 },
    update: { isEnabled: true },
  });

  type SeedOpts = {
    grandTotal: string;
    earn: number;
    redeem: number;
    balanceCached: number;
    refundAmount: string;
    returnRequestId?: string | null;
  };

  const seedPaidOrderWithRefund = async (opts: SeedOpts) => {
    const user = await prisma.user.create({
      data: {
        email: `r22d_${stamp}_${randomBytes(4).toString("hex")}@test.local`,
        passwordHash: `hash_${randomBytes(8).toString("hex")}`,
        locale: "de",
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);

    const acct = await prisma.bonusAccount.create({
      data: { userId: user.id, balanceCached: opts.balanceCached },
    });

    const order = await prisma.order.create({
      data: {
        orderNumber: `R22D-${stamp}-${randomBytes(3).toString("hex")}`,
        userId: user.id,
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        currencyCode: "EUR",
        locale: "de",
        shippingCountryCode: "DE",
        taxMode: TaxMode.KLEINUNTERNEHMER,
        companyIsKleinunternehmer: true,
        invoiceExemptionTextSnapshot: "§19",
        itemsSubtotal: opts.grandTotal,
        shippingTotal: "0.00",
        discountCoupon: "0.00",
        discountBonus: opts.redeem > 0 ? (opts.redeem / 100).toFixed(2) : "0.00",
        grandTotal: opts.grandTotal,
        shippingMethodCodeSnapshot: "standard",
        shippingStandardAmountSnapshot: "0.00",
        shippingAddressJson: { line1: "R22D" },
        billingAddressJson: { line1: "R22D" },
        sellerIdentitySnapshotJson: {
          legalName: "R22D UG",
          line1: "Test 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        paymentMethodCodeSnapshot: "stripe",
        bonusPointsRedeemed: opts.redeem,
        bonusPointsEarned: opts.earn > 0 ? opts.earn : undefined,
        bonusDiscountAmount: opts.redeem > 0 ? (opts.redeem / 100).toFixed(2) : "0.00",
        confirmedAt: new Date(),
      },
    });
    createdOrderIds.push(order.id);

    if (opts.redeem > 0) {
      await prisma.bonusLedger.create({
        data: {
          accountId: acct.id,
          type: BonusLedgerType.REDEEM,
          points: -opts.redeem,
          orderId: order.id,
          idempotencyKey: `redeem:${order.id}`,
          actorType: ActorType.SYSTEM,
        },
      });
    }
    if (opts.earn > 0) {
      await prisma.bonusLedger.create({
        data: {
          accountId: acct.id,
          type: BonusLedgerType.EARN,
          points: opts.earn,
          orderId: order.id,
          idempotencyKey: `earn:${order.id}`,
          actorType: ActorType.SYSTEM,
        },
      });
    }

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        paymentMethodId: paymentMethod.id,
        provider: "stripe",
        providerIntentId: `pi_r22d_${order.id}`,
        amount: new Prisma.Decimal(opts.grandTotal),
        currencyCode: "EUR",
        status: PaymentStatus.PAID,
      },
    });

    const refund = await prisma.refund.create({
      data: {
        orderId: order.id,
        paymentId: payment.id,
        returnRequestId: opts.returnRequestId === undefined ? null : opts.returnRequestId,
        amount: new Prisma.Decimal(opts.refundAmount),
        currencyCode: "EUR",
        status: RefundStatus.PENDING,
        reason: "r22d-test",
        refundTotal: new Prisma.Decimal(opts.refundAmount),
      },
    });

    return { userId: user.id, orderId: order.id, accountId: acct.id, refundId: refund.id };
  };

  // ── D1 full refund ───────────────────────────────────────────────
  await run("D1_full_refund", async () => {
    const s = await seedPaidOrderWithRefund({
      grandTotal: "100.00",
      earn: 100,
      redeem: 0,
      balanceCached: 100,
      refundAmount: "100.00",
    });
    const out = await payments.markRefundSucceeded(s.refundId);
    if (out.clawbackPts !== 100) throw new Error(`clawback ${out.clawbackPts}`);
    if (out.restorePts !== 0) throw new Error(`restore ${out.restorePts}`);
    if (out.paymentStatus !== PaymentStatus.REFUNDED) throw new Error(out.paymentStatus);
    const claw = await prisma.bonusLedger.findUniqueOrThrow({
      where: { idempotencyKey: `clawback:refund:${s.refundId}` },
    });
    if (claw.type !== BonusLedgerType.CLAWBACK || claw.points !== -100) {
      throw new Error("CLAWBACK row");
    }
    const acct = await prisma.bonusAccount.findUniqueOrThrow({ where: { id: s.accountId } });
    if (acct.balanceCached !== 0) throw new Error(`balance ${acct.balanceCached}`);
  });

  // ── D2 partial proportional ──────────────────────────────────────
  await run("D2_partial_proportional", async () => {
    const s = await seedPaidOrderWithRefund({
      grandTotal: "100.00",
      earn: 100,
      redeem: 0,
      balanceCached: 100,
      refundAmount: "50.00",
    });
    const out = await payments.markRefundSucceeded(s.refundId);
    if (out.clawbackPts !== 50) throw new Error(`clawback ${out.clawbackPts} want 50`);
    if (out.paymentStatus !== PaymentStatus.PARTIALLY_REFUNDED) {
      throw new Error(out.paymentStatus);
    }
  });

  // ── D3 restore + clawback ────────────────────────────────────────
  await run("D3_restore_and_clawback", async () => {
    // balance after PAID path: start 200, redeem 50 → 150, earn 100 → 250
    const s = await seedPaidOrderWithRefund({
      grandTotal: "100.00",
      earn: 100,
      redeem: 50,
      balanceCached: 250,
      refundAmount: "100.00",
    });
    const out = await payments.markRefundSucceeded(s.refundId);
    if (out.restorePts !== 50) throw new Error(`restore ${out.restorePts}`);
    if (out.clawbackPts !== 100) throw new Error(`clawback ${out.clawbackPts}`);
    const restore = await prisma.bonusLedger.findUniqueOrThrow({
      where: { idempotencyKey: `redeem-restore:refund:${s.refundId}` },
    });
    if (restore.type !== BonusLedgerType.REDEEM_RESTORE || restore.points !== 50) {
      throw new Error("REDEEM_RESTORE row");
    }
    if (restore.type === ("ADJUST" as string)) throw new Error("must not be ADJUST");
    const earn = await prisma.bonusLedger.findFirst({
      where: { orderId: s.orderId, type: BonusLedgerType.EARN },
    });
    const redeem = await prisma.bonusLedger.findFirst({
      where: { orderId: s.orderId, type: BonusLedgerType.REDEEM },
    });
    if (!earn || earn.points !== 100) throw new Error("EARN mutated");
    if (!redeem || redeem.points !== -50) throw new Error("REDEEM mutated");
    const acct = await prisma.bonusAccount.findUniqueOrThrow({ where: { id: s.accountId } });
    // 250 + 50 - 100 = 200
    if (acct.balanceCached !== 200) throw new Error(`balance ${acct.balanceCached}`);
  });

  // ── D4 cap remaining ─────────────────────────────────────────────
  await run("D4_cap_remaining", async () => {
    const s = await seedPaidOrderWithRefund({
      grandTotal: "100.00",
      earn: 100,
      redeem: 0,
      balanceCached: 100,
      refundAmount: "60.00",
    });
    const first = await payments.markRefundSucceeded(s.refundId);
    if (first.clawbackPts !== 60) throw new Error(`first ${first.clawbackPts}`);

    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: s.orderId } });
    const refund2 = await prisma.refund.create({
      data: {
        orderId: s.orderId,
        paymentId: payment.id,
        returnRequestId: null,
        amount: new Prisma.Decimal("60.00"),
        currencyCode: "EUR",
        status: RefundStatus.PENDING,
        reason: "r22d-cap",
        refundTotal: new Prisma.Decimal("60.00"),
      },
    });
    const second = await payments.markRefundSucceeded(refund2.id);
    // raw = FLOOR(100*60/100)=60, remaining=40 → cap 40
    if (second.clawbackPts !== 40) throw new Error(`cap ${second.clawbackPts} want 40`);
    const claws = await prisma.bonusLedger.findMany({
      where: { orderId: s.orderId, type: BonusLedgerType.CLAWBACK },
    });
    const totalClaw = claws.reduce((a, r) => a + Math.abs(r.points), 0);
    if (totalClaw !== 100) throw new Error(`total claw ${totalClaw}`);
  });

  // ── D5 zero movement ─────────────────────────────────────────────
  await run("D5_zero_movement", async () => {
    const s = await seedPaidOrderWithRefund({
      grandTotal: "100.00",
      earn: 0,
      redeem: 0,
      balanceCached: 0,
      refundAmount: "100.00",
    });
    const before = await prisma.bonusLedger.count({ where: { orderId: s.orderId } });
    const out = await payments.markRefundSucceeded(s.refundId);
    if (out.clawbackPts !== 0 || out.restorePts !== 0) throw new Error("expected zero");
    const after = await prisma.bonusLedger.count({ where: { orderId: s.orderId } });
    if (after !== before) throw new Error("ledger rows created");
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: s.refundId } });
    if (refund.status !== RefundStatus.SUCCEEDED) throw new Error("refund not succeeded");
    if (
      (await prisma.bonusLedger.findUnique({
        where: { idempotencyKey: `clawback:refund:${s.refundId}` },
      })) != null
    ) {
      throw new Error("claw key should be absent for zero");
    }
  });

  // ── D6 idempotent ────────────────────────────────────────────────
  await run("D6_idempotent", async () => {
    const s = await seedPaidOrderWithRefund({
      grandTotal: "100.00",
      earn: 80,
      redeem: 20,
      balanceCached: 200,
      refundAmount: "100.00",
    });
    const first = await payments.markRefundSucceeded(s.refundId);
    const acct1 = await prisma.bonusAccount.findUniqueOrThrow({ where: { id: s.accountId } });
    const ledgerCount1 = await prisma.bonusLedger.count({ where: { orderId: s.orderId } });
    const second = await payments.markRefundSucceeded(s.refundId);
    if (!second.idempotent) throw new Error("second should be idempotent");
    if (second.clawbackPts !== first.clawbackPts || second.restorePts !== first.restorePts) {
      throw new Error("pts mismatch");
    }
    const acct2 = await prisma.bonusAccount.findUniqueOrThrow({ where: { id: s.accountId } });
    if (acct2.balanceCached !== acct1.balanceCached) throw new Error("balance changed");
    const ledgerCount2 = await prisma.bonusLedger.count({ where: { orderId: s.orderId } });
    if (ledgerCount2 !== ledgerCount1) throw new Error("extra ledger rows");
  });

  // ── D7 concurrent ────────────────────────────────────────────────
  await run("D7_concurrent", async () => {
    const s = await seedPaidOrderWithRefund({
      grandTotal: "100.00",
      earn: 100,
      redeem: 0,
      balanceCached: 100,
      refundAmount: "100.00",
    });
    const [a, b] = await Promise.all([
      payments.markRefundSucceeded(s.refundId),
      payments.markRefundSucceeded(s.refundId),
    ]);
    const claws = await prisma.bonusLedger.findMany({
      where: { orderId: s.orderId, type: BonusLedgerType.CLAWBACK },
    });
    if (claws.length !== 1) throw new Error(`claw rows ${claws.length}`);
    if (claws[0].points !== -100) throw new Error("claw pts");
    const acct = await prisma.bonusAccount.findUniqueOrThrow({ where: { id: s.accountId } });
    if (acct.balanceCached !== 0) throw new Error(`balance ${acct.balanceCached}`);
    if (!(a.idempotent || b.idempotent) && a.clawbackPts + b.clawbackPts !== 100) {
      // one applied, one idempotent — both report 100 clawbackPts typically
    }
    void a;
    void b;
  });

  // ── D8 negative balance 409 ──────────────────────────────────────
  await run("D8_negative_balance_409", async () => {
    const s = await seedPaidOrderWithRefund({
      grandTotal: "100.00",
      earn: 100,
      redeem: 0,
      balanceCached: 10,
      refundAmount: "100.00",
    });
    try {
      await payments.markRefundSucceeded(s.refundId);
      throw new Error("expected 409");
    } catch (e) {
      if (!(e instanceof ConflictException) || errCode(e) !== "BONUS_NEGATIVE_BALANCE") {
        throw e instanceof Error ? e : new Error(String(e));
      }
    }
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: s.refundId } });
    if (refund.status !== RefundStatus.PENDING) {
      throw new Error(`refund rolled back? status=${refund.status}`);
    }
    const claws = await prisma.bonusLedger.count({
      where: { orderId: s.orderId, type: BonusLedgerType.CLAWBACK },
    });
    if (claws !== 0) throw new Error("clawback leaked");
  });

  // ── D9 standalone returnRequestId null ───────────────────────────
  await run("D9_standalone_null_returnRequestId", async () => {
    const s = await seedPaidOrderWithRefund({
      grandTotal: "40.00",
      earn: 40,
      redeem: 0,
      balanceCached: 40,
      refundAmount: "40.00",
      returnRequestId: null,
    });
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: s.refundId } });
    if (refund.returnRequestId !== null) throw new Error("expected null returnRequestId");
    const out = await payments.markRefundSucceeded(s.refundId);
    if (out.clawbackPts !== 40) throw new Error(`clawback ${out.clawbackPts}`);
    const claw = await prisma.bonusLedger.findUnique({
      where: { idempotencyKey: `clawback:refund:${s.refundId}` },
    });
    if (!claw) throw new Error("missing claw for standalone");
  });

  // cleanup (best-effort)
  for (const orderId of createdOrderIds) {
    await prisma.bonusLedger.deleteMany({ where: { orderId } });
    await prisma.refund.deleteMany({ where: { orderId } });
    await prisma.payment.deleteMany({ where: { orderId } });
    await prisma.order.delete({ where: { id: orderId } }).catch(() => undefined);
  }
  for (const userId of createdUserIds) {
    await prisma.bonusAccount.deleteMany({ where: { userId } });
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
