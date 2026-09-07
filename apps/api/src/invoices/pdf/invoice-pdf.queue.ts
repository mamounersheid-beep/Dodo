import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../../config/env";
import { PrismaService } from "../../prisma/prisma.service";
import {
  invoicePdfJobId,
  invoicePdfWorkKey,
  INVOICE_PDF_QUEUE_NAME,
} from "./invoice-pdf.keys";
import { INVOICE_PDF_JOB_OPTIONS } from "./invoice-pdf.queue-config";
import type {
  EnqueueInvoicePdfResult,
  InvoicePdfJobPayload,
  InvoicePdfQueuePort,
} from "./invoice-pdf.port";

@Injectable()
export class InvoicePdfQueueAdapter implements InvoicePdfQueuePort, OnModuleDestroy {
  private readonly logger = new Logger(InvoicePdfQueueAdapter.name);
  private readonly connection: IORedis;
  private readonly queue: Queue<InvoicePdfJobPayload, void, string>;

  constructor(private readonly prisma: PrismaService) {
    this.connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    this.queue = new Queue<InvoicePdfJobPayload, void, string>(INVOICE_PDF_QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: { ...INVOICE_PDF_JOB_OPTIONS },
    });
  }

  getQueue(): Queue<InvoicePdfJobPayload, void, string> {
    return this.queue;
  }

  async enqueueGenerate(invoiceId: string): Promise<EnqueueInvoicePdfResult> {
    const existingInv = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { pdfObjectKey: true, status: true },
    });
    if (existingInv?.pdfObjectKey) {
      return "already_ready";
    }

    const idempotencyKey = invoicePdfWorkKey(invoiceId);
    const jobId = invoicePdfJobId(invoiceId);
    const payload: InvoicePdfJobPayload = { idempotencyKey, invoiceId };

    const existing = await this.queue.getJob(jobId);
    if (existing) {
      return "already_queued";
    }

    try {
      await this.queue.add("generate", payload, {
        jobId,
        ...INVOICE_PDF_JOB_OPTIONS,
      });
    } catch (e) {
      if (isDuplicateJobIdError(e)) {
        return "already_queued";
      }
      throw e;
    }

    if (env.NODE_ENV === "development") {
      this.logger.log(
        `[invoice-pdf] enqueue invoiceId=${invoiceId} workKey=${idempotencyKey} jobId=${jobId}`,
      );
    }
    return "enqueued";
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
