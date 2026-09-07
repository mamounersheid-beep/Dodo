import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { AuditModule } from "./audit/audit.module";
import { ShippingModule } from "./shipping/shipping.module";
import { EMAIL_INTEGRATION } from "./integrations/email/email-integration.port";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";
import { SHIPPING_PROVIDER_REGISTRY } from "./integrations/shipping/shipping-provider.port";

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_INTEGRATION,
      useValue: createEmailIntegrationStub(),
    },
    {
      provide: SHIPPING_PROVIDER_REGISTRY,
      useValue: { listCodes: () => ["dhl"] },
    },
  ],
  exports: [EMAIL_INTEGRATION, SHIPPING_PROVIDER_REGISTRY],
})
class AdminShippingTransitStubModule {}

/** Narrow Nest app for Admin §12.9 transit PATCH (no Redis / full commerce). */
@Module({
  imports: [
    AdminShippingTransitStubModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    ShippingModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AdminShippingTransitTestAppModule {}
