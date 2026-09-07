import { Global, Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
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
class AuthSessionTestEmailStubModule {}

/** Test-only app slice — Auth Session Spine (Unit 1) without full AppModule/commerce. */
@Module({
  imports: [
    AuthSessionTestEmailStubModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
  ],
})
export class AuthSessionTestAppModule {}
