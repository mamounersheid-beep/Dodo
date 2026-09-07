import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { AuditModule } from "./audit/audit.module";
import { AdminRefundModule } from "./payments/admin-refund.module";
import { InMemoryRefundProviders } from "./payments/in-memory.refund-provider";
import { REFUND_PROVIDER_MEMORY } from "./payments/refund-provider.port";
import { EMAIL_INTEGRATION } from "./integrations/email/email-integration.port";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_INTEGRATION,
      useValue: createEmailIntegrationStub(),
    },
    InMemoryRefundProviders,
    { provide: REFUND_PROVIDER_MEMORY, useExisting: InMemoryRefundProviders },
  ],
  exports: [EMAIL_INTEGRATION, InMemoryRefundProviders, REFUND_PROVIDER_MEMORY],
})
class AdminRefundStubModule {}

/** Narrow Nest app for W3 §4e Admin Refund HTTP (in-memory refund providers). */
@Module({
  imports: [
    AdminRefundStubModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    AdminRefundModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AdminRefundTestAppModule {}
