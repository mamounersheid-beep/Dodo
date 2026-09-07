import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CatalogModule } from "../catalog/catalog.module";
import { InventoryModule } from "../inventory/inventory.module";
import { OptionalJwtAuthGuard } from "../common/guards/optional-jwt-auth.guard";
import { CartController } from "./cart.controller";
import { CartService } from "./cart.service";

@Module({
  imports: [AuthModule, CatalogModule, InventoryModule],
  controllers: [CartController],
  providers: [CartService, OptionalJwtAuthGuard],
  exports: [CartService],
})
export class CartModule {}
