import { Body, Controller, Get, Param, Patch, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RoleCode } from "@dodo/shared-types";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { AuthUser } from "../auth/auth.types";
import { HomeService } from "./home.service";
import { PatchHomeSectionDto, ReplaceStorePicksDto } from "./dto/home-section.dto";

@ApiTags("admin-home")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleCode.ADMIN, RoleCode.OWNER)
@Controller("admin/home")
export class AdminHomeController {
  constructor(private readonly home: HomeService) {}

  @Get("sections")
  listSections() {
    return this.home.listAdminSections();
  }

  @Put("sections/store_picks/products")
  replaceStorePicks(@Body() dto: ReplaceStorePicksDto, @CurrentUser() user: AuthUser) {
    return this.home.replaceStorePicks(dto, user.id);
  }

  @Get("sections/:key")
  getSection(@Param("key") key: string) {
    return this.home.getAdminSection(key);
  }

  @Patch("sections/:key")
  patchSection(
    @Param("key") key: string,
    @Body() dto: PatchHomeSectionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.home.patchSection(key, dto, user.id);
  }
}
