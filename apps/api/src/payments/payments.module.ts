import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PayPalFirstAttemptAdapter } from "./paypal.first-attempt.adapter";
import { StripeFirstAttemptAdapter } from "./stripe.first-attempt.adapter";

@Module({
  imports: [InventoryModule, InvoicesModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, StripeFirstAttemptAdapter, PayPalFirstAttemptAdapter],
  exports: [PaymentsService],
})
export class PaymentsModule {}
