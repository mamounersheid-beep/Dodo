/** Low-level SMTP transport — Auth / Order Confirmation map payload → mail message. */
export type SmtpMailMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Non-secret metadata for tests / observability (never include passwords). */
  meta: {
    template: string;
    idempotencyKey: string;
    communicationLocale: string;
    /** Auth jobs */
    tokenId?: string;
    /** Order / post-order jobs */
    orderId?: string;
    invoiceId?: string;
    refundId?: string;
    returnRequestId?: string;
    pdfObjectKey?: string;
  };
};

export interface SmtpTransport {
  sendMail(message: SmtpMailMessage): Promise<void>;
}

export const SMTP_TRANSPORT = Symbol("SMTP_TRANSPORT");
