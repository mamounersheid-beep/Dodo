import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { CatalogModule } from "./catalog/catalog.module";
import { HomeModule } from "./home/home.module";
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
class HomeEmailStubModule {}

/** Narrow Nest app for Homepage Sections V1 (public + admin). */
@Module({
  imports: [
    HomeEmailStubModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    CatalogModule,
    HomeModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class HomeTestAppModule {}
