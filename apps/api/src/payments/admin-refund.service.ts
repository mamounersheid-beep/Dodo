import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ActorType,
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
} from "@dodo/database";
import { RoleCode } from "@dodo/shared-types";
import type { AuthUser } from "../auth/auth.types";
import { verifyPassword } from "../auth/crypto.util";
import { AuditService } from "../audit/audit.service";
import { AdminHttpIdempotencyService } from "../admin-http-idempotency/admin-http-idempotency.service";
import { hashAdminHttpIdempotencyFingerprint } from "../admin-http-idempotency/admin-http-idempotency.key";
import { PrismaService } from "../prisma/prisma.service";
import type {
  AdminRefundDto,
  CancelAdminRefundDto,
  CreateAdminRefundDto,
  RetryAdminRefundDto,
} from "./dto/admin-refund.dto";
import { PaymentsService } from "./payments.service";
import {
  REFUND_PROVIDER_ADAPTERS,
  type RefundProviderAdapter,
  type RefundProviderName,
  type RefundProviderOutcome,
} from "./refund-provider.port";

const REFUNDABLE_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
  OrderStatus.RETURN_REQUESTED,
  OrderStatus.RETURNED,
  OrderStatus.CANCELLED,
]);

const REFUNDABLE_PAYMENT_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.PAID,
  PaymentStatus.PARTIALLY_REFUNDED,
]);

type Tx = Prisma.TransactionClient;

@Injectable()
export class AdminRefundService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AdminHttpIdempotencyService)
    private readonly idempotency: AdminHttpIdempotencyService,
    @Inject(REFUND_PROVIDER_ADAPTERS)
    private readonly adapters: RefundProviderAdapter[],
  ) {}

  async listForOrder(orderId: string): Promise<{ items: AdminRefundDto[] }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
    }
    const rows = await this.prisma.refund.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
    });
    return {
      items: rows.map((r) => this.toDto(r, order.paymentStatus)),
    };
  }

  async getOne(refundId: string): Promise<AdminRefundDto> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Refund not found" });
    }
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: refund.orderId } });
    return this.toDto(refund, order.paymentStatus);
  }

  async create(
    orderId: string,
    dto: CreateAdminRefundDto,
    actor: AuthUser,
    idempotencyKey: string | undefined,
  ): Promise<AdminRefundDto> {
    await this.assertMutationActor(actor);
    await this.assertConfirmed(dto.confirmed);
    await this.assertPassword(actor.id, dto.currentPassword, orderId);

    const orderPeek = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!orderPeek) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
    }

    const fingerprint = hashAdminHttpIdempotencyFingerprint({
      operation: "refund.create",
      targetId: orderId,
      canonicalBody: {
        amount: dto.amount ?? null,
        full: dto.full === true,
        paymentId: dto.paymentId ?? null,
        returnRequestId: dto.returnRequestId ?? null,
        reason: dto.reason ?? null,
        currencyCode: dto.currencyCode ?? null,
        confirmed: true,
      },
    });

    const claim = await this.idempotency.claimOrReplay({
      actorId: actor.id,
      keyRaw: idempotencyKey,
      fingerprint,
      operation: "refund.create",
      targetId: orderId,
    });
    if (claim.kind === "replay") {
      return claim.body as AdminRefundDto;
    }

    try {
      const { refundId, payment } = await this.insertPendingRefund({
        orderId,
        amount: dto.amount,
        full: dto.full === true,
        paymentId: dto.paymentId,
        returnRequestId: dto.returnRequestId,
        reason: dto.reason,
        currencyCode: dto.currencyCode,
        actorId: actor.id,
      });

      const dtoOut = await this.runProviderAfterPending({
        refundId,
        payment,
        actorId: actor.id,
      });
      await this.idempotency.complete({ id: claim.id, httpStatus: 200, body: dtoOut });
      return dtoOut;
    } catch (e) {
      await this.idempotency.deleteClaim(claim.id);
      throw e;
    }
  }

  async recover(
    refundId: string,
    actor: AuthUser,
    idempotencyKey: string | undefined,
  ): Promise<AdminRefundDto> {
    await this.assertMutationActor(actor);

    const peek = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!peek) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Refund not found" });
    }
    if (peek.status !== RefundStatus.PENDING) {
      throw new ConflictException({
        error: "REFUND_INVALID_STATE",
        message: `Refund status ${peek.status} cannot recover`,
      });
    }

    const fingerprint = hashAdminHttpIdempotencyFingerprint({
      operation: "refund.recover",
      targetId: refundId,
      canonicalBody: {},
    });
    const claim = await this.idempotency.claimOrReplay({
      actorId: actor.id,
      keyRaw: idempotencyKey,
      fingerprint,
      operation: "refund.recover",
      targetId: refundId,
    });
    if (claim.kind === "replay") {
      return claim.body as AdminRefundDto;
    }

    try {
      const payment = await this.prisma.payment.findUniqueOrThrow({
        where: { id: peek.paymentId },
      });
      if (!payment.providerIntentId) {
        throw new ConflictException({
          error: "PAYMENT_NOT_ELIGIBLE",
          message: "Payment missing providerIntentId",
        });
      }
      const adapter = this.adapterFor(payment.provider);
      const outcome = await adapter.reconcile({
        refundId,
        provider: adapter.provider,
        providerIntentId: payment.providerIntentId,
        providerRefundId: peek.providerRefundId,
      });

      await this.audit.write({
        actorType: ActorType.ADMIN,
        actorId: actor.id,
        action: "refund.provider_attempt",
        entityType: "Refund",
        entityId: refundId,
        afterJson: {
          outcome: this.auditOutcome(outcome),
          provider: adapter.provider,
          providerIntentId: payment.providerIntentId,
          providerRefundId:
            outcome.kind === "succeeded" || outcome.kind === "pending" || outcome.kind === "rejected"
              ? outcome.providerRefundId ?? null
              : peek.providerRefundId,
        },
      });

      const dtoOut = await this.applyProviderOutcome({
        refundId,
        outcome,
        allowCreate: false,
        payment: {
          id: payment.id,
          provider: payment.provider,
          providerIntentId: payment.providerIntentId,
        },
        actorId: actor.id,
      });
      await this.idempotency.complete({ id: claim.id, httpStatus: 200, body: dtoOut });
      return dtoOut;
    } catch (e) {
      await this.idempotency.deleteClaim(claim.id);
      throw e;
    }
  }

  async cancel(
    refundId: string,
    dto: CancelAdminRefundDto,
    actor: AuthUser,
    idempotencyKey: string | undefined,
  ): Promise<AdminRefundDto> {
    await this.assertMutationActor(actor);
    await this.assertConfirmed(dto.confirmed);
    const peek = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!peek) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Refund not found" });
    }
    await this.assertPassword(actor.id, dto.currentPassword, peek.orderId);

    const fingerprint = hashAdminHttpIdempotencyFingerprint({
      operation: "refund.cancel",
      targetId: refundId,
      canonicalBody: { confirmed: true },
    });
    const claim = await this.idempotency.claimOrReplay({
      actorId: actor.id,
      keyRaw: idempotencyKey,
      fingerprint,
      operation: "refund.cancel",
      targetId: refundId,
    });
    if (claim.kind === "replay") {
      return claim.body as AdminRefundDto;
    }

    try {
      if (peek.status !== RefundStatus.PENDING) {
        throw new ConflictException({
          error: "REFUND_INVALID_STATE",
          message: `Refund status ${peek.status} cannot cancel`,
        });
      }

      const payment = await this.prisma.payment.findUniqueOrThrow({
        where: { id: peek.paymentId },
      });
      if (!payment.providerIntentId) {
        throw new ConflictException({
          error: "PAYMENT_NOT_ELIGIBLE",
          message: "Payment missing providerIntentId",
        });
      }
      const adapter = this.adapterFor(payment.provider);
      const outcome = await adapter.reconcile({
        refundId,
        provider: adapter.provider,
        providerIntentId: payment.providerIntentId,
        providerRefundId: peek.providerRefundId,
      });

      if (outcome.kind === "succeeded" || outcome.kind === "orphan_succeeded") {
        const dtoOut = await this.applyProviderOutcome({
          refundId,
          outcome: { kind: "succeeded", providerRefundId: outcome.providerRefundId },
          allowCreate: false,
          payment: {
            id: payment.id,
            provider: payment.provider,
            providerIntentId: payment.providerIntentId,
          },
          actorId: actor.id,
        });
        await this.idempotency.complete({ id: claim.id, httpStatus: 200, body: dtoOut });
        return dtoOut;
      }

      if (outcome.kind === "lookup_failed" || outcome.kind === "pending") {
        // pending with no proof of absence when providerRefundId path is ambiguous
        if (outcome.kind === "lookup_failed" || outcome.providerRefundId || peek.providerRefundId) {
          throw new ConflictException({
            error: "REFUND_CANCEL_NOT_SAFE",
            message: "Provider state unsafe to cancel",
          });
        }
        // reconcile returned pending with no providerRefundId and none stored → treat as no provider refund
      }

      if (outcome.kind === "rejected") {
        // explicit reject at provider — still cancel local PENDING after reconcile proved no success
      }

      const dtoOut = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${peek.orderId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Refund" WHERE id = ${refundId} FOR UPDATE`;
        const current = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
        if (current.status !== RefundStatus.PENDING) {
          throw new ConflictException({
            error: "REFUND_INVALID_STATE",
            message: `Refund status ${current.status} cannot cancel`,
          });
        }
        const updated = await tx.refund.update({
          where: { id: refundId },
          data: { status: RefundStatus.CANCELLED, completedAt: new Date() },
        });
        const order = await tx.order.findUniqueOrThrow({ where: { id: peek.orderId } });
        await this.audit.write({
          actorType: ActorType.ADMIN,
          actorId: actor.id,
          action: "refund.cancelled",
          entityType: "Refund",
          entityId: refundId,
          beforeJson: { status: RefundStatus.PENDING },
          afterJson: { status: RefundStatus.CANCELLED },
        });
        return this.toDto(updated, order.paymentStatus);
      });

      await this.idempotency.complete({ id: claim.id, httpStatus: 200, body: dtoOut });
      return dtoOut;
    } catch (e) {
      await this.idempotency.deleteClaim(claim.id);
      throw e;
    }
  }

  async retry(
    refundId: string,
    dto: RetryAdminRefundDto,
    actor: AuthUser,
    idempotencyKey: string | undefined,
  ): Promise<AdminRefundDto> {
    await this.assertMutationActor(actor);
    await this.assertConfirmed(dto.confirmed);

    const failed = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!failed) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Refund not found" });
    }
    await this.assertPassword(actor.id, dto.currentPassword, failed.orderId);

    if (failed.status !== RefundStatus.FAILED) {
      throw new ConflictException({
        error: "REFUND_INVALID_STATE",
        message: `Refund status ${failed.status} cannot retry`,
      });
    }

    const fingerprint = hashAdminHttpIdempotencyFingerprint({
      operation: "refund.retry",
      targetId: refundId,
      canonicalBody: {
        amount: dto.amount ?? null,
        full: dto.full === true,
        paymentId: dto.paymentId ?? null,
        returnRequestId: dto.returnRequestId ?? null,
        reason: dto.reason ?? null,
        currencyCode: dto.currencyCode ?? null,
        confirmed: true,
      },
    });
    const claim = await this.idempotency.claimOrReplay({
      actorId: actor.id,
      keyRaw: idempotencyKey,
      fingerprint,
      operation: "refund.retry",
      targetId: refundId,
    });
    if (claim.kind === "replay") {
      return claim.body as AdminRefundDto;
    }

    try {
      const payment = await this.prisma.payment.findUniqueOrThrow({
        where: { id: failed.paymentId },
      });
      const adapter = this.adapterFor(payment.provider);
      const prior = await adapter.reconcile({
        refundId: failed.id,
        provider: adapter.provider,
        providerIntentId: payment.providerIntentId!,
        providerRefundId: failed.providerRefundId,
      });

      if (prior.kind === "lookup_failed" || prior.kind === "pending") {
        if (prior.kind === "lookup_failed" || prior.providerRefundId) {
          throw new ConflictException({
            error: "REFUND_RETRY_UNSAFE",
            message: "Prior FAILED refund reconcile is unresolved",
          });
        }
      }
      if (prior.kind === "succeeded" || prior.kind === "orphan_succeeded") {
        throw new ConflictException({
          error: "REFUND_PROVIDER_ORPHAN",
          message: "Provider success exists on FAILED refund — no sibling",
        });
      }

      const { refundId: newId, payment: pay } = await this.insertPendingRefund({
        orderId: failed.orderId,
        amount: dto.amount ?? failed.amount.toFixed(2),
        full: dto.full === true,
        paymentId: dto.paymentId ?? failed.paymentId,
        returnRequestId:
          dto.returnRequestId !== undefined ? dto.returnRequestId : failed.returnRequestId,
        reason: dto.reason ?? failed.reason,
        currencyCode: dto.currencyCode ?? failed.currencyCode,
        actorId: actor.id,
      });

      const dtoOut = await this.runProviderAfterPending({
        refundId: newId,
        payment: pay,
        actorId: actor.id,
      });
      await this.idempotency.complete({ id: claim.id, httpStatus: 200, body: dtoOut });
      return dtoOut;
    } catch (e) {
      await this.idempotency.deleteClaim(claim.id);
      throw e;
    }
  }

  // ── internals ────────────────────────────────────────────────────

  private async insertPendingRefund(input: {
    orderId: string;
    amount?: string;
    full: boolean;
    paymentId?: string;
    returnRequestId?: string | null;
    reason?: string;
    currencyCode?: string;
    actorId: string;
  }): Promise<{
    refundId: string;
    payment: {
      id: string;
      provider: string;
      providerIntentId: string;
      amount: Prisma.Decimal;
      currencyCode: string;
      status: PaymentStatus;
    };
  }> {
    if (input.full === true && input.amount !== undefined) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "amount and full are mutually exclusive",
      });
    }
    if (input.full !== true && (input.amount === undefined || input.amount.trim() === "")) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "amount or full=true required",
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${input.orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: input.orderId } });
      if (!order) {
        throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
      }

      this.assertOrderRefundable(order.status, order.paymentStatus);

      const payment = await this.resolvePayment(tx, input.orderId, input.paymentId);

      if (input.returnRequestId) {
        const rr = await tx.returnRequest.findUnique({ where: { id: input.returnRequestId } });
        if (!rr || rr.orderId !== input.orderId) {
          throw new NotFoundException({
            error: "NOT_FOUND",
            message: "returnRequestId not found on order",
          });
        }
      }

      const remaining = await this.remainingRefundable(tx, payment.id, payment.amount);
      if (remaining.lte(0)) {
        throw new ConflictException({
          error: "ORDER_NOT_REFUNDABLE",
          message: "No remaining refundable amount",
        });
      }

      let amountDec: Prisma.Decimal;
      if (input.full) {
        amountDec = remaining;
      } else {
        amountDec = this.parseAmount(input.amount!);
        if (amountDec.lte(0)) {
          throw new BadRequestException({
            error: "INVALID_REFUND_AMOUNT",
            message: "amount must be > 0",
          });
        }
        if (amountDec.gt(remaining)) {
          throw new ConflictException({
            error: "REFUND_AMOUNT_EXCEEDS_REMAINING",
            message: "amount exceeds remainingRefundable",
          });
        }
      }

      const currency = (input.currencyCode ?? payment.currencyCode).toUpperCase();
      if (currency !== payment.currencyCode.toUpperCase()) {
        throw new BadRequestException({
          error: "CURRENCY_MISMATCH",
          message: "currencyCode must match Payment.currencyCode",
        });
      }

      const reason = (input.reason ?? "").trim() || "admin_refund";
      const created = await tx.refund.create({
        data: {
          orderId: input.orderId,
          paymentId: payment.id,
          returnRequestId: input.returnRequestId ?? null,
          amount: amountDec,
          currencyCode: payment.currencyCode,
          status: RefundStatus.PENDING,
          reason,
          refundTotal: amountDec,
        },
      });

      await this.audit.write({
        actorType: ActorType.ADMIN,
        actorId: input.actorId,
        action: "refund.created",
        entityType: "Refund",
        entityId: created.id,
        afterJson: {
          status: RefundStatus.PENDING,
          amount: amountDec.toFixed(2),
          currencyCode: payment.currencyCode,
          paymentId: payment.id,
          orderId: input.orderId,
          returnRequestId: input.returnRequestId ?? null,
        },
      });

      return {
        refundId: created.id,
        payment: {
          id: payment.id,
          provider: payment.provider,
          providerIntentId: payment.providerIntentId!,
          amount: payment.amount,
          currencyCode: payment.currencyCode,
          status: payment.status,
        },
      };
    });
  }

  private async runProviderAfterPending(input: {
    refundId: string;
    payment: {
      id: string;
      provider: string;
      providerIntentId: string;
      amount: Prisma.Decimal;
      currencyCode: string;
    };
    actorId: string;
  }): Promise<AdminRefundDto> {
    const refund = await this.prisma.refund.findUniqueOrThrow({
      where: { id: input.refundId },
    });
    const adapter = this.adapterFor(input.payment.provider);

    const prior = await adapter.reconcile({
      refundId: input.refundId,
      provider: adapter.provider,
      providerIntentId: input.payment.providerIntentId,
      providerRefundId: refund.providerRefundId,
    });

    let outcome: RefundProviderOutcome;
    if (prior.kind === "succeeded" || prior.kind === "orphan_succeeded") {
      outcome = { kind: "succeeded", providerRefundId: prior.providerRefundId };
    } else if (prior.kind === "rejected") {
      outcome = prior;
    } else if (prior.kind === "lookup_failed") {
      outcome = { kind: "pending" };
    } else if (prior.kind === "pending" && prior.providerRefundId) {
      outcome = prior;
    } else {
      outcome = await adapter.createRefund({
        refundId: input.refundId,
        provider: adapter.provider,
        providerIntentId: input.payment.providerIntentId,
        amount: refund.amount.toFixed(2),
        currencyCode: refund.currencyCode,
      });
    }

    await this.audit.write({
      actorType: ActorType.ADMIN,
      actorId: input.actorId,
      action: "refund.provider_attempt",
      entityType: "Refund",
      entityId: input.refundId,
      afterJson: {
        outcome: this.auditOutcome(outcome),
        provider: adapter.provider,
        providerIntentId: input.payment.providerIntentId,
        providerRefundId:
          "providerRefundId" in outcome ? outcome.providerRefundId ?? null : null,
      },
    });

    return this.applyProviderOutcome({
      refundId: input.refundId,
      outcome,
      allowCreate: true,
      payment: input.payment,
      actorId: input.actorId,
    });
  }

  private async applyProviderOutcome(input: {
    refundId: string;
    outcome: RefundProviderOutcome;
    allowCreate: boolean;
    payment: { id: string; provider: string; providerIntentId: string };
    actorId: string;
  }): Promise<AdminRefundDto> {
    const { refundId, outcome } = input;

    if (outcome.kind === "succeeded" || outcome.kind === "orphan_succeeded") {
      if (outcome.providerRefundId) {
        await this.prisma.refund.update({
          where: { id: refundId },
          data: { providerRefundId: outcome.providerRefundId },
        });
      }
      const settled = await this.payments.markRefundSucceeded(refundId);
      await this.audit.write({
        actorType: ActorType.ADMIN,
        actorId: input.actorId,
        action: "refund.succeeded",
        entityType: "Refund",
        entityId: refundId,
        beforeJson: { status: RefundStatus.PENDING },
        afterJson: {
          status: RefundStatus.SUCCEEDED,
          paymentStatus: settled.paymentStatus,
          providerRefundId: outcome.providerRefundId,
        },
      });
      const refund = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
      return this.toDto(refund, settled.paymentStatus);
    }

    if (outcome.kind === "rejected") {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Refund" WHERE id = ${refundId} FOR UPDATE`;
        const current = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
        if (current.status !== RefundStatus.PENDING) {
          throw new ConflictException({
            error: "REFUND_INVALID_STATE",
            message: `Refund status ${current.status}`,
          });
        }
        return tx.refund.update({
          where: { id: refundId },
          data: {
            status: RefundStatus.FAILED,
            completedAt: new Date(),
            providerRefundId: outcome.providerRefundId ?? current.providerRefundId,
          },
        });
      });
      await this.audit.write({
        actorType: ActorType.ADMIN,
        actorId: input.actorId,
        action: "refund.failed",
        entityType: "Refund",
        entityId: refundId,
        beforeJson: { status: RefundStatus.PENDING },
        afterJson: {
          status: RefundStatus.FAILED,
          errorCode: outcome.errorCode ?? null,
        },
      });
      const order = await this.prisma.order.findUniqueOrThrow({
        where: { id: updated.orderId },
      });
      return this.toDto(updated, order.paymentStatus);
    }

    // pending / lookup_failed → stay PENDING (optionally persist providerRefundId)
    if (
      (outcome.kind === "pending" || outcome.kind === "lookup_failed") &&
      outcome.kind === "pending" &&
      outcome.providerRefundId
    ) {
      await this.prisma.refund.update({
        where: { id: refundId },
        data: { providerRefundId: outcome.providerRefundId },
      });
    }

    const refund = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: refund.orderId } });
    return this.toDto(refund, order.paymentStatus);
  }

  private async resolvePayment(
    tx: Tx,
    orderId: string,
    paymentId: string | undefined,
  ) {
    const eligible = await tx.payment.findMany({
      where: {
        orderId,
        status: PaymentStatus.PAID,
        providerIntentId: { not: null },
      },
    });

    if (paymentId) {
      const row = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!row || row.orderId !== orderId) {
        throw new NotFoundException({ error: "NOT_FOUND", message: "Payment not found" });
      }
      if (row.status !== PaymentStatus.PAID || !row.providerIntentId) {
        throw new ConflictException({
          error: "PAYMENT_NOT_ELIGIBLE",
          message: "Payment is not eligible for refund",
        });
      }
      return row;
    }

    if (eligible.length === 0) {
      throw new ConflictException({
        error: "NO_ELIGIBLE_PAYMENT",
        message: "No eligible payment on order",
      });
    }
    if (eligible.length > 1) {
      throw new ConflictException({
        error: "AMBIGUOUS_PAYMENT",
        message: "Multiple eligible payments — paymentId required",
      });
    }
    return eligible[0];
  }

  private async remainingRefundable(
    tx: Tx,
    paymentId: string,
    paymentAmount: Prisma.Decimal,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.refund.findMany({
      where: {
        paymentId,
        status: { in: [RefundStatus.SUCCEEDED, RefundStatus.PENDING] },
      },
      select: { amount: true },
    });
    let used = new Prisma.Decimal(0);
    for (const r of rows) used = used.add(r.amount);
    return paymentAmount.sub(used);
  }

  private assertOrderRefundable(status: OrderStatus, paymentStatus: PaymentStatus): void {
    if (paymentStatus === PaymentStatus.REFUNDED) {
      throw new ConflictException({
        error: "ORDER_NOT_REFUNDABLE",
        message: "Order already fully refunded",
      });
    }
    if (!REFUNDABLE_PAYMENT_STATUSES.has(paymentStatus)) {
      throw new ConflictException({
        error: "ORDER_NOT_REFUNDABLE",
        message: "paymentStatus not refundable",
      });
    }
    if (status === OrderStatus.PLACED) {
      throw new ConflictException({
        error: "ORDER_NOT_REFUNDABLE",
        message: "PLACED orders are not refundable",
      });
    }
    if (!REFUNDABLE_ORDER_STATUSES.has(status)) {
      throw new ConflictException({
        error: "ORDER_NOT_REFUNDABLE",
        message: `Order status ${status} not refundable`,
      });
    }
  }

  private parseAmount(raw: string): Prisma.Decimal {
    const t = raw.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(t)) {
      throw new BadRequestException({
        error: "INVALID_REFUND_AMOUNT",
        message: "amount must be a positive decimal string",
      });
    }
    return new Prisma.Decimal(t);
  }

  private adapterFor(provider: string): RefundProviderAdapter {
    const name = provider as RefundProviderName;
    const found = this.adapters.find((a) => a.provider === name);
    if (!found) {
      throw new ConflictException({
        error: "PAYMENT_NOT_ELIGIBLE",
        message: `No refund adapter for provider ${provider}`,
      });
    }
    return found;
  }

  private async assertMutationActor(actor: AuthUser): Promise<void> {
    const roles = actor.roles ?? [];
    if (!roles.includes(RoleCode.ADMIN) && !roles.includes(RoleCode.OWNER)) {
      throw new ForbiddenException({ error: "FORBIDDEN", message: "Admin or Owner required" });
    }
  }

  private async assertConfirmed(confirmed: unknown): Promise<void> {
    if (confirmed !== true) {
      throw new BadRequestException({
        error: "CONFIRMATION_REQUIRED",
        message: "confirmed must be true",
      });
    }
  }

  private async assertPassword(
    userId: string,
    currentPassword: string,
    orderId: string,
  ): Promise<void> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!row.passwordHash || !(await verifyPassword(row.passwordHash, currentPassword))) {
      await this.audit.write({
        actorType: ActorType.ADMIN,
        actorId: userId,
        action: "refund.create_denied",
        entityType: "Order",
        entityId: orderId,
        afterJson: { reason: "INVALID_PASSWORD" },
      });
      throw new UnauthorizedException({
        error: "INVALID_PASSWORD",
        message: "Password incorrect",
      });
    }
  }

  private auditOutcome(outcome: RefundProviderOutcome): string {
    if (outcome.kind === "succeeded" || outcome.kind === "orphan_succeeded") return "succeeded";
    if (outcome.kind === "rejected") return "rejected";
    if (outcome.kind === "lookup_failed") return "unknown";
    return "unknown";
  }

  private toDto(
    refund: {
      id: string;
      orderId: string;
      paymentId: string;
      returnRequestId: string | null;
      amount: Prisma.Decimal;
      currencyCode: string;
      status: RefundStatus;
      providerRefundId: string | null;
      reason: string;
      createdAt: Date;
      completedAt: Date | null;
    },
    orderPaymentStatus: PaymentStatus | string,
  ): AdminRefundDto {
    return {
      id: refund.id,
      orderId: refund.orderId,
      paymentId: refund.paymentId,
      returnRequestId: refund.returnRequestId,
      amount: refund.amount.toFixed(2),
      currencyCode: refund.currencyCode,
      status: refund.status,
      providerRefundId: refund.providerRefundId,
      reason: refund.reason || null,
      createdAt: refund.createdAt.toISOString(),
      completedAt: refund.completedAt ? refund.completedAt.toISOString() : null,
      orderPaymentStatus: String(orderPaymentStatus),
    };
  }
}
