/** Reuse existing strict email-abuse throttle (users resend/GDPR): 3 / hour. */
export const CONTACT_THROTTLE_LIMIT = 3;
export const CONTACT_THROTTLE_TTL_MS = 3_600_000;

export const CONTACT_SUBJECTS = [
  "order",
  "payment",
  "shipping",
  "return",
  "account",
  "general",
] as const;

export type ContactSubject = (typeof CONTACT_SUBJECTS)[number];

/** Largest existing class-validator MaxLength in this API (verify-email token). */
export const CONTACT_MESSAGE_MAX = 512;

export const CONTACT_NAME_MAX = 120;
export const CONTACT_EMAIL_MAX = 320;
export const CONTACT_ORDER_NUMBER_MAX = 80;

export const CONTACT_AUDIT_ACTION = "contact.submitted";
export const CONTACT_TEMPLATE = "contact_form" as const;
