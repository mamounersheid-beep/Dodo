export const INVOICE_PDF_OBJECT_STORAGE = Symbol("INVOICE_PDF_OBJECT_STORAGE");
export const INVOICE_PDF_QUEUE = Symbol("INVOICE_PDF_QUEUE");

export type InvoicePdfJobPayload = {
  /** Work key `invoice-pdf:{invoiceId}` */
  idempotencyKey: string;
  invoiceId: string;
};

export interface InvoicePdfObjectStorage {
  /** Private put — Content-Type application/pdf. Overwrite same key is OK before DB claim. */
  putPdfObject(objectKey: string, body: Buffer): Promise<void>;
}

export type EnqueueInvoicePdfResult = "enqueued" | "already_queued" | "already_ready";

export interface InvoicePdfQueuePort {
  enqueueGenerate(invoiceId: string): Promise<EnqueueInvoicePdfResult>;
}
