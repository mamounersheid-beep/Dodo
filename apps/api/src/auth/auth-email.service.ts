import { Inject, Injectable } from "@nestjs/common";
import {
  EMAIL_INTEGRATION,
  type CommunicationLocale,
  type EmailIntegrationPort,
} from "../integrations/email/email-integration.port";
import type { AuthEmailTemplate } from "../integrations/email/email-integration.port";
import type { IssuedVerificationToken } from "./verification-token.service";

/** Tr3b / 10.10 §0b — resolve communicationLocale at schedule time. */
export function resolveCommunicationLocale(locale?: string | null): CommunicationLocale {
  if (locale === "de" || locale === "en" || locale === "ar") return locale;
  return "en";
}

@Injectable()
export class AuthEmailService {
  constructor(
    @Inject(EMAIL_INTEGRATION) private readonly email: EmailIntegrationPort,
  ) {}

  async sendForToken(
    issued: IssuedVerificationToken,
    /** Caller passes User.locale / explicit flow locale — resolved to communicationLocale. */
    locale?: string | null,
  ): Promise<void> {
    const template = issued.type as AuthEmailTemplate;
    const idempotencyKey = `auth:${template}:${issued.id}`;
    const communicationLocale = resolveCommunicationLocale(locale);
    try {
      await this.email.enqueueAuthEmail({
        idempotencyKey,
        to: issued.email,
        template,
        tokenId: issued.id,
        rawToken: issued.raw,
        communicationLocale,
      });
    } catch {
      // 10.10: email failure must not invalidate token or change User
    }
  }
}
