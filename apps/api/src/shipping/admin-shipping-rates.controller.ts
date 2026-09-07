import { Body, Controller, Param, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RoleCode } from "@dodo/shared-types";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { AuthUser } from "../auth/auth.types";
import { UpdateShippingRateTransitDaysDto } from "./dto/update-shipping-rate-transit-days.dto";
import { ShippingService } from "./shipping.service";

@ApiTags("admin-shipping")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleCode.ADMIN, RoleCode.OWNER)
@Controller("admin/shipping-rates")
export class AdminShippingRatesController {
  constructor(private readonly svc: ShippingService) {}

  @Patch(":id")
  updateTransitDays(
    @Param("id") id: string,
    @Body() dto: UpdateShippingRateTransitDaysDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.updateTransitDays(id, dto, user.id);
  }
}
