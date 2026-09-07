import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RoleCode } from "@dodo/shared-types";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { AuthUser } from "../auth/auth.types";
import { PatchCompanySettingsDto } from "./dto/patch-company-settings.dto";
import { CompanySettingsService } from "./company-settings.service";

@ApiTags("admin-company-settings")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("admin/company-settings")
export class AdminCompanySettingsController {
  constructor(private readonly svc: CompanySettingsService) {}

  @Get()
  @Roles(RoleCode.ADMIN, RoleCode.OWNER)
  get() {
    return this.svc.getAdmin();
  }

  @Patch()
  @Roles(RoleCode.OWNER)
  patch(@Body() dto: PatchCompanySettingsDto, @CurrentUser() user: AuthUser) {
    return this.svc.patchAdmin(user, dto);
  }
}
