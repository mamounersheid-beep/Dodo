import { Body, Controller, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RoleCode } from "@dodo/shared-types";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { AuthUser } from "../auth/auth.types";
import { OrdersService } from "./orders.service";
import { ResendOrderConfirmationDto } from "./dto/resend-order-confirmation.dto";

/**
 * Admin order mutations — cancel (R2.2-B) + confirmation Resend (10.10 §2a/§2b).
 */
@ApiTags("admin-orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleCode.ADMIN, RoleCode.OWNER)
@Controller("admin/orders")
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post(":orderId/cancel")
  cancelPostSale(@Param("orderId") orderId: string, @CurrentUser() user: AuthUser) {
    return this.orders.adminCancelPostSale(orderId, user.id);
  }

  /** 10.10 §2b — Admin Resend order confirmation. */
  @Post(":orderId/resend-confirmation")
  @HttpCode(202)
  resendConfirmation(
    @Param("orderId") orderId: string,
    @Body() _body: ResendOrderConfirmationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.adminResendOrderConfirmation(orderId, user.id);
  }
}
