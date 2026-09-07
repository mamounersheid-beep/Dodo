import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { IntegrationModule } from "./integrations/integration.module";
import { InventoryModule } from "./inventory/inventory.module";
import { PaymentsModule } from "./payments/payments.module";
import { PrismaModule } from "./prisma/prisma.module";

/**
 * Narrow Nest app for POST /v1/payments/webhook.
 * Real Stripe/PayPal adapters (HMAC + mocked PayPal verify). No first-intent memory.
 * IntegrationModule required so Invoice PDF after-sale wiring (via Payments→Invoices) can resolve.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
    IntegrationModule,
    PrismaModule,
    InventoryModule,
    PaymentsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class PaymentsWebhookTestAppModule {}
