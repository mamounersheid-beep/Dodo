import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { env } from "../../config/env";
import { PrismaService } from "../../prisma/prisma.service";
import { RedisAuthEmailDeliveryStore } from "./auth-email-delivery.store";
import { processAuthEmailJob } from "./auth-email.processor";
import {
  AUTH_EMAIL_DLQ_NAME,
  AUTH_EMAIL_JOB_ATTEMPTS,
  authEmailDlqJobId,
  contactFormDlqJobId,
  orderConfirmationDlqJobId,
  orderConfirmationResendDlqJobId,
  orderCancelledDlqJobId,
  shipmentEmailDlqJobId,
  invoiceEmailDlqJobId,
  refundEmailDlqJobId,
  deliveryEmailDlqJobId,
  returnRequestEmailDlqJobId,
} from "./auth-email.queue-config";
import {
  AUTH_EMAIL_SENDER,
  type AuthEmailSender,
} from "./auth-email-sender.port";
import {
  AUTH_EMAIL_QUEUE_NAME,
  type AuthEmailTemplate,
  type EmailJobPayload,
  type EnqueueAuthEmailInput,
  type EnqueueOrderConfirmationInput,
  isAuthEmailPayload,
  isContactFormPayload,
  isOrderCancelledPayload,
  isOrderConfirmationPayload,
  isPostOrderEmailPayload,
} from "./email-integration.port";
import { processContactFormJob } from "./contact-form.processor";
import { RedisOrderEmailDeliveryStore } from "./order-email-delivery.store";
import { processOrderCancelledJob } from "./order-cancelled.processor";
import { processOrderConfirmationJob } from "./order-confirmation.processor";
import { processPostOrderEmailJob } from "./post-order-email.processor";
import { SMTP_TRANSPORT, type SmtpTransport } from "./smtp-transport.port";

const AUTH_TEMPLATES = new Set<AuthEmailTemplate>([
  "email_verify",
  "password_reset",
  "email_change",
]);

export type AuthEmailDlqPayload = EnqueueAuthEmailInput & {
  failedAt: string;
  attemptsMade: number;
  failedReason: string;
  sourceJobId: string;
};

export type EmailDlqPayload = EmailJobPayload & {
  failedAt: string;
  attemptsMade: number;
  failedReason: string;
  sourceJobId: string;
};

/**
 * 10.10 email worker — Auth (Slices B–D) + Order Confirmation foundation.
 * SMTP failure → retry/DLQ; must not mutate Order / Payment / Token / User / Session.
 */
@Injectable()
export class AuthEmailWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthEmailWorkerService.name);
  private connection?: IORedis;
  private worker?: Worker<EmailJobPayload, void, string>;
  private dlq?: Queue<EmailDlqPayload, void, string>;
  private authDelivery?: RedisAuthEmailDeliveryStore;
  private orderDelivery?: RedisOrderEmailDeliveryStore;

  constructor(
    @Inject(AUTH_EMAIL_SENDER) private readonly sender: AuthEmailSender,
    @Inject(SMTP_TRANSPORT) private readonly transport: SmtpTransport,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    this.authDelivery = new RedisAuthEmailDeliveryStore(this.connection);
    this.orderDelivery = new RedisOrderEmailDeliveryStore(this.connection);
    this.dlq = new Queue<EmailDlqPayload, void, string>(AUTH_EMAIL_DLQ_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: false,
        removeOnFail: false,
      },
    });

    this.worker = new Worker<EmailJobPayload, void, string>(
      AUTH_EMAIL_QUEUE_NAME,
      async (job) => this.handle(job),
      {
        connection: this.connection,
        concurrency: 2,
      },
    );

    this.worker.on("failed", (job, err) => {
      void this.onJobFailed(job, err);
    });

    this.logger.log(
      `Email worker listening on queue=${AUTH_EMAIL_QUEUE_NAME} attempts=${AUTH_EMAIL_JOB_ATTEMPTS} dlq=${AUTH_EMAIL_DLQ_NAME} (auth + order_confirmation + order_cancelled + contact_form + post-order#17)`,
    );
  }

  private async handle(job: Job<EmailJobPayload, void, string>): Promise<void> {
    const payload = job.data;
    if (!payload?.idempotencyKey || !payload.template || !payload.communicationLocale) {
      throw new Error("invalid email job payload");
    }

    if (isContactFormPayload(payload)) {
      await processContactFormJob(payload, { transport: this.transport });
      if (env.NODE_ENV === "development") {
        this.logger.debug(
          `processed contact_form key=${payload.idempotencyKey} attempt=${job.attemptsMade}`,
        );
      }
      return;
    }

    if (isPostOrderEmailPayload(payload)) {
      const result = await processPostOrderEmailJob(payload, {
        prisma: this.prisma,
        transport: this.transport,
        delivery: this.orderDelivery!,
      });
      if (env.NODE_ENV === "development") {
        this.logger.debug(
          `processed post-order ${payload.template} key=${payload.idempotencyKey} result=${result} attempt=${job.attemptsMade}`,
        );
      }
      return;
    }

    if (isOrderCancelledPayload(payload)) {
      if (!payload.orderId) {
        throw new Error("invalid order cancelled job payload");
      }
      const result = await processOrderCancelledJob(payload, {
        prisma: this.prisma,
        transport: this.transport,
        delivery: this.orderDelivery!,
      });
      if (env.NODE_ENV === "development") {
        this.logger.debug(
          `processed order_cancelled key=${payload.idempotencyKey} result=${result} attempt=${job.attemptsMade}`,
        );
      }
      return;
    }

    if (isOrderConfirmationPayload(payload)) {
      if (!payload.orderId) {
        throw new Error("invalid order confirmation job payload");
      }
      const result = await processOrderConfirmationJob(payload, {
        prisma: this.prisma,
        transport: this.transport,
        delivery: this.orderDelivery!,
      });
      if (env.NODE_ENV === "development") {
        this.logger.debug(
          `processed order_confirmation key=${payload.idempotencyKey} result=${result} attempt=${job.attemptsMade}`,
        );
      }
      return;
    }

    if (!isAuthEmailPayload(payload) || !AUTH_TEMPLATES.has(payload.template)) {
      this.logger.debug(`skip non-email template=${String(payload.template)} jobId=${job.id}`);
      return;
    }

    const result = await processAuthEmailJob(payload, {
      sender: this.sender,
      delivery: this.authDelivery!,
    });

    if (env.NODE_ENV === "development") {
      this.logger.debug(
        `processed ${payload.template} key=${payload.idempotencyKey} result=${result} attempt=${job.attemptsMade}`,
      );
    }
  }

  private async onJobFailed(
    job: Job<EmailJobPayload, void, string> | undefined,
    err: Error,
  ): Promise<void> {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? AUTH_EMAIL_JOB_ATTEMPTS;
    const exhausted = job.attemptsMade >= maxAttempts;

    if (!exhausted) {
      const kind = isContactFormPayload(job.data)
        ? "contact-form"
        : isPostOrderEmailPayload(job.data)
          ? `post-order-${job.data.template}`
          : isOrderCancelledPayload(job.data)
            ? "order-cancelled"
            : isOrderConfirmationPayload(job.data)
              ? "order-confirmation"
              : "auth-email";
      this.logger.warn(
        `${kind} retry scheduled id=${job.id} attempt=${job.attemptsMade}/${maxAttempts} err=${err.message}`,
      );
      return;
    }

    const reason = err.message;
    const dlqId = isContactFormPayload(job.data)
      ? contactFormDlqJobId(job.data.idempotencyKey.replace(/^con:submit:/, ""))
      : isPostOrderEmailPayload(job.data)
        ? postOrderDlqJobId(job.data)
        : isOrderCancelledPayload(job.data)
          ? orderCancelledDlqJobId(job.data.orderId)
          : isOrderConfirmationPayload(job.data)
            ? orderConfirmationDlqJobIdForPayload(job.data)
            : isAuthEmailPayload(job.data)
              ? authEmailDlqJobId(job.data.template, job.data.tokenId)
              : `dlq:unknown:${String(job.id)}`;

    const alertTag = isContactFormPayload(job.data)
      ? "[ALERT][contact-form-dlq]"
      : isPostOrderEmailPayload(job.data)
        ? "[ALERT][post-order-email-dlq]"
        : isOrderCancelledPayload(job.data)
          ? "[ALERT][order-cancelled-dlq]"
          : isOrderConfirmationPayload(job.data)
            ? "[ALERT][order-confirmation-dlq]"
            : "[ALERT][auth-email-dlq]";

    try {
      const existing = await this.dlq!.getJob(dlqId);
      if (!existing) {
        await this.dlq!.add(
          "dead",
          {
            ...job.data,
            failedAt: new Date().toISOString(),
            attemptsMade: job.attemptsMade,
            failedReason: reason,
            sourceJobId: String(job.id),
          },
          { jobId: dlqId },
        );
      }
    } catch (dlqErr) {
      this.logger.error(
        `${alertTag} failed to enqueue DLQ for id=${job.id}: ${
          dlqErr instanceof Error ? dlqErr.message : String(dlqErr)
        }`,
      );
    }

    this.logger.error(
      `${alertTag} exhausted attempts=${job.attemptsMade} ` +
        `jobId=${job.id} key=${job.data.idempotencyKey} template=${job.data.template} ` +
        `reason=${reason}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.dlq?.close().catch(() => undefined);
    this.connection?.disconnect();
  }
}

function orderConfirmationDlqJobIdForPayload(payload: EnqueueOrderConfirmationInput): string {
  const m = /^order-confirmation-resend:([^:]+):(.+)$/.exec(payload.idempotencyKey);
  if (m) return orderConfirmationResendDlqJobId(m[1]!, m[2]!);
  return orderConfirmationDlqJobId(payload.orderId);
}

function postOrderDlqJobId(
  payload: Extract<EmailJobPayload, { template: string }>,
): string {
  switch (payload.template) {
    case "shipment":
      return shipmentEmailDlqJobId(
        (payload as { shipmentId: string }).shipmentId,
      );
    case "invoice":
      return invoiceEmailDlqJobId((payload as { invoiceId: string }).invoiceId);
    case "refund":
      return refundEmailDlqJobId((payload as { refundId: string }).refundId);
    case "delivery":
      return deliveryEmailDlqJobId((payload as { orderId: string }).orderId);
    case "return_request":
      return returnRequestEmailDlqJobId(
        (payload as { returnRequestId: string }).returnRequestId,
      );
    default:
      return `dlq:post:${String((payload as { idempotencyKey: string }).idempotencyKey)}`;
  }
}
