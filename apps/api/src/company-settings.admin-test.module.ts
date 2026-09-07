import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { AuditModule } from "./audit/audit.module";
import { CompanySettingsModule } from "./company-settings/company-settings.module";
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
class CompanySettingsAdminStubModule {}

/** Narrow Nest app for Admin §12.18b CompanySettings GET/PATCH (no Redis / commerce). */
@Module({
  imports: [
    CompanySettingsAdminStubModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    CompanySettingsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class CompanySettingsAdminTestAppModule {}
