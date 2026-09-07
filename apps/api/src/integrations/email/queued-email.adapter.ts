import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../../config/env";
import { AUTH_EMAIL_JOB_OPTIONS } from "./auth-email.queue-config";
import {
  AUTH_EMAIL_QUEUE_NAME,
  contactFormJobId,
  type EmailIntegrationPort,
  type EmailJobPayload,
  type EnqueueAuthEmailInput,
  type EnqueueContactFormJob,
  type EnqueueOrderConfirmationArgs,
  type EnqueueOrderConfirmationInput,
  type EnqueueOrderConfirmationResendArgs,
  type EnqueueOrderCancelledArgs,
  type EnqueueOrderCancelledInput,
  type EnqueueShipmentEmailArgs,
  type EnqueueShipmentEmailInput,
  type EnqueueInvoiceEmailArgs,
  type EnqueueInvoiceEmailInput,
  type EnqueueRefundEmailArgs,
  type EnqueueRefundEmailInput,
  type EnqueueDeliveryEmailArgs,
  type EnqueueDeliveryEmailInput,
  type EnqueueReturnRequestEmailArgs,
  type EnqueueReturnRequestEmailInput,
  orderConfirmationJobId,
  orderConfirmationResendJobId,
  orderConfirmationResendWorkKey,
  orderConfirmationWorkKey,
  orderCancelledJobId,
  orderCancelledWorkKey,
  shipmentEmailJobId,
  shipmentEmailWorkKey,
  invoiceEmailJobId,
  invoiceEmailWorkKey,
  refundEmailJobId,
  refundEmailWorkKey,
  deliveryEmailJobId,
  deliveryEmailWorkKey,
  returnRequestEmailJobId,
  returnRequestEmailWorkKey,
} from "./email-integration.port";

/**
 * 10.10 email enqueue — Auth + Order Confirmation + #17 post-order.
 * Failure here must NOT invalidate tokens or mutate Order / User / Payment / domain (10.1 / 10.10 §3).
 */
@Injectable()
export class QueuedEmailAdapter implements EmailIntegrationPort, OnModuleDestroy {
  private readonly logger = new Logger(QueuedEmailAdapter.name);
  private readonly connection: IORedis;
  private readonly queue: Queue<EmailJobPayload, void, string>;

  constructor() {
    this.connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    this.queue = new Queue<EmailJobPayload, void, string>(AUTH_EMAIL_QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: { ...AUTH_EMAIL_JOB_OPTIONS },
    });
  }

  /** Exposed for verification harnesses. */
  getQueue(): Queue<EmailJobPayload, void, string> {
    return this.queue;
  }

  async enqueueAuthEmail(input: EnqueueAuthEmailInput): Promise<void> {
    const payload: EnqueueAuthEmailInput = {
      idempotencyKey: input.idempotencyKey,
      to: input.to,
      template: input.template,
      tokenId: input.tokenId,
      rawToken: input.rawToken,
      communicationLocale: input.communicationLocale,
    };

    const existing = await this.queue.getJob(input.idempotencyKey);
    if (existing) {
      if (env.NODE_ENV === "development") {
        this.logger.debug(
          `idempotent skip existing jobId=${input.idempotencyKey} template=${input.template}`,
        );
      }
      return;
    }

    try {
      await this.queue.add(input.template, payload, {
        jobId: input.idempotencyKey,
        ...AUTH_EMAIL_JOB_OPTIONS,
      });
    } catch (e) {
      if (isDuplicateJobIdError(e)) {
        if (env.NODE_ENV === "development") {
          this.logger.debug(
            `idempotent skip race jobId=${input.idempotencyKey} template=${input.template}`,
          );
        }
        return;
      }
      throw e;
    }

    if (env.NODE_ENV === "development") {
      this.logger.log(
        `[email-queue] ${input.template} → ${input.to} idempotency=${input.idempotencyKey} locale=${input.communicationLocale}`,
      );
    }
  }

  async enqueueOrderConfirmation(input: EnqueueOrderConfirmationArgs): Promise<void> {
    const idempotencyKey = orderConfirmationWorkKey(input.orderId);
    const jobId = orderConfirmationJobId(input.orderId);
    const payload: EnqueueOrderConfirmationInput = {
      idempotencyKey,
      to: input.to,
      template: "order_confirmation",
      orderId: input.orderId,
      communicationLocale: input.communicationLocale,
      guestAccessToken: input.guestAccessToken,
    };

    const existing = await this.queue.getJob(jobId);
    if (existing) {
      if (env.NODE_ENV === "development") {
        this.logger.debug(
          `idempotent skip existing jobId=${jobId} workKey=${idempotencyKey}`,
        );
      }
      return;
    }

    try {
      await this.queue.add("order_confirmation", payload, {
        jobId,
        ...AUTH_EMAIL_JOB_OPTIONS,
      });
    } catch (e) {
      if (isDuplicateJobIdError(e)) {
        if (env.NODE_ENV === "development") {
          this.logger.debug(
            `idempotent skip race jobId=${jobId} workKey=${idempotencyKey}`,
          );
        }
        return;
      }
      throw e;
    }

    if (env.NODE_ENV === "development") {
      this.logger.log(
        `[email-queue] order_confirmation → ${input.to} workKey=${idempotencyKey} jobId=${jobId} locale=${input.communicationLocale}`,
      );
    }
  }

  async enqueueOrderConfirmationResend(
    input: EnqueueOrderConfirmationResendArgs,
  ): Promise<void> {
    const idempotencyKey = orderConfirmationResendWorkKey(input.orderId, input.resendId);
    const jobId = orderConfirmationResendJobId(input.orderId, input.resendId);
    const payload: EnqueueOrderConfirmationInput = {
      idempotencyKey,
      to: input.to,
      template: "order_confirmation",
      orderId: input.orderId,
      communicationLocale: input.communicationLocale,
      guestAccessToken: input.guestAccessToken,
    };

    const existing = await this.queue.getJob(jobId);
    if (existing) {
      if (env.NODE_ENV === "development") {
        this.logger.debug(
          `idempotent skip existing jobId=${jobId} workKey=${idempotencyKey}`,
        );
      }
      return;
    }

    try {
      await this.queue.add("order_confirmation", payload, {
        jobId,
        ...AUTH_EMAIL_JOB_OPTIONS,
      });
    } catch (e) {
      if (isDuplicateJobIdError(e)) {
        if (env.NODE_ENV === "development") {
          this.logger.debug(
            `idempotent skip race jobId=${jobId} workKey=${idempotencyKey}`,
          );
        }
        return;
      }
      throw e;
    }

    if (env.NODE_ENV === "development") {
      this.logger.log(
        `[email-queue] order_confirmation_resend → ${input.to} workKey=${idempotencyKey} jobId=${jobId} locale=${input.communicationLocale}`,
      );
    }
  }

  async enqueueOrderCancelled(input: EnqueueOrderCancelledArgs): Promise<void> {
    const idempotencyKey = orderCancelledWorkKey(input.orderId);
    const jobId = orderCancelledJobId(input.orderId);
    const payload: EnqueueOrderCancelledInput = {
      idempotencyKey,
      to: input.to,
      template: "order_cancelled",
      orderId: input.orderId,
      communicationLocale: input.communicationLocale,
    };

    const existing = await this.queue.getJob(jobId);
    if (existing) {
      if (env.NODE_ENV === "development") {
        this.logger.debug(
          `idempotent skip existing jobId=${jobId} workKey=${idempotencyKey}`,
        );
      }
      return;
    }

    try {
      await this.queue.add("order_cancelled", payload, {
        jobId,
        ...AUTH_EMAIL_JOB_OPTIONS,
      });
    } catch (e) {
      if (isDuplicateJobIdError(e)) {
        if (env.NODE_ENV === "development") {
          this.logger.debug(
            `idempotent skip race jobId=${jobId} workKey=${idempotencyKey}`,
          );
        }
        return;
      }
      throw e;
    }

    if (env.NODE_ENV === "development") {
      this.logger.log(
        `[email-queue] order_cancelled → ${input.to} workKey=${idempotencyKey} jobId=${jobId} locale=${input.communicationLocale}`,
      );
    }
  }

  async enqueueShipmentEmail(input: EnqueueShipmentEmailArgs): Promise<void> {
    const idempotencyKey = shipmentEmailWorkKey(input.shipmentId);
    const jobId = shipmentEmailJobId(input.shipmentId);
    const payload: EnqueueShipmentEmailInput = {
      idempotencyKey,
      to: input.to,
      template: "shipment",
      shipmentId: input.shipmentId,
      orderId: input.orderId,
      communicationLocale: input.communicationLocale,
      guestAccessToken: input.guestAccessToken,
    };
    await this.addIdempotentJob("shipment", payload, jobId, idempotencyKey, input.to);
  }

  async enqueueInvoiceEmail(input: EnqueueInvoiceEmailArgs): Promise<void> {
    const idempotencyKey = invoiceEmailWorkKey(input.invoiceId);
    const jobId = invoiceEmailJobId(input.invoiceId);
    const payload: EnqueueInvoiceEmailInput = {
      idempotencyKey,
      to: input.to,
      template: "invoice",
      invoiceId: input.invoiceId,
      orderId: input.orderId,
      communicationLocale: input.communicationLocale,
    };
    await this.addIdempotentJob("invoice", payload, jobId, idempotencyKey, input.to);
  }

  async enqueueRefundEmail(input: EnqueueRefundEmailArgs): Promise<void> {
    const idempotencyKey = refundEmailWorkKey(input.refundId);
    const jobId = refundEmailJobId(input.refundId);
    const payload: EnqueueRefundEmailInput = {
      idempotencyKey,
      to: input.to,
      template: "refund",
      refundId: input.refundId,
      orderId: input.orderId,
      communicationLocale: input.communicationLocale,
    };
    await this.addIdempotentJob("refund", payload, jobId, idempotencyKey, input.to);
  }

  async enqueueDeliveryEmail(input: EnqueueDeliveryEmailArgs): Promise<void> {
    const idempotencyKey = deliveryEmailWorkKey(input.orderId);
    const jobId = deliveryEmailJobId(input.orderId);
    const payload: EnqueueDeliveryEmailInput = {
      idempotencyKey,
      to: input.to,
      template: "delivery",
      orderId: input.orderId,
      communicationLocale: input.communicationLocale,
      guestAccessToken: input.guestAccessToken,
    };
    await this.addIdempotentJob("delivery", payload, jobId, idempotencyKey, input.to);
  }

  async enqueueReturnRequestEmail(input: EnqueueReturnRequestEmailArgs): Promise<void> {
    const idempotencyKey = returnRequestEmailWorkKey(input.returnRequestId);
    const jobId = returnRequestEmailJobId(input.returnRequestId);
    const payload: EnqueueReturnRequestEmailInput = {
      idempotencyKey,
      to: input.to,
      template: "return_request",
      returnRequestId: input.returnRequestId,
      orderId: input.orderId,
      communicationLocale: input.communicationLocale,
      guestAccessToken: input.guestAccessToken,
    };
    await this.addIdempotentJob("return_request", payload, jobId, idempotencyKey, input.to);
  }

  private async addIdempotentJob(
    name: string,
    payload: EmailJobPayload,
    jobId: string,
    idempotencyKey: string,
    to: string,
  ): Promise<void> {
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      if (env.NODE_ENV === "development") {
        this.logger.debug(
          `idempotent skip existing jobId=${jobId} workKey=${idempotencyKey}`,
        );
      }
      return;
    }

    try {
      await this.queue.add(name, payload, {
        jobId,
        ...AUTH_EMAIL_JOB_OPTIONS,
      });
    } catch (e) {
      if (isDuplicateJobIdError(e)) {
        if (env.NODE_ENV === "development") {
          this.logger.debug(
            `idempotent skip race jobId=${jobId} workKey=${idempotencyKey}`,
          );
        }
        return;
      }
      throw e;
    }

    if (env.NODE_ENV === "development") {
      this.logger.log(
        `[email-queue] ${name} → ${to} workKey=${idempotencyKey} jobId=${jobId}`,
      );
    }
  }

  async enqueueContactForm(input: {
    submissionId: string;
    to: string;
    name: string;
    replyEmail: string;
    subject: string;
    message: string;
    orderNumber?: string;
    userId?: string;
  }): Promise<void> {
    const jobId = contactFormJobId(input.submissionId);
    const payload: EnqueueContactFormJob = {
      idempotencyKey: jobId,
      to: input.to,
      template: "contact_form",
      communicationLocale: "de",
      name: input.name,
      replyEmail: input.replyEmail,
      subject: input.subject,
      message: input.message,
      orderNumber: input.orderNumber,
      userId: input.userId,
    };

    await this.queue.add("contact_form", payload, {
      jobId,
      ...AUTH_EMAIL_JOB_OPTIONS,
    });

    if (env.NODE_ENV === "development") {
      this.logger.log(`[email-queue] contact_form → ${input.to} jobId=${jobId}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    this.connection.disconnect();
  }
}

function isDuplicateJobIdError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /already exists|duplicate/i.test(msg);
}
