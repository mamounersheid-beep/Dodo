import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CartModule } from "../cart/cart.module";
import { InventoryModule } from "../inventory/inventory.module";
import { PaymentsModule } from "../payments/payments.module";
import { OptionalJwtAuthGuard } from "../common/guards/optional-jwt-auth.guard";
import { OrdersController } from "./orders.controller";
import { AdminOrdersController } from "./admin-orders.controller";
import { OrdersService } from "./orders.service";
import { UnpaidOrderExpiryRunner } from "./unpaid-order-expiry.runner";

@Module({
  imports: [AuthModule, InventoryModule, CartModule, PaymentsModule],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService, OptionalJwtAuthGuard, UnpaidOrderExpiryRunner],
  exports: [OrdersService],
})
export class OrdersModule {}
