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
import {
  CancelAdminRefundDto,
  RecoverAdminRefundDto,
  RetryAdminRefundDto,
} from "./dto/admin-refund.dto";

@ApiTags("admin-refunds")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("admin/refunds")
export class AdminRefundsController {
  constructor(@Inject(AdminRefundService) private readonly refunds: AdminRefundService) {}

  @Get(":refundId")
  @Roles(RoleCode.SUPPORT, RoleCode.ADMIN, RoleCode.OWNER)
  getOne(@Param("refundId") refundId: string) {
    return this.refunds.getOne(refundId);
  }

  @Post(":refundId/recover")
  @HttpCode(200)
  @Roles(RoleCode.ADMIN, RoleCode.OWNER)
  @ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true })
  recover(
    @Param("refundId") refundId: string,
    @Body() _dto: RecoverAdminRefundDto,
    @CurrentUser() user: AuthUser,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ) {
    return this.refunds.recover(refundId, user, idempotencyKey);
  }

  @Post(":refundId/cancel")
  @HttpCode(200)
  @Roles(RoleCode.ADMIN, RoleCode.OWNER)
  @ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true })
  cancel(
    @Param("refundId") refundId: string,
    @Body() dto: CancelAdminRefundDto,
    @CurrentUser() user: AuthUser,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ) {
    return this.refunds.cancel(refundId, dto, user, idempotencyKey);
  }

  @Post(":refundId/retry")
  @HttpCode(200)
  @Roles(RoleCode.ADMIN, RoleCode.OWNER)
  @ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true })
  retry(
    @Param("refundId") refundId: string,
    @Body() dto: RetryAdminRefundDto,
    @CurrentUser() user: AuthUser,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ) {
    return this.refunds.retry(refundId, dto, user, idempotencyKey);
  }
}
