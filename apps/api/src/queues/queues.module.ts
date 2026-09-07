import { Global, Injectable, Module, OnModuleInit } from "@nestjs/common";

/** Queue names registered in step 9 — processors implemented in step 10+. */
export const QUEUE_NAMES = [
  "email", // Auth transactional: enqueue + worker + retry/DLQ + SMTP adapter
  "invoice-pdf", // 10.11 §4a — Invoice PDF generate + private put + pdfObjectKey claim
  "search-sync",
  "earn-bonus",
  "expire-bonus",
  "abandoned-cart",
] as const;

@Injectable()
export class QueuesRegistry implements OnModuleInit {
  readonly names = QUEUE_NAMES;

  onModuleInit() {
    console.log(`[queues] registered (no processors yet): ${this.names.join(", ")}`);
  }
}

@Global()
@Module({
  providers: [QueuesRegistry],
  exports: [QueuesRegistry],
})
export class QueuesModule {}
