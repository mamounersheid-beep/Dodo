import { Module } from "@nestjs/common";
import { InvoicePdfQueueAdapter } from "./invoice-pdf.queue";
import { InvoicePdfService } from "./invoice-pdf.service";
import { InvoicePdfWorkerService } from "./invoice-pdf.worker";
import { S3InvoicePdfObjectStorage } from "./invoice-pdf.storage";
import { INVOICE_PDF_OBJECT_STORAGE, INVOICE_PDF_QUEUE } from "./invoice-pdf.port";

@Module({
  providers: [
    { provide: INVOICE_PDF_OBJECT_STORAGE, useClass: S3InvoicePdfObjectStorage },
    InvoicePdfQueueAdapter,
    { provide: INVOICE_PDF_QUEUE, useExisting: InvoicePdfQueueAdapter },
    InvoicePdfWorkerService,
    InvoicePdfService,
  ],
  exports: [InvoicePdfService, INVOICE_PDF_QUEUE, INVOICE_PDF_OBJECT_STORAGE],
})
export class InvoicePdfModule {}
