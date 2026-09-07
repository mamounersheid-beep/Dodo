import type { EnqueueAuthEmailInput } from "./email-integration.port";

/** Outbound Auth email delivery (10.10 Slice D — SMTP transport behind this port). */
export interface AuthEmailSender {
  sendAuthEmail(payload: EnqueueAuthEmailInput): Promise<void>;
}

export const AUTH_EMAIL_SENDER = Symbol("AUTH_EMAIL_SENDER");
