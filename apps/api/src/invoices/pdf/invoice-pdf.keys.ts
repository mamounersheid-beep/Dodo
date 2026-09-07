/** 10.11 §4a — deterministic work / BullMQ job identity for invoice-pdf. */

export const INVOICE_PDF_QUEUE_NAME = "invoice-pdf" as const;

/** Work / idempotency key (payload). */
export function invoicePdfWorkKey(invoiceId: string): string {
  return `invoice-pdf:${invoiceId}`;
}

/**
 * BullMQ jobId — exactly 3 `:` segments (project convention).
 * ≠ work key.
 */
export function invoicePdfJobId(invoiceId: string): string {
  return `inv:pdf:${invoiceId}`;
}

/** DLQ jobId — exactly 3 segments. */
export function invoicePdfDlqJobId(invoiceId: string): string {
  return `dlq:pdf:${invoiceId}`;
}

/** Deterministic private object key (not a public URL). */
export function invoicePdfObjectKey(invoiceId: string): string {
  return `invoices/${invoiceId}.pdf`;
}
