import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AuditModule } from "../audit/audit.module";
import { AdminHttpIdempotencyModule } from "../admin-http-idempotency/admin-http-idempotency.module";
import { AdminOrderRefundsController } from "./admin-order-refunds.controller";
import { AdminRefundService } from "./admin-refund.service";
import { AdminRefundsController } from "./admin-refunds.controller";
import { InMemoryRefundProviders } from "./in-memory.refund-provider";
import { PaymentsModule } from "./payments.module";
import { PayPalRefundAdapter } from "./paypal.refund.adapter";
import { REFUND_PROVIDER_ADAPTERS, REFUND_PROVIDER_MEMORY } from "./refund-provider.port";
import { StripeRefundAdapter } from "./stripe.refund.adapter";

/**
 * W3 §4e Admin Refund HTTP — separate from PaymentsModule to avoid DI cycles.
 */
@Module({
  imports: [PaymentsModule, AuthModule, AuditModule, AdminHttpIdempotencyModule],
  controllers: [AdminOrderRefundsController, AdminRefundsController],
  providers: [
    AdminRefundService,
    StripeRefundAdapter,
    PayPalRefundAdapter,
    {
      provide: REFUND_PROVIDER_ADAPTERS,
      useFactory: (
        stripe: StripeRefundAdapter,
        paypal: PayPalRefundAdapter,
        memory?: InMemoryRefundProviders,
      ) => (memory ? memory.adapters() : [stripe, paypal]),
      inject: [
        StripeRefundAdapter,
        PayPalRefundAdapter,
        { token: REFUND_PROVIDER_MEMORY, optional: true },
      ],
    },
  ],
  exports: [AdminRefundService],
})
export class AdminRefundModule {}
