import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RoleCode } from "@dodo/shared-types";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { AuthUser } from "../auth/auth.types";
import { AdjustInventoryDto } from "./dto/adjust-inventory.dto";
import { InventoryService } from "./inventory.service";

/**
 * Admin inventory writes — adjust only (10.3 / ADMIN_BACKEND W5 IN).
 * No public commerce Inventory HTTP.
 */
@ApiTags("admin-inventory")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleCode.ADMIN, RoleCode.OWNER)
@Controller("admin/inventory")
export class AdminInventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Post("adjust")
  adjust(@Body() dto: AdjustInventoryDto, @CurrentUser() user: AuthUser) {
    return this.svc.adjust({
      variantId: dto.variantId,
      locationId: dto.locationId,
      delta: dto.delta,
      actorId: user.id,
    });
  }
}
