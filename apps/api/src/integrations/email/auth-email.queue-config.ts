/**
 * Auth transactional email queue options (10.10 Slice C).
 *
 * Paper contract requires retry → DLQ/alert but does **not** specify counts/backoff.
 * Values below are **execution choices only** — not new paper requirements.
 */
export const AUTH_EMAIL_JOB_ATTEMPTS = 3;
/** Fixed backoff between attempts (ms) — kept small for deterministic tests. */
export const AUTH_EMAIL_BACKOFF_MS = 50;
/** Dead-letter queue for exhausted Auth email jobs (observable failure sink). */
export const AUTH_EMAIL_DLQ_NAME = "email-dlq";

/**
 * BullMQ custom jobId may contain `:` only when it has exactly 3 segments.
 * Main jobs use `auth:{type}:{tokenId}`; DLQ uses `dlq:{type}:{tokenId}`.
 */
export function authEmailDlqJobId(template: string, tokenId: string): string {
  return `dlq:${template}:${tokenId}`;
}

/**
 * Order Confirmation DLQ jobId (3 segments).
 * Work key remains `order-confirmation:{orderId}` in payload — not used as jobId.
 */
export function orderConfirmationDlqJobId(orderId: string): string {
  return `dlq:confirm:${orderId}`;
}

/** Admin Resend DLQ jobId (3 segments) — 10.10 §2b. */
export function orderConfirmationResendDlqJobId(orderId: string, resendId: string): string {
  return `dlq:cresend:${orderId}_${resendId}`;
}

/** Order-cancelled DLQ jobId (3 segments) — 10.10 §4a. */
export function orderCancelledDlqJobId(orderId: string): string {
  return `dlq:cancel:${orderId}`;
}

export function contactFormDlqJobId(submissionId: string): string {
  return `dlq:contact:${submissionId}`;
}

/** #17 DLQ jobIds (exactly 3 segments). */
export function shipmentEmailDlqJobId(shipmentId: string): string {
  return `dlq:ship:${shipmentId}`;
}
export function invoiceEmailDlqJobId(invoiceId: string): string {
  return `dlq:inv:${invoiceId}`;
}
export function refundEmailDlqJobId(refundId: string): string {
  return `dlq:refund:${refundId}`;
}
export function deliveryEmailDlqJobId(orderId: string): string {
  return `dlq:deliver:${orderId}`;
}
export function returnRequestEmailDlqJobId(returnRequestId: string): string {
  return `dlq:retreq:${returnRequestId}`;
}

export const AUTH_EMAIL_JOB_OPTIONS = {
  attempts: AUTH_EMAIL_JOB_ATTEMPTS,
  backoff: {
    type: "fixed" as const,
    delay: AUTH_EMAIL_BACKOFF_MS,
  },
  removeOnComplete: false,
  removeOnFail: false,
};
