import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { EMAIL_INTEGRATION } from "./integrations/email/email-integration.port";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";
import { captureAuthEmail } from "./auth.session-test-email.capture";

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_INTEGRATION,
      useValue: createEmailIntegrationStub({
        enqueueAuthEmail: async (input: Parameters<typeof captureAuthEmail>[0]) => {
          captureAuthEmail(input);
        },
      }),
    },
  ],
  exports: [EMAIL_INTEGRATION],
})
class AuthVerifyTestEmailStubModule {}

/**
 * Unit 3 — Email Verification acceptance slice.
 * Auth + Users (resend) + ThrottlerGuard (contract rate limit).
 * Does not replace AuthSessionTestAppModule (Unit 1/2).
 */
@Module({
  imports: [
    AuthVerifyTestEmailStubModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    UsersModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AuthVerifyTestAppModule {}
