import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ActorType,
  BonusLedgerType,
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
} from "@dodo/database";
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { InventoryService } from "../inventory/inventory.service";
import { PostOrderEmailHooks } from "../integrations/email/post-order-email.hooks";
import { InvoiceAfterSaleOrchestrator } from "../invoices/invoice-after-sale.orchestrator";
import { PrismaService } from "../prisma/prisma.service";
import {
  firstAttemptProviderIdempotencyIdentity,
  retryAttemptProviderIdempotencyIdentity,
  type FirstAttemptClientPayload,
  type FirstAttemptProviderAdapter,
  type FirstAttemptProviderName,
  type ProviderCancelOutcome,
} from "./first-intent.identity";
import {
  FIRST_INTENT_MEMORY,
  FIRST_INTENT_TEST_HOOKS,
  type FirstIntentTestHooks,
} from "./first-intent.hooks";
import { InMemoryFirstAttemptProviders } from "./in-memory.first-attempt.providers";
import {
  isProviderCreateRejected,
  isProviderCreateUnknown,
} from "./payment-provider.errors";
import { PayPalFirstAttemptAdapter } from "./paypal.first-attempt.adapter";
import { StripeFirstAttemptAdapter } from "./stripe.first-attempt.adapter";
import { WebhookOrphanError, WebhookSettlementAbortError } from "./webhook.errors";
import type { WebhookVerifyInvalid, WebhookVerifyOk } from "./webhook.types";

type Tx = Parameters<Parameters<PrismaService["$transaction"]>[0]>[0];

@Injectable()
export class PaymentsService {
  private readonly adapters: Map<FirstAttemptProviderName, FirstAttemptProviderAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly stripe: StripeFirstAttemptAdapter,
    private readonly paypal: PayPalFirstAttemptAdapter,
    @Optional() @Inject(FIRST_INTENT_MEMORY) memory?: InMemoryFirstAttemptProviders,
    @Optional() @Inject(FIRST_INTENT_TEST_HOOKS) private readonly hooks?: FirstIntentTestHooks,
    /** #17 refund email — after Refund SUCCEEDED commit (must not roll back refund). */
    @Optional() private readonly postOrderEmail?: PostOrderEmailHooks,
    /**
     * 10.11 §1 — Invoice issue + PDF enqueue after PAID+CONFIRMED+sale commit.
     * Optional so narrow test modules without InvoicesModule still construct.
     */
    @Optional() private readonly invoiceAfterSale?: InvoiceAfterSaleOrchestrator,
  ) {
    const list = memory ? memory.adapters() : [stripe, paypal];
    this.adapters = new Map(list.map((a) => [a.provider, a]));
  }

  skeleton() {
    return { module: "payments", ready: true, commerce: false };
  }

  /**
   * R2.2-F — best-effort provider intent cancel AFTER unpaid Order → CANCELLED has committed.
   * Must not run inside the Cancel DB transaction. Failure never undoes CANCELLED.
   * SoT: docs/10.9-payments-webhooks.md §2c
   */
  async attemptProviderCancelAfterUnpaidOrderCancel(orderId: string): Promise<{
    outcome: ProviderCancelOutcome | "skipped";
    audited: boolean;
  }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== OrderStatus.CANCELLED) {
      return { outcome: "skipped", audited: false };
    }
    if (
      order.paymentStatus !== PaymentStatus.PENDING &&
      order.paymentStatus !== PaymentStatus.FAILED
    ) {
      // Paid / refunded cancels are outside R2.2-F.
      return { outcome: "skipped", audited: false };
    }

    const payment = await this.prisma.payment.findFirst({
      where: { orderId },
      orderBy: { createdAt: "asc" },
    });

    const entityType = payment ? "Payment" : "Order";
    const entityId = payment?.id ?? orderId;
    const provider = payment?.provider ?? null;
    const providerIntentId = payment?.providerIntentId ?? null;

    const prior = await this.prisma.auditLog.findFirst({
      where: {
        action: "provider_payment_cancel_attempt",
        entityType,
        entityId,
      },
      orderBy: { createdAt: "desc" },
    });
    if (prior?.afterJson && typeof prior.afterJson === "object" && !Array.isArray(prior.afterJson)) {
      const prev = prior.afterJson as { outcome?: string };
      if (
        prev.outcome === "succeeded" ||
        prev.outcome === "not_cancellable" ||
        prev.outcome === "skipped"
      ) {
        return { outcome: prev.outcome as ProviderCancelOutcome | "skipped", audited: false };
      }
    }

    if (!providerIntentId || !provider) {
      await this.prisma.auditLog.create({
        data: {
          actorType: ActorType.SYSTEM,
          actorId: null,
          action: "provider_payment_cancel_attempt",
          entityType,
          entityId,
          afterJson: {
            outcome: "skipped",
            provider: provider ?? undefined,
            providerIntentId: providerIntentId ?? undefined,
            errorCode: "NO_PROVIDER_INTENT",
          },
        },
      });
      return { outcome: "skipped", audited: true };
    }

    const adapter = this.adapters.get(provider as FirstAttemptProviderName);
    if (!adapter) {
      await this.prisma.auditLog.create({
        data: {
          actorType: ActorType.SYSTEM,
          actorId: null,
          action: "provider_payment_cancel_attempt",
          entityType,
          entityId,
          afterJson: {
            outcome: "rejected",
            provider,
            providerIntentId,
            errorCode: "PROVIDER_ADAPTER_MISSING",
          },
        },
      });
      return { outcome: "rejected", audited: true };
    }

    let outcome: ProviderCancelOutcome;
    let errorCode: string | undefined;
    try {
      const result = await adapter.cancelOpenIntent(providerIntentId);
      outcome = result.outcome;
      errorCode = result.errorCode;
    } catch (e) {
      outcome = "network_failure";
      errorCode = e instanceof Error ? e.message : "CANCEL_THREW";
    }

    await this.prisma.auditLog.create({
      data: {
        actorType: ActorType.SYSTEM,
        actorId: null,
        action: "provider_payment_cancel_attempt",
        entityType,
        entityId,
        afterJson: {
          outcome,
          provider,
          providerIntentId,
          ...(errorCode ? { errorCode } : {}),
        },
      },
    });
    return { outcome, audited: true };
  }

  adapterFor(provider: FirstAttemptProviderName): FirstAttemptProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new BadGatewayException({
        error: "INTERNAL_ERROR",
        message: `Payment provider ${provider} is not available`,
      });
    }
    return adapter;
  }

  async createOrRecoverThenPersist(input: {
    tx: Tx;
    orderId: string;
    paymentMethodId: string;
    provider: FirstAttemptProviderName;
    amount: Prisma.Decimal;
    currencyCode: string;
  }): Promise<FirstAttemptClientPayload> {
    const created = await this.createOrRecoverProvider({
      orderId: input.orderId,
      provider: input.provider,
      amount: input.amount,
      currencyCode: input.currencyCode,
    });

    if (this.hooks?.beforePersist) {
      await this.hooks.beforePersist();
    }

    await input.tx.payment.create({
      data: {
        orderId: input.orderId,
        paymentMethodId: input.paymentMethodId,
        provider: input.provider,
        providerIntentId: created.providerIntentId,
        amount: input.amount,
        currencyCode: input.currencyCode,
        status: PaymentStatus.PENDING,
      },
    });

    return created.payload;
  }

  /** First-attempt PENDING row without providerIntentId — recover, do not insert a second Payment. */
  async recoverIntoExistingPayment(input: {
    tx: Tx;
    paymentId: string;
    orderId: string;
    provider: FirstAttemptProviderName;
    amount: Prisma.Decimal;
    currencyCode: string;
  }): Promise<FirstAttemptClientPayload> {
    const created = await this.createOrRecoverProvider({
      orderId: input.orderId,
      provider: input.provider,
      amount: input.amount,
      currencyCode: input.currencyCode,
    });
    await input.tx.payment.update({
      where: { id: input.paymentId },
      data: { providerIntentId: created.providerIntentId },
    });
    return created.payload;
  }

  /**
   * §7 retry — new Payment row + new provider object.
   * Idempotency identity is attempt-scoped (not first-intent Order.id key).
   */
  async createRetryOrRecoverThenPersist(input: {
    tx: Tx;
    orderId: string;
    paymentMethodId: string;
    provider: FirstAttemptProviderName;
    amount: Prisma.Decimal;
    currencyCode: string;
    attemptKey: string;
  }): Promise<FirstAttemptClientPayload> {
    const created = await this.createOrRecoverProvider({
      orderId: input.orderId,
      provider: input.provider,
      amount: input.amount,
      currencyCode: input.currencyCode,
      idempotencyKey: retryAttemptProviderIdempotencyIdentity(
        input.orderId,
        input.attemptKey,
      ),
    });

    if (this.hooks?.beforePersist) {
      await this.hooks.beforePersist();
    }

    await input.tx.payment.create({
      data: {
        orderId: input.orderId,
        paymentMethodId: input.paymentMethodId,
        provider: input.provider,
        providerIntentId: created.providerIntentId,
        amount: input.amount,
        currencyCode: input.currencyCode,
        status: PaymentStatus.PENDING,
      },
    });

    return created.payload;
  }

  /** §7 retry PENDING row without providerIntentId — recover with payment-scoped identity. */
  async recoverRetryIntoExistingPayment(input: {
    tx: Tx;
    paymentId: string;
    orderId: string;
    provider: FirstAttemptProviderName;
    amount: Prisma.Decimal;
    currencyCode: string;
  }): Promise<FirstAttemptClientPayload> {
    const created = await this.createOrRecoverProvider({
      orderId: input.orderId,
      provider: input.provider,
      amount: input.amount,
      currencyCode: input.currencyCode,
      idempotencyKey: retryAttemptProviderIdempotencyIdentity(input.orderId, input.paymentId),
    });
    await input.tx.payment.update({
      where: { id: input.paymentId },
      data: { providerIntentId: created.providerIntentId },
    });
    return created.payload;
  }

  async payloadForExisting(
    provider: FirstAttemptProviderName,
    providerIntentId: string,
  ): Promise<FirstAttemptClientPayload> {
    const adapter = this.adapterFor(provider);
    try {
      return await adapter.getClientPayload(providerIntentId);
    } catch (e) {
      throw this.toHttp(e);
    }
  }

  /**
   * Provider webhook: verify inside adapters, then settle PAID-class events atomically.
   * Signature failure writes nothing.
   */
  async handleWebhook(headers: IncomingHttpHeaders, rawBody: Buffer): Promise<void> {
    const verified = await this.verifyInbound(headers, rawBody);
    if (verified.outcome === "invalid") {
      throw this.invalidWebhookHttp(verified);
    }

    try {
      if (verified.classification === "ignore") {
        await this.recordIgnoredEvent(verified, rawBody);
        return;
      }
      if (!verified.providerIntentId) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: "Malformed webhook payload",
        });
      }
      await this.settlePaidEvent(verified, rawBody);
    } catch (e) {
      if (e instanceof WebhookOrphanError) {
        throw new ServiceUnavailableException({
          error: "INTERNAL_ERROR",
          message: "Payment mapping not ready",
        });
      }
      if (e instanceof WebhookSettlementAbortError) {
        throw new InternalServerErrorException({
          error: "INTERNAL_ERROR",
          message: "Settlement could not complete safely",
        });
      }
      if (isWebhookEventUniqueViolation(e)) {
        return;
      }
      throw e;
    }
  }

  private async verifyInbound(
    headers: IncomingHttpHeaders,
    rawBody: Buffer,
  ): Promise<WebhookVerifyOk | WebhookVerifyInvalid> {
    const stripe = await this.stripe.verifyWebhook(headers, rawBody);
    if (stripe.outcome === "verified" || stripe.outcome === "invalid") return stripe;
    const paypal = await this.paypal.verifyWebhook(headers, rawBody);
    if (paypal.outcome === "verified" || paypal.outcome === "invalid") return paypal;
    return { outcome: "invalid", reason: "signature" };
  }

  private invalidWebhookHttp(result: WebhookVerifyInvalid): BadRequestException {
    const message =
      result.reason === "freshness"
        ? "Webhook timestamp outside freshness window"
        : result.reason === "malformed"
          ? "Malformed webhook payload"
          : "Invalid webhook signature";
    return new BadRequestException({ error: "VALIDATION_ERROR", message });
  }

  private async recordIgnoredEvent(ev: WebhookVerifyOk, rawBody: Buffer): Promise<void> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider: ev.provider,
          eventId: ev.eventId,
          payloadHash: sha256Hex(rawBody),
        },
      });
    } catch (e) {
      if (isWebhookEventUniqueViolation(e)) return;
      throw e;
    }
  }

  private async settlePaidEvent(ev: WebhookVerifyOk, rawBody: Buffer): Promise<void> {
    const intentId = ev.providerIntentId!;
    const payloadHash = sha256Hex(rawBody);

    const orderId = await this.prisma.$transaction(
      async (tx) => {
        const seen = await tx.webhookEvent.findUnique({
          where: { provider_eventId: { provider: ev.provider, eventId: ev.eventId } },
        });
        if (seen) return null;

        const lockedPay = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Payment"
          WHERE provider = ${ev.provider} AND "providerIntentId" = ${intentId}
          FOR UPDATE
        `;
        if (!lockedPay.length) {
          throw new WebhookOrphanError();
        }

        const seenAfterLock = await tx.webhookEvent.findUnique({
          where: { provider_eventId: { provider: ev.provider, eventId: ev.eventId } },
        });
        if (seenAfterLock) return null;

        const payment = await tx.payment.findUniqueOrThrow({ where: { id: lockedPay[0].id } });

        const lockedOrd = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Order" WHERE id = ${payment.orderId} FOR UPDATE
        `;
        if (!lockedOrd.length) {
          throw new WebhookSettlementAbortError();
        }
        const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });

        if (order.status === OrderStatus.CANCELLED) {
          throw new WebhookSettlementAbortError();
        }

        if (
          payment.status === PaymentStatus.PAID &&
          order.paymentStatus === PaymentStatus.PAID &&
          order.status === OrderStatus.CONFIRMED
        ) {
          await tx.webhookEvent.create({
            data: { provider: ev.provider, eventId: ev.eventId, payloadHash },
          });
          // Already settled — return orderId so invoice/PDF ensure can recover after prior soft-fail.
          return order.id;
        }

        if (payment.status !== PaymentStatus.PENDING || order.status !== OrderStatus.PLACED) {
          throw new WebhookSettlementAbortError();
        }

        const rules = await tx.bonusRules.findFirst();
        const earnPts = order.userId
          ? computeEarnPoints(order, rules?.earnPointsPerEuro ?? 1)
          : 0;
        const now = new Date();

        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.PAID,
            rawLastEventId: ev.eventId,
          },
        });
        await tx.order.update({
          where: { id: order.id },
          data: {
            paymentStatus: PaymentStatus.PAID,
            status: OrderStatus.CONFIRMED,
            confirmedAt: now,
            ...(earnPts > 0 ? { bonusPointsEarned: earnPts } : {}),
          },
        });

        try {
          await this.inventory.convert(order.id, tx);
        } catch (e) {
          if (e instanceof HttpException) {
            throw new WebhookSettlementAbortError();
          }
          throw e;
        }

        await this.applyRedeemAndEarn(tx, order, earnPts, now, rules?.expiryMonths ?? 24);

        await tx.webhookEvent.create({
          data: { provider: ev.provider, eventId: ev.eventId, payloadHash },
        });
        return order.id;
      },
      { timeout: 15_000, maxWait: 5_000 },
    );

    // After durable PAID+CONFIRMED+sale commit only (10.11 §1 / §4a).
    // Issuance/PDF failure must never roll back settlement.
    if (orderId && this.invoiceAfterSale) {
      await this.invoiceAfterSale.afterConfirmedSaleCommitted(orderId);
    }
  }

  /**
   * W3 Refund → SUCCEEDED + R2.2-D Bonus CLAWBACK / REDEEM_RESTORE (same Tx).
   * SoT: docs/10.13-returns-clawback.md §3b · docs/10.9 §4 (paymentStatus aggregation).
   * Does not create Refund rows or call the provider — only the SUCCEEDED transition + ledger.
   * After commit: #17 `refund:{refundId}` enqueue (email failure must not undo SUCCEEDED).
   */
  async markRefundSucceeded(refundId: string): Promise<{
    refundId: string;
    status: RefundStatus;
    paymentStatus: PaymentStatus;
    clawbackPts: number;
    restorePts: number;
    idempotent: boolean;
  }> {
    if (!refundId?.trim()) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "refundId required",
      });
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        const refundPeek = await tx.refund.findUnique({ where: { id: refundId } });
        if (!refundPeek) {
          throw new NotFoundException({ error: "NOT_FOUND", message: "Refund not found" });
        }

        await tx.$queryRaw`
          SELECT id FROM "Order" WHERE id = ${refundPeek.orderId} FOR UPDATE
        `;
        await tx.$queryRaw`
          SELECT id FROM "Refund" WHERE id = ${refundId} FOR UPDATE
        `;

        const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
        const order = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId } });

        if (
          refund.status === RefundStatus.FAILED ||
          refund.status === RefundStatus.CANCELLED
        ) {
          throw new ConflictException({
            error: "REFUND_NOT_SUCCEEDABLE",
            message: `Refund status ${refund.status} cannot transition to SUCCEEDED`,
          });
        }

        const alreadySucceeded = refund.status === RefundStatus.SUCCEEDED;
        if (!alreadySucceeded) {
          if (refund.status !== RefundStatus.PENDING) {
            throw new ConflictException({
              error: "REFUND_NOT_SUCCEEDABLE",
              message: `Refund status ${refund.status} cannot transition to SUCCEEDED`,
            });
          }
          await tx.refund.update({
            where: { id: refundId },
            data: {
              status: RefundStatus.SUCCEEDED,
              completedAt: new Date(),
            },
          });
        }

        const bonus = await this.applyR22DBonusOnRefundSucceeded(tx, {
          refundId: refund.id,
          orderId: order.id,
          userId: order.userId,
          refundAmount: refund.amount,
          orderTotal: order.grandTotal,
        });

        const paymentStatus = await this.recomputeOrderPaymentStatusAfterRefund(
          tx,
          order.id,
          order.grandTotal,
        );

        return {
          refundId: refund.id,
          status: RefundStatus.SUCCEEDED,
          paymentStatus,
          clawbackPts: bonus.clawbackPts,
          restorePts: bonus.restorePts,
          idempotent: alreadySucceeded && bonus.idempotent,
        };
      },
      { timeout: 15_000, maxWait: 5_000 },
    );

    // After durable commit only — enqueue failure must never roll back Refund SUCCEEDED.
    if (this.postOrderEmail) {
      await this.postOrderEmail.afterRefundSucceeded(result.refundId);
    }

    return result;
  }

  /** R2.2-D — BonusLedger CLAWBACK + REDEEM_RESTORE for one SUCCEEDED Refund. */
  private async applyR22DBonusOnRefundSucceeded(
    tx: Tx,
    input: {
      refundId: string;
      orderId: string;
      userId: string | null;
      refundAmount: Prisma.Decimal;
      orderTotal: Prisma.Decimal;
    },
  ): Promise<{ clawbackPts: number; restorePts: number; idempotent: boolean }> {
    const clawKey = `clawback:refund:${input.refundId}`;
    const restoreKey = `redeem-restore:refund:${input.refundId}`;

    const existingClaw = await tx.bonusLedger.findUnique({
      where: { idempotencyKey: clawKey },
    });
    const existingRestore = await tx.bonusLedger.findUnique({
      where: { idempotencyKey: restoreKey },
    });

    if (!input.userId) {
      return { clawbackPts: 0, restorePts: 0, idempotent: true };
    }

    if (input.orderTotal.lte(0)) {
      return {
        clawbackPts: existingClaw ? Math.abs(existingClaw.points) : 0,
        restorePts: existingRestore ? existingRestore.points : 0,
        idempotent: true,
      };
    }

    const earnRow = await tx.bonusLedger.findFirst({
      where: { orderId: input.orderId, type: BonusLedgerType.EARN },
    });
    const redeemRow = await tx.bonusLedger.findFirst({
      where: { orderId: input.orderId, type: BonusLedgerType.REDEEM },
    });
    const orderEarn = earnRow ? Math.abs(earnRow.points) : 0;
    const orderRedeem = redeemRow ? Math.abs(redeemRow.points) : 0;

    const priorClawRows = await tx.bonusLedger.findMany({
      where: { orderId: input.orderId, type: BonusLedgerType.CLAWBACK },
    });
    const priorRestoreRows = await tx.bonusLedger.findMany({
      where: { orderId: input.orderId, type: BonusLedgerType.REDEEM_RESTORE },
    });

    let priorClawback = priorClawRows.reduce((s, r) => s + Math.abs(r.points), 0);
    let priorRestore = priorRestoreRows.reduce((s, r) => s + r.points, 0);

    // Exclude this refund's own rows from remaining (idempotent re-entry).
    if (existingClaw) priorClawback -= Math.abs(existingClaw.points);
    if (existingRestore) priorRestore -= existingRestore.points;

    const remainingEarn = Math.max(0, orderEarn - priorClawback);
    const remainingRedeem = Math.max(0, orderRedeem - priorRestore);

    const rawClawback = floorShare(orderEarn, input.refundAmount, input.orderTotal);
    const rawRestore = floorShare(orderRedeem, input.refundAmount, input.orderTotal);
    const clawbackPts = Math.min(rawClawback, remainingEarn);
    const restorePts = Math.min(rawRestore, remainingRedeem);

    if (clawbackPts <= 0 && restorePts <= 0) {
      return {
        clawbackPts: existingClaw ? Math.abs(existingClaw.points) : 0,
        restorePts: existingRestore ? existingRestore.points : 0,
        idempotent: true,
      };
    }

    const needRestore = restorePts > 0 && !existingRestore;
    const needClaw = clawbackPts > 0 && !existingClaw;

    if (!needRestore && !needClaw) {
      return {
        clawbackPts: existingClaw ? Math.abs(existingClaw.points) : 0,
        restorePts: existingRestore ? existingRestore.points : 0,
        idempotent: true,
      };
    }

    const locked = await tx.$queryRaw<Array<{ id: string; balanceCached: number }>>`
      SELECT id, "balanceCached" FROM "BonusAccount"
      WHERE "userId" = ${input.userId}
      FOR UPDATE
    `;
    if (!locked.length) {
      throw new ConflictException({
        error: "BONUS_ACCOUNT_MISSING",
        message: "BonusAccount required for R2.2-D effects",
      });
    }

    let balance = locked[0].balanceCached;
    const accountId = locked[0].id;

    const projected =
      balance + (needRestore ? restorePts : 0) - (needClaw ? clawbackPts : 0);
    if (projected < 0) {
      throw new ConflictException({
        error: "BONUS_NEGATIVE_BALANCE",
        message: "Bonus balance cannot go negative",
      });
    }

    // Restore first, then clawback (§3b.4).
    let wroteRestore = false;
    let wroteClaw = false;
    if (needRestore) {
      try {
        await tx.bonusLedger.create({
          data: {
            accountId,
            type: BonusLedgerType.REDEEM_RESTORE,
            points: restorePts,
            orderId: input.orderId,
            idempotencyKey: restoreKey,
            actorType: ActorType.SYSTEM,
          },
        });
        balance += restorePts;
        wroteRestore = true;
      } catch (e) {
        if (!isBonusIdempotencyConflict(e)) throw e;
      }
    }

    if (needClaw) {
      try {
        await tx.bonusLedger.create({
          data: {
            accountId,
            type: BonusLedgerType.CLAWBACK,
            points: -clawbackPts,
            orderId: input.orderId,
            idempotencyKey: clawKey,
            actorType: ActorType.SYSTEM,
          },
        });
        balance -= clawbackPts;
        wroteClaw = true;
      } catch (e) {
        if (!isBonusIdempotencyConflict(e)) throw e;
      }
    }

    if (wroteRestore || wroteClaw) {
      await tx.bonusAccount.update({
        where: { id: accountId },
        data: { balanceCached: balance },
      });
    }

    return {
      clawbackPts: wroteClaw
        ? clawbackPts
        : existingClaw
          ? Math.abs(existingClaw.points)
          : 0,
      restorePts: wroteRestore
        ? restorePts
        : existingRestore
          ? existingRestore.points
          : 0,
      idempotent: !wroteRestore && !wroteClaw,
    };
  }

  private async recomputeOrderPaymentStatusAfterRefund(
    tx: Tx,
    orderId: string,
    grandTotal: Prisma.Decimal,
  ): Promise<PaymentStatus> {
    const succeeded = await tx.refund.findMany({
      where: { orderId, status: RefundStatus.SUCCEEDED },
      select: { amount: true },
    });
    let sum = new Prisma.Decimal(0);
    for (const r of succeeded) sum = sum.add(r.amount);

    const next =
      sum.gt(0) && sum.gte(grandTotal)
        ? PaymentStatus.REFUNDED
        : sum.gt(0)
          ? PaymentStatus.PARTIALLY_REFUNDED
          : PaymentStatus.PAID;

    await tx.order.update({
      where: { id: orderId },
      data: { paymentStatus: next },
    });
    return next;
  }

  private async applyRedeemAndEarn(
    tx: Tx,
    order: {
      id: string;
      userId: string | null;
      bonusPointsRedeemed: number;
    },
    earnPts: number,
    now: Date,
    expiryMonths: number,
  ): Promise<void> {
    if (!order.userId) return;
    const redeemPts = order.bonusPointsRedeemed;
    if (redeemPts <= 0 && earnPts <= 0) return;

    const locked = await tx.$queryRaw<Array<{ id: string; balanceCached: number }>>`
      SELECT id, "balanceCached" FROM "BonusAccount"
      WHERE "userId" = ${order.userId}
      FOR UPDATE
    `;

    let accountId: string;
    let balance: number;
    if (locked.length) {
      accountId = locked[0].id;
      balance = locked[0].balanceCached;
    } else if (earnPts > 0 && redeemPts <= 0) {
      const created = await tx.bonusAccount.create({
        data: { userId: order.userId, balanceCached: 0 },
      });
      accountId = created.id;
      balance = 0;
    } else {
      throw new WebhookSettlementAbortError();
    }

    if (redeemPts > 0) {
      if (balance < redeemPts) {
        throw new WebhookSettlementAbortError();
      }
      await tx.bonusLedger.create({
        data: {
          accountId,
          type: BonusLedgerType.REDEEM,
          points: -redeemPts,
          orderId: order.id,
          idempotencyKey: `redeem:${order.id}`,
          actorType: ActorType.SYSTEM,
        },
      });
      balance -= redeemPts;
    }

    if (earnPts > 0) {
      const expiresAt = new Date(now);
      expiresAt.setMonth(expiresAt.getMonth() + expiryMonths);
      await tx.bonusLedger.create({
        data: {
          accountId,
          type: BonusLedgerType.EARN,
          points: earnPts,
          orderId: order.id,
          idempotencyKey: `earn:${order.id}`,
          expiresAt,
          actorType: ActorType.SYSTEM,
        },
      });
      balance += earnPts;
    }

    await tx.bonusAccount.update({
      where: { id: accountId },
      data: { balanceCached: balance },
    });
  }

  private async createOrRecoverProvider(input: {
    orderId: string;
    provider: FirstAttemptProviderName;
    amount: Prisma.Decimal;
    currencyCode: string;
    idempotencyKey?: string;
  }) {
    const adapter = this.adapterFor(input.provider);
    const idempotencyKey =
      input.idempotencyKey ?? firstAttemptProviderIdempotencyIdentity(input.orderId);
    try {
      return await adapter.createOrRecover({
        orderId: input.orderId,
        amount: input.amount.toFixed(2),
        currencyCode: input.currencyCode,
        idempotencyKey,
      });
    } catch (e) {
      throw this.toHttp(e);
    }
  }

  private toHttp(e: unknown): never {
    if (isProviderCreateRejected(e) || isProviderCreateUnknown(e)) {
      throw new BadGatewayException({
        error: "INTERNAL_ERROR",
        message: e.message,
      });
    }
    throw e;
  }
}

function sha256Hex(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isWebhookEventUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = Array.isArray(e.meta?.target) ? e.meta.target.map(String) : [];
  return target.includes("eventId") || (target.includes("provider") && target.includes("eventId"));
}

function computeEarnPoints(
  order: {
    itemsSubtotal: Prisma.Decimal;
    discountCoupon: Prisma.Decimal;
    discountBonus: Prisma.Decimal;
  },
  perEuro: number,
): number {
  const goods = new Prisma.Decimal(order.itemsSubtotal)
    .minus(order.discountCoupon)
    .minus(order.discountBonus);
  if (goods.lte(0)) return 0;
  const whole = goods.toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN);
  const n = Number.parseInt(whole.toFixed(0), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rate = Number.isInteger(perEuro) && perEuro > 0 ? perEuro : 1;
  return n * rate;
}

/** FLOOR(points * refundAmount / orderTotal) — integer points, Decimal money. */
function floorShare(
  points: number,
  refundAmount: Prisma.Decimal,
  orderTotal: Prisma.Decimal,
): number {
  if (points <= 0 || refundAmount.lte(0) || orderTotal.lte(0)) return 0;
  const raw = new Prisma.Decimal(points).mul(refundAmount).div(orderTotal);
  const floored = raw.toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR);
  const n = Number.parseInt(floored.toFixed(0), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isBonusIdempotencyConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = Array.isArray(e.meta?.target) ? e.meta.target.map(String) : [];
  return target.includes("idempotencyKey") || target.some((t) => t.includes("idempotencyKey"));
}
