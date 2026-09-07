import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CatalogModule } from "../catalog/catalog.module";
import { HomeService } from "./home.service";
import { StoreHomeController } from "./store-home.controller";
import { AdminHomeController } from "./admin-home.controller";

@Module({
  imports: [AuthModule, CatalogModule],
  controllers: [StoreHomeController, AdminHomeController],
  providers: [HomeService],
  exports: [HomeService],
})
export class HomeModule {}
