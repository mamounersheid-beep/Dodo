import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AdminShippingRatesController } from "./admin-shipping-rates.controller";
import { ShippingController } from "./shipping.controller";
import { ShippingService } from "./shipping.service";

@Module({
  imports: [AuthModule],
  controllers: [ShippingController, AdminShippingRatesController],
  providers: [ShippingService],
  exports: [ShippingService],
})
export class ShippingModule {}
