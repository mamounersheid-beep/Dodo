import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { OrdersService } from "./orders.service";

/** Periodic auto-cancel sweep — 10.8 §1b / 10.3 #4 (implementation choice: periodic). */
const SWEEP_INTERVAL_MS = 60_000;

@Injectable()
export class UnpaidOrderExpiryRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UnpaidOrderExpiryRunner.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly orders: OrdersService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log(`Unpaid order expiry sweep every ${SWEEP_INTERVAL_MS}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.orders.expireUnpaidPlacedOrders();
      if (result.expiredCount > 0) {
        this.logger.log(`Auto-cancelled ${result.expiredCount} unpaid order(s)`);
      }
    } catch (e) {
      this.logger.warn(
        `Unpaid expiry sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
