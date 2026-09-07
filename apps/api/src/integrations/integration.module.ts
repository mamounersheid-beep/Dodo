import { Global, Module, OnModuleInit } from "@nestjs/common";
import { isSmtpLiveConfigured } from "../config/env";
import { AUTH_EMAIL_SENDER } from "./email/auth-email-sender.port";
import { AuthEmailWorkerService } from "./email/auth-email.worker";
import { EMAIL_INTEGRATION } from "./email/email-integration.port";
import { LoggingSmtpTransport } from "./email/logging-smtp.transport";
import { NodemailerSmtpTransport } from "./email/nodemailer-smtp.transport";
import { PostOrderEmailHooks } from "./email/post-order-email.hooks";
import { QueuedEmailAdapter } from "./email/queued-email.adapter";
import { SmtpAuthEmailSender } from "./email/smtp-auth-email.sender";
import { SMTP_TRANSPORT } from "./email/smtp-transport.port";
import { SHIPPING_PROVIDER, SHIPPING_PROVIDER_REGISTRY } from "./shipping/shipping-provider.port";
import { ShippingProviderRegistry } from "./shipping/shipping-provider.registry";
import { DhlShippingProvider } from "./shipping/providers/dhl.provider";

@Global()
@Module({
  providers: [
    QueuedEmailAdapter,
    { provide: EMAIL_INTEGRATION, useExisting: QueuedEmailAdapter },
    PostOrderEmailHooks,
    LoggingSmtpTransport,
    {
      provide: SMTP_TRANSPORT,
      useFactory: (logging: LoggingSmtpTransport) => {
        if (isSmtpLiveConfigured()) {
          return new NodemailerSmtpTransport();
        }
        // Live SMTP activation = operational follow-up (set SMTP_HOST).
        return logging;
      },
      inject: [LoggingSmtpTransport],
    },
    SmtpAuthEmailSender,
    { provide: AUTH_EMAIL_SENDER, useExisting: SmtpAuthEmailSender },
    AuthEmailWorkerService,
    ShippingProviderRegistry,
    { provide: SHIPPING_PROVIDER_REGISTRY, useExisting: ShippingProviderRegistry },
    DhlShippingProvider,
    {
      provide: SHIPPING_PROVIDER,
      useExisting: DhlShippingProvider,
    },
  ],
  exports: [
    EMAIL_INTEGRATION,
    QueuedEmailAdapter,
    PostOrderEmailHooks,
    AUTH_EMAIL_SENDER,
    SMTP_TRANSPORT,
    SHIPPING_PROVIDER_REGISTRY,
    SHIPPING_PROVIDER,
  ],
})
export class IntegrationModule implements OnModuleInit {
  constructor(
    private readonly registry: ShippingProviderRegistry,
    private readonly dhl: DhlShippingProvider,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.dhl);
  }
}
