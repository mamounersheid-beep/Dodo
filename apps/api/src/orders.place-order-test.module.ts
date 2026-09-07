import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { AuditModule } from "./audit/audit.module";
import { CartModule } from "./cart/cart.module";
import { OrdersModule } from "./orders/orders.module";
import {
  EMAIL_INTEGRATION,
  type EnqueueOrderConfirmationArgs,
} from "./integrations/email/email-integration.port";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";

export const placeOrderEmailCalls: EnqueueOrderConfirmationArgs[] = [];

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_INTEGRATION,
      useValue: createEmailIntegrationStub({
        enqueueOrderConfirmation: async (input: EnqueueOrderConfirmationArgs) => {
          placeOrderEmailCalls.push(input);
        },
      }),
    },
  ],
  exports: [EMAIL_INTEGRATION],
})
class PlaceOrderEmailStubModule {}

/** Narrow Nest app for production placeOrder core Tx. */
@Module({
  imports: [
    PlaceOrderEmailStubModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    CartModule,
    OrdersModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class OrdersPlaceOrderTestAppModule {}
