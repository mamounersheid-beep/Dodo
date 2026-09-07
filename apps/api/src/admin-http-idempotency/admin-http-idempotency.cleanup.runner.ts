import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { AdminHttpIdempotencyService } from "./admin-http-idempotency.service";

/** Periodic §4f Persist expiry sweep — same OnModuleInit + setInterval pattern as unpaid expiry. */
const SWEEP_INTERVAL_MS = 60_000;

@Injectable()
export class AdminHttpIdempotencyCleanupRunner
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AdminHttpIdempotencyCleanupRunner.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly idempotency: AdminHttpIdempotencyService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log(
      `Admin HTTP idempotency expiry sweep every ${SWEEP_INTERVAL_MS}ms`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.idempotency.purgeExpired();
      if (result.deletedCount > 0) {
        this.logger.log(
          `Purged ${result.deletedCount} expired AdminHttpIdempotency row(s)`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `Admin HTTP idempotency sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
