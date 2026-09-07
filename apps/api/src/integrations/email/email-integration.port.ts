/** Auth transactional email — queue contract (10.10 §2/§4). */
export type AuthEmailTemplate = "email_verify" | "email_change" | "password_reset";

/** Order Confirmation (auto) — 10.10 §1b #13 */
export type OrderConfirmationTemplate = "order_confirmation";

/** Order cancelled (unpaid auto-cancel #4 / #5) — 10.10 §4a */
export type OrderCancelledTemplate = "order_cancelled";

/** #17 post-order transactional — 10.10 §4 */
export type PostOrderEmailTemplate =
  | "shipment"
  | "invoice"
  | "refund"
  | "delivery"
  | "return_request";

export type CommunicationLocale = "de" | "en" | "ar";

/** Job payload + enqueue input — communicationLocale required (Tr3b / 10.10 §0b). */
export type EnqueueAuthEmailInput = {
  /** Business idempotency key: `auth:{type}:{tokenId}` (10.10 §2) */
  idempotencyKey: string;
  to: string;
  template: AuthEmailTemplate;
  tokenId: string;
  /** Raw token for link — worker only; not consumed in Queue Foundation slice */
  rawToken: string;
  communicationLocale: CommunicationLocale;
};

/**
 * Order Confirmation job payload (10.10 §1b / §2).
 * Work key `order-confirmation:{orderId}` ≠ BullMQ jobId `ord:confirm:{orderId}`.
 */
export type EnqueueOrderConfirmationInput = {
  /** Business work/idempotency key: `order-confirmation:{orderId}` */
  idempotencyKey: string;
  to: string;
  template: OrderConfirmationTemplate;
  orderId: string;
  /** Must mirror Order.locale at enqueue (Tr3); processor re-reads Order.locale as SoT */
  communicationLocale: CommunicationLocale;
  /**
   * Raw guest access token for tracking link (#16) — guest orders only.
   * Never persisted in DB (hash only on Order); passed in job for Bestätigung link.
   */
  guestAccessToken?: string;
};

/**
 * Order-cancelled job payload (10.10 §4a).
 * Work key `order-cancelled:{orderId}` ≠ BullMQ jobId `ord:cancel:{orderId}`.
 * No guestAccessToken — #16 revoke on CANCELLED; no guest link.
 */
export type EnqueueOrderCancelledInput = {
  /** Business work/idempotency key: `order-cancelled:{orderId}` */
  idempotencyKey: string;
  to: string;
  template: OrderCancelledTemplate;
  orderId: string;
  /** Must mirror Order.locale at enqueue (Tr3); processor re-reads Order.locale as SoT */
  communicationLocale: CommunicationLocale;
};

/** Contact form mail to live supportEmail — not client idempotent. */
export type ContactFormTemplate = "contact_form";

export type EnqueueContactFormJob = {
  idempotencyKey: string;
  to: string;
  template: ContactFormTemplate;
  communicationLocale: CommunicationLocale;
  name: string;
  replyEmail: string;
  subject: string;
  message: string;
  orderNumber?: string;
  userId?: string;
};

/** #17 shipment — work key `shipment:{shipmentId}` */
export type EnqueueShipmentEmailInput = {
  idempotencyKey: string;
  to: string;
  template: "shipment";
  shipmentId: string;
  orderId: string;
  communicationLocale: CommunicationLocale;
  guestAccessToken?: string;
};

/** #17 invoice — work key `invoice:{invoiceId}` · PDF link only (no attachment) */
export type EnqueueInvoiceEmailInput = {
  idempotencyKey: string;
  to: string;
  template: "invoice";
  invoiceId: string;
  orderId: string;
  communicationLocale: CommunicationLocale;
};

/** #17 refund — work key `refund:{refundId}` */
export type EnqueueRefundEmailInput = {
  idempotencyKey: string;
  to: string;
  template: "refund";
  refundId: string;
  orderId: string;
  communicationLocale: CommunicationLocale;
};

/** #17 delivery — work key `delivery:{orderId}` */
export type EnqueueDeliveryEmailInput = {
  idempotencyKey: string;
  to: string;
  template: "delivery";
  orderId: string;
  communicationLocale: CommunicationLocale;
  guestAccessToken?: string;
};

/** #17 return-request — work key `return-request:{returnRequestId}` */
export type EnqueueReturnRequestEmailInput = {
  idempotencyKey: string;
  to: string;
  template: "return_request";
  returnRequestId: string;
  orderId: string;
  communicationLocale: CommunicationLocale;
  guestAccessToken?: string;
};

export type EmailJobPayload =
  | EnqueueAuthEmailInput
  | EnqueueOrderConfirmationInput
  | EnqueueOrderCancelledInput
  | EnqueueContactFormJob
  | EnqueueShipmentEmailInput
  | EnqueueInvoiceEmailInput
  | EnqueueRefundEmailInput
  | EnqueueDeliveryEmailInput
  | EnqueueReturnRequestEmailInput;

export function isAuthEmailPayload(p: EmailJobPayload): p is EnqueueAuthEmailInput {
  return (
    p.template === "email_verify" ||
    p.template === "password_reset" ||
    p.template === "email_change"
  );
}

export function isOrderConfirmationPayload(
  p: EmailJobPayload,
): p is EnqueueOrderConfirmationInput {
  return p.template === "order_confirmation";
}

export function isOrderCancelledPayload(p: EmailJobPayload): p is EnqueueOrderCancelledInput {
  return p.template === "order_cancelled";
}

export function isContactFormPayload(p: EmailJobPayload): p is EnqueueContactFormJob {
  return p.template === "contact_form";
}

export function isPostOrderEmailPayload(
  p: EmailJobPayload,
): p is
  | EnqueueShipmentEmailInput
  | EnqueueInvoiceEmailInput
  | EnqueueRefundEmailInput
  | EnqueueDeliveryEmailInput
  | EnqueueReturnRequestEmailInput {
  return (
    p.template === "shipment" ||
    p.template === "invoice" ||
    p.template === "refund" ||
    p.template === "delivery" ||
    p.template === "return_request"
  );
}

export function contactFormJobId(submissionId: string): string {
  return `con:submit:${submissionId}`;
}

/** Contract work key (10.10 §2) — not used as BullMQ jobId (3-segment rule). */
export function orderConfirmationWorkKey(orderId: string): string {
  return `order-confirmation:${orderId}`;
}

/** BullMQ-compatible jobId (exactly 3 segments when using `:`). */
export function orderConfirmationJobId(orderId: string): string {
  return `ord:confirm:${orderId}`;
}

/** Admin Resend work key (10.10 §2 / §2b) — distinct from auto confirmation. */
export function orderConfirmationResendWorkKey(orderId: string, resendId: string): string {
  return `order-confirmation-resend:${orderId}:${resendId}`;
}

/**
 * BullMQ jobId for Admin Resend (3 segments).
 * Third segment embeds orderId_resendId (no extra `:`).
 */
export function orderConfirmationResendJobId(orderId: string, resendId: string): string {
  return `ord:cresend:${orderId}_${resendId}`;
}

/** Tr3: Order.locale ∈ {de,en,ar} else en. */
export function resolveOrderCommunicationLocale(locale: string): CommunicationLocale {
  if (locale === "de" || locale === "en" || locale === "ar") return locale;
  return "en";
}

export type EnqueueOrderConfirmationArgs = {
  orderId: string;
  to: string;
  communicationLocale: CommunicationLocale;
  guestAccessToken?: string;
};

/** Admin Resend enqueue — work key includes resendId (10.10 §2b). */
export type EnqueueOrderConfirmationResendArgs = {
  orderId: string;
  resendId: string;
  to: string;
  communicationLocale: CommunicationLocale;
  guestAccessToken?: string;
};

/** Order-cancelled enqueue — #4 unpaid auto-cancel after commit (10.10 §4a). */
export type EnqueueOrderCancelledArgs = {
  orderId: string;
  to: string;
  communicationLocale: CommunicationLocale;
};

/** Contract work key (10.10 §2 / §4a). */
export function orderCancelledWorkKey(orderId: string): string {
  return `order-cancelled:${orderId}`;
}

/** BullMQ-compatible jobId (exactly 3 segments when using `:`). */
export function orderCancelledJobId(orderId: string): string {
  return `ord:cancel:${orderId}`;
}

// ── #17 work keys + BullMQ jobIds (10.10 §2 / §4) ─────────────────

export function shipmentEmailWorkKey(shipmentId: string): string {
  return `shipment:${shipmentId}`;
}
export function shipmentEmailJobId(shipmentId: string): string {
  return `ord:ship:${shipmentId}`;
}

export function invoiceEmailWorkKey(invoiceId: string): string {
  return `invoice:${invoiceId}`;
}
export function invoiceEmailJobId(invoiceId: string): string {
  return `ord:inv:${invoiceId}`;
}

export function refundEmailWorkKey(refundId: string): string {
  return `refund:${refundId}`;
}
export function refundEmailJobId(refundId: string): string {
  return `ord:refund:${refundId}`;
}

export function deliveryEmailWorkKey(orderId: string): string {
  return `delivery:${orderId}`;
}
export function deliveryEmailJobId(orderId: string): string {
  return `ord:deliver:${orderId}`;
}

export function returnRequestEmailWorkKey(returnRequestId: string): string {
  return `return-request:${returnRequestId}`;
}
export function returnRequestEmailJobId(returnRequestId: string): string {
  return `ord:retreq:${returnRequestId}`;
}

export type EnqueueShipmentEmailArgs = {
  shipmentId: string;
  orderId: string;
  to: string;
  communicationLocale: CommunicationLocale;
  guestAccessToken?: string;
};

export type EnqueueInvoiceEmailArgs = {
  invoiceId: string;
  orderId: string;
  to: string;
  communicationLocale: CommunicationLocale;
};

export type EnqueueRefundEmailArgs = {
  refundId: string;
  orderId: string;
  to: string;
  communicationLocale: CommunicationLocale;
};

export type EnqueueDeliveryEmailArgs = {
  orderId: string;
  to: string;
  communicationLocale: CommunicationLocale;
  guestAccessToken?: string;
};

export type EnqueueReturnRequestEmailArgs = {
  returnRequestId: string;
  orderId: string;
  to: string;
  communicationLocale: CommunicationLocale;
  guestAccessToken?: string;
};

export interface EmailIntegrationPort {
  enqueueAuthEmail(input: EnqueueAuthEmailInput): Promise<void>;
  enqueueOrderConfirmation(input: EnqueueOrderConfirmationArgs): Promise<void>;
  enqueueOrderConfirmationResend(input: EnqueueOrderConfirmationResendArgs): Promise<void>;
  enqueueOrderCancelled(input: EnqueueOrderCancelledArgs): Promise<void>;
  /** #17 — domain owners call after ship commit; email layer does not create shipments. */
  enqueueShipmentEmail(input: EnqueueShipmentEmailArgs): Promise<void>;
  /** #17 — only after issued + pdfObjectKey; does not generate PDF. */
  enqueueInvoiceEmail(input: EnqueueInvoiceEmailArgs): Promise<void>;
  /** #17 — after Refund SUCCEEDED commit. */
  enqueueRefundEmail(input: EnqueueRefundEmailArgs): Promise<void>;
  /** #17 — after DELIVERED + deliveredAt; email layer does not mark delivered. */
  enqueueDeliveryEmail(input: EnqueueDeliveryEmailArgs): Promise<void>;
  /** #17 — after ReturnRequest create; email layer does not create returns. */
  enqueueReturnRequestEmail(input: EnqueueReturnRequestEmailArgs): Promise<void>;
}

export const EMAIL_INTEGRATION = Symbol("EMAIL_INTEGRATION");

/** Shared BullMQ queue name — Auth + Order Confirmation jobs. */
export const AUTH_EMAIL_QUEUE_NAME = "email";
