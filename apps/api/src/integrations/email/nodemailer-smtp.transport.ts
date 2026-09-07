import { Injectable, Logger } from "@nestjs/common";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env, isSmtpLiveConfigured } from "../../config/env";
import type { SmtpMailMessage, SmtpTransport } from "./smtp-transport.port";

/**
 * Live nodemailer transport when SMTP_HOST is set.
 * Credentials come only from env — never logged.
 */
@Injectable()
export class NodemailerSmtpTransport implements SmtpTransport {
  private readonly logger = new Logger(NodemailerSmtpTransport.name);
  private readonly transporter: Transporter;

  constructor() {
    if (!isSmtpLiveConfigured()) {
      throw new Error("NodemailerSmtpTransport requires SMTP_HOST");
    }
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth:
        env.SMTP_USER.trim().length > 0
          ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
          : undefined,
    });
  }

  async sendMail(message: SmtpMailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      headers: {
        "X-Dodo-Template": message.meta.template,
        "X-Dodo-Locale": message.meta.communicationLocale,
        "X-Dodo-Idempotency-Key": message.meta.idempotencyKey,
      },
    });
    this.logger.log(
      `smtp sent template=${message.meta.template} to=${message.to} locale=${message.meta.communicationLocale}`,
    );
  }
}
