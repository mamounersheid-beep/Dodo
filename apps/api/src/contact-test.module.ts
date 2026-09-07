import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { ContactModule } from "./contact/contact.module";
import { EMAIL_INTEGRATION } from "./integrations/email/email-integration.port";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";
import { QueuedEmailAdapter } from "./integrations/email/queued-email.adapter";

export const contactEnqueueCapture: Array<Record<string, unknown>> = [];

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_INTEGRATION,
      useValue: createEmailIntegrationStub(),
    },
    {
      provide: QueuedEmailAdapter,
      useValue: {
        enqueueContactForm: async (input: Record<string, unknown>) => {
          contactEnqueueCapture.push(input);
        },
      },
    },
  ],
  exports: [EMAIL_INTEGRATION, QueuedEmailAdapter],
})
class ContactTestEmailStubModule {}

/** Narrow Nest app for POST /v1/contact. */
@Module({
  imports: [
    ContactTestEmailStubModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    ContactModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: class NoopGuard { canActivate() { return true; } } }],
})
export class ContactTestAppModule {}
