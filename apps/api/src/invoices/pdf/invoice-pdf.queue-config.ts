/**
 * Invoice-PDF BullMQ options (10.11 §4a).
 * Same execution-choice class as Auth/email jobs — not new paper requirements.
 */
export const INVOICE_PDF_JOB_ATTEMPTS = 3;
export const INVOICE_PDF_BACKOFF_MS = 50;
export const INVOICE_PDF_DLQ_NAME = "invoice-pdf-dlq";

export const INVOICE_PDF_JOB_OPTIONS = {
  attempts: INVOICE_PDF_JOB_ATTEMPTS,
  backoff: {
    type: "fixed" as const,
    delay: INVOICE_PDF_BACKOFF_MS,
  },
  removeOnComplete: false,
  removeOnFail: false,
};
