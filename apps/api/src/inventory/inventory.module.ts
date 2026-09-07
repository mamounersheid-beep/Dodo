import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { InventoryController } from "./inventory.controller";
import { AdminInventoryController } from "./admin-inventory.controller";
import { InventoryService } from "./inventory.service";

@Module({
  imports: [AuthModule],
  controllers: [InventoryController, AdminInventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
