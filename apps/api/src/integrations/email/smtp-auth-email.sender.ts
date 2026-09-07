import { Inject, Injectable } from "@nestjs/common";
import { env } from "../../config/env";
import type { AuthEmailSender } from "./auth-email-sender.port";
import type { EnqueueAuthEmailInput } from "./email-integration.port";
import { SMTP_TRANSPORT, type SmtpTransport } from "./smtp-transport.port";

const SUBJECTS: Record<EnqueueAuthEmailInput["template"], Record<string, string>> = {
  email_verify: {
    de: "E-Mail bestätigen",
    en: "Verify your email",
    ar: "تأكيد البريد الإلكتروني",
  },
  password_reset: {
    de: "Passwort zurücksetzen",
    en: "Reset your password",
    ar: "إعادة تعيين كلمة المرور",
  },
  email_change: {
    de: "Neue E-Mail bestätigen",
    en: "Confirm your new email",
    ar: "تأكيد البريد الجديد",
  },
};

/**
 * 10.10 Slice D — AuthEmailSender backed by SMTP transport.
 * Worker owns retry/DLQ; this class only maps payload → transport.sendMail (throws on failure).
 */
@Injectable()
export class SmtpAuthEmailSender implements AuthEmailSender {
  constructor(@Inject(SMTP_TRANSPORT) private readonly transport: SmtpTransport) {}

  async sendAuthEmail(payload: EnqueueAuthEmailInput): Promise<void> {
    const locale = payload.communicationLocale;
    const subject =
      SUBJECTS[payload.template][locale] ?? SUBJECTS[payload.template].en ?? payload.template;

    const text = [
      `template=${payload.template}`,
      `communicationLocale=${locale}`,
      `token=${payload.rawToken}`,
      `idempotencyKey=${payload.idempotencyKey}`,
    ].join("\n");

    await this.transport.sendMail({
      from: env.EMAIL_FROM,
      to: payload.to,
      subject,
      text,
      meta: {
        template: payload.template,
        tokenId: payload.tokenId,
        idempotencyKey: payload.idempotencyKey,
        communicationLocale: locale,
      },
    });
  }
}
