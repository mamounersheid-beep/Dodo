import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiTags } from "@nestjs/swagger";
import { RoleCode } from "@dodo/shared-types";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { AuthUser } from "../auth/auth.types";
import { IDEMPOTENCY_KEY_HEADER } from "../admin-http-idempotency/admin-http-idempotency.key";
import { AdminRefundService } from "./admin-refund.service";
import { CreateAdminRefundDto } from "./dto/admin-refund.dto";

@ApiTags("admin-order-refunds")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("admin/orders")
export class AdminOrderRefundsController {
  constructor(@Inject(AdminRefundService) private readonly refunds: AdminRefundService) {}

  @Get(":orderId/refunds")
  @Roles(RoleCode.SUPPORT, RoleCode.ADMIN, RoleCode.OWNER)
  list(@Param("orderId") orderId: string) {
    return this.refunds.listForOrder(orderId);
  }

  @Post(":orderId/refunds")
  @HttpCode(200)
  @Roles(RoleCode.ADMIN, RoleCode.OWNER)
  @ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true })
  create(
    @Param("orderId") orderId: string,
    @Body() dto: CreateAdminRefundDto,
    @CurrentUser() user: AuthUser,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ) {
    return this.refunds.create(orderId, dto, user, idempotencyKey);
  }
}
