import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { env } from "../../config/env";
import { PrismaService } from "../../prisma/prisma.service";
import { PostOrderEmailHooks } from "../../integrations/email/post-order-email.hooks";
import {
  invoicePdfDlqJobId,
  INVOICE_PDF_QUEUE_NAME,
} from "./invoice-pdf.keys";
import {
  INVOICE_PDF_DLQ_NAME,
  INVOICE_PDF_JOB_ATTEMPTS,
} from "./invoice-pdf.queue-config";
import {
  INVOICE_PDF_OBJECT_STORAGE,
  type InvoicePdfJobPayload,
  type InvoicePdfObjectStorage,
} from "./invoice-pdf.port";
import { processInvoicePdfJob } from "./invoice-pdf.processor";

export type InvoicePdfDlqPayload = InvoicePdfJobPayload & {
  failedAt: string;
  attemptsMade: number;
  failedReason: string;
  sourceJobId: string;
};

@Injectable()
export class InvoicePdfWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvoicePdfWorkerService.name);
  private connection?: IORedis;
  private worker?: Worker<InvoicePdfJobPayload, void, string>;
  private dlq?: Queue<InvoicePdfDlqPayload, void, string>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(INVOICE_PDF_OBJECT_STORAGE) private readonly storage: InvoicePdfObjectStorage,
    private readonly postOrderEmail: PostOrderEmailHooks,
  ) {}

  onModuleInit(): void {
    this.connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    this.dlq = new Queue<InvoicePdfDlqPayload, void, string>(INVOICE_PDF_DLQ_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: false,
        removeOnFail: false,
      },
    });

    this.worker = new Worker<InvoicePdfJobPayload, void, string>(
      INVOICE_PDF_QUEUE_NAME,
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
      `Invoice PDF worker listening on queue=${INVOICE_PDF_QUEUE_NAME} attempts=${INVOICE_PDF_JOB_ATTEMPTS} dlq=${INVOICE_PDF_DLQ_NAME}`,
    );
  }

  private async handle(job: Job<InvoicePdfJobPayload, void, string>): Promise<void> {
    const payload = job.data;
    if (!payload?.invoiceId || !payload.idempotencyKey) {
      throw new Error("invalid invoice-pdf job payload");
    }
    const result = await processInvoicePdfJob(payload.invoiceId, {
      prisma: this.prisma,
      storage: this.storage,
      afterInvoicePdfReady: (id) => this.postOrderEmail.afterInvoicePdfReady(id),
    });
    if (env.NODE_ENV === "development") {
      this.logger.debug(
        `processed invoice-pdf invoiceId=${payload.invoiceId} result=${result.status} attempt=${job.attemptsMade}`,
      );
    }
  }

  private async onJobFailed(
    job: Job<InvoicePdfJobPayload, void, string> | undefined,
    err: Error,
  ): Promise<void> {
    if (!job || !this.dlq) return;
    const maxAttempts = job.opts.attempts ?? INVOICE_PDF_JOB_ATTEMPTS;
    if (job.attemptsMade < maxAttempts) return;

    const invoiceId = job.data?.invoiceId;
    if (!invoiceId) return;

    const dlqId = invoicePdfDlqJobId(invoiceId);
    const payload: InvoicePdfDlqPayload = {
      ...job.data,
      failedAt: new Date().toISOString(),
      attemptsMade: job.attemptsMade,
      failedReason: err?.message ?? String(err),
      sourceJobId: String(job.id ?? ""),
    };
    try {
      const existing = await this.dlq.getJob(dlqId);
      if (existing) return;
      await this.dlq.add("failed", payload, { jobId: dlqId });
      this.logger.warn(
        `invoice-pdf DLQ invoiceId=${invoiceId} attempts=${job.attemptsMade} reason=${payload.failedReason}`,
      );
    } catch (e) {
      this.logger.error(
        `invoice-pdf DLQ write failed invoiceId=${invoiceId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.dlq?.close().catch(() => undefined);
    this.connection?.disconnect();
  }
}
