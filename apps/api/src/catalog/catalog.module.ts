import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AuditModule } from "../audit/audit.module";
import { InventoryModule } from "../inventory/inventory.module";
import { OptionalJwtAuthGuard } from "../common/guards/optional-jwt-auth.guard";
import { CatalogController } from "./catalog.controller";
import { AdminCatalogController } from "./admin-catalog.controller";
import { CatalogService } from "./catalog.service";

@Module({
  imports: [AuthModule, AuditModule, InventoryModule],
  controllers: [CatalogController, AdminCatalogController],
  providers: [CatalogService, OptionalJwtAuthGuard],
  exports: [CatalogService],
})
export class CatalogModule {}
