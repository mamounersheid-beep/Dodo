import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { CmsLegalModule } from "./cms-legal/cms-legal.module";

/** Narrow Nest app for public GET /v1/legal/pages/:slug and GET /v1/legal/faq. */
@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
    PrismaModule,
    CmsLegalModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class LegalPagesTestAppModule {}
