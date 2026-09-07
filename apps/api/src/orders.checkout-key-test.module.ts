import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { AuditModule } from "./audit/audit.module";
import { OrdersModule } from "./orders/orders.module";
import { EMAIL_INTEGRATION } from "./integrations/email/email-integration.port";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_INTEGRATION,
      useValue: createEmailIntegrationStub(),
    },
  ],
  exports: [EMAIL_INTEGRATION],
})
class OrdersCheckoutKeyEmailStubModule {}

/** Narrow Nest app for G2 checkoutKey issuance HTTP acceptance. */
@Module({
  imports: [
    OrdersCheckoutKeyEmailStubModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    OrdersModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class OrdersCheckoutKeyTestAppModule {}
