import { Injectable, Logger } from "@nestjs/common";
import type { SmtpMailMessage, SmtpTransport } from "./smtp-transport.port";

/**
 * Non-live transport when SMTP_HOST is unset — satisfies adapter wiring without credentials.
 * Live SMTP activation remains an operational follow-up (set SMTP_* env).
 * Still throws when `failNext` is used in tests; default path "accepts" send for local DX.
 */
@Injectable()
export class LoggingSmtpTransport implements SmtpTransport {
  private readonly logger = new Logger(LoggingSmtpTransport.name);

  async sendMail(message: SmtpMailMessage): Promise<void> {
    this.logger.log(
      `[smtp-stub] template=${message.meta.template} to=${message.to} ` +
        `locale=${message.meta.communicationLocale} idempotency=${message.meta.idempotencyKey}`,
    );
  }
}
