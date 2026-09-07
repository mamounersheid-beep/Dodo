import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AuditModule } from "../audit/audit.module";
import { AdminCompanySettingsController } from "./admin-company-settings.controller";
import { StoreIdentityController } from "./store-identity.controller";
import { CompanySettingsService } from "./company-settings.service";

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [AdminCompanySettingsController, StoreIdentityController],
  providers: [CompanySettingsService],
  exports: [CompanySettingsService],
})
export class CompanySettingsModule {}
