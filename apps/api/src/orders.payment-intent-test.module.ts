import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { AuditModule } from "./audit/audit.module";
import { CartModule } from "./cart/cart.module";
import { OrdersModule } from "./orders/orders.module";
import { PaymentsModule } from "./payments/payments.module";
import {
  EMAIL_INTEGRATION,
  type EnqueueOrderConfirmationArgs,
} from "./integrations/email/email-integration.port";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";
import {
  FIRST_INTENT_MEMORY,
  FIRST_INTENT_TEST_HOOKS,
  paymentIntentTestHooks,
} from "./payments/first-intent.hooks";
import { InMemoryFirstAttemptProviders } from "./payments/in-memory.first-attempt.providers";

export const paymentIntentEmailCalls: EnqueueOrderConfirmationArgs[] = [];

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_INTEGRATION,
      useValue: createEmailIntegrationStub({
        enqueueOrderConfirmation: async (input: EnqueueOrderConfirmationArgs) => {
          paymentIntentEmailCalls.push(input);
        },
      }),
    },
    InMemoryFirstAttemptProviders,
    { provide: FIRST_INTENT_MEMORY, useExisting: InMemoryFirstAttemptProviders },
    { provide: FIRST_INTENT_TEST_HOOKS, useValue: paymentIntentTestHooks },
  ],
  exports: [
    EMAIL_INTEGRATION,
    InMemoryFirstAttemptProviders,
    FIRST_INTENT_MEMORY,
    FIRST_INTENT_TEST_HOOKS,
  ],
})
class PaymentIntentTestStubModule {}

/** Narrow Nest app for first Payment Intent HTTP (§7b/§7c/§7d). */
@Module({
  imports: [
    PaymentIntentTestStubModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    CartModule,
    PaymentsModule,
    OrdersModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class OrdersPaymentIntentTestAppModule {}
