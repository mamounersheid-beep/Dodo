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
  orderConfirmationResendWorkKey,
  orderConfirmationWorkKey,
  type EnqueueOrderConfirmationResendArgs,
} from "./integrations/email/email-integration.port";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";

export type RecordedResend = EnqueueOrderConfirmationResendArgs & {
  workKey: string;
};

export const adminResendEmailState = {
  resendCalls: [] as RecordedResend[],
  failEnqueue: false,
  reset() {
    this.resendCalls = [];
    this.failEnqueue = false;
  },
};

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_INTEGRATION,
      useValue: createEmailIntegrationStub({
        enqueueOrderConfirmationResend: async (input: EnqueueOrderConfirmationResendArgs) => {
          if (adminResendEmailState.failEnqueue) {
            throw new Error("forced enqueue failure");
          }
          adminResendEmailState.resendCalls.push({
            ...input,
            workKey: orderConfirmationResendWorkKey(input.orderId, input.resendId),
          });
        },
      }),
    },
  ],
  exports: [EMAIL_INTEGRATION],
})
class AdminResendEmailStubModule {}

/** Narrow Nest app for Admin Resend confirmation (10.10 §2a/§2b). */
@Module({
  imports: [
    AdminResendEmailStubModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    CartModule,
    OrdersModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class OrdersAdminResendTestAppModule {}

export { orderConfirmationWorkKey, orderConfirmationResendWorkKey };
