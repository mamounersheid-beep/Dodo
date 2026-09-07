import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RoleCode } from "@dodo/shared-types";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { AuthUser } from "../auth/auth.types";
import { InvoicesService } from "./invoices.service";

@ApiTags("invoices")
@Controller("invoices")
export class InvoicesController {
  constructor(private readonly svc: InvoicesService) {}

  @Get("_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }

  @Get(":invoiceNumber")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleCode.CUSTOMER,
    RoleCode.SUPPORT,
    RoleCode.ADMIN,
    RoleCode.OWNER,
  )
  getOne(@Param("invoiceNumber") invoiceNumber: string, @CurrentUser() user: AuthUser) {
    return this.svc.getByNumber(invoiceNumber, user);
  }
}
