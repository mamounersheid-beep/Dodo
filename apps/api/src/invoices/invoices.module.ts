import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { InvoiceAfterSaleOrchestrator } from "./invoice-after-sale.orchestrator";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfModule } from "./pdf/invoice-pdf.module";

@Module({
  imports: [AuthModule, InvoicePdfModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoiceAfterSaleOrchestrator],
  exports: [InvoicesService, InvoicePdfModule, InvoiceAfterSaleOrchestrator],
})
export class InvoicesModule {}
