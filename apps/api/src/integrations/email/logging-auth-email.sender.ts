import { Injectable, Logger } from "@nestjs/common";
import type { EnqueueAuthEmailInput } from "./email-integration.port";
import type { AuthEmailSender } from "./auth-email-sender.port";

/**
 * 10.10 Slice B default sender — logs only (no SMTP).
 * Replace/bind a real SMTP adapter in a later slice.
 */
@Injectable()
export class LoggingAuthEmailSender implements AuthEmailSender {
  private readonly logger = new Logger(LoggingAuthEmailSender.name);

  async sendAuthEmail(payload: EnqueueAuthEmailInput): Promise<void> {
    this.logger.log(
      `[auth-email-send] template=${payload.template} to=${payload.to} ` +
        `idempotency=${payload.idempotencyKey} locale=${payload.communicationLocale}`,
    );
  }
}
