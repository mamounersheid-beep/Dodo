import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { OptionalJwtAuthGuard } from "../common/guards/optional-jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { AuthUser } from "../auth/auth.types";
import { GUEST_KEY_HEADER } from "../cart/cart.types";
import { IssueCheckoutKeyDto } from "./dto/issue-checkout-key.dto";
import { CreatePaymentIntentDto } from "./dto/create-payment-intent.dto";
import { PlaceOrderDto } from "./dto/place-order.dto";
import { ReserveDto } from "./dto/reserve.dto";
import { ReleaseDto } from "./dto/release.dto";
import {
  CHECKOUT_KEY_HEADER,
  requireCheckoutKeyHeader,
} from "./checkout-key.transport";
import {
  GUEST_ACCESS_TOKEN_HEADER,
  ORDER_NUMBER_HEADER,
} from "./guest-order-access.transport";
import {
  IDEMPOTENCY_KEY_HEADER,
  requireIdempotencyKeyHeader,
} from "./idempotency-key.transport";
import { OrdersService } from "./orders.service";

@ApiTags("orders")
@Controller("orders")
export class OrdersController {
  constructor(private readonly svc: OrdersService) {}

  @Get("_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }

  /**
   * G2 issuance — outbound checkoutKey only. Does not read x-checkout-key.
   * Does not create Reservation or bind the key to the caller.
   */
  @Post("checkout-key")
  @HttpCode(200)
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiHeader({ name: GUEST_KEY_HEADER, required: false })
  issueCheckoutKey(
    @Body() _dto: IssueCheckoutKeyDto,
    @CurrentUser() user: AuthUser | undefined,
    @Headers(GUEST_KEY_HEADER) guestKey?: string,
  ) {
    this.assertCallerIdentity(user, guestKey);
    return this.svc.issueCheckoutKey();
  }

  /**
   * Hybrid phase 1 — reserve one line. Consumes x-checkout-key. No Order / bind.
   */
  @Post("reserve")
  @HttpCode(200)
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiHeader({ name: GUEST_KEY_HEADER, required: false })
  @ApiHeader({ name: CHECKOUT_KEY_HEADER, required: true })
  reserve(
    @Body() dto: ReserveDto,
    @CurrentUser() user: AuthUser | undefined,
    @Headers(GUEST_KEY_HEADER) guestKey?: string,
    @Headers(CHECKOUT_KEY_HEADER) checkoutKeyHeader?: string,
  ) {
    this.assertCallerIdentity(user, guestKey);
    const checkoutKey = requireCheckoutKeyHeader(checkoutKeyHeader);
    return this.svc.reserveLine(checkoutKey, dto.variantId, dto.quantity);
  }

  /**
   * Hybrid phase 1 — release active reservations for x-checkout-key.
   * releasedCount 0 when none active. No Order / bind.
   */
  @Post("release")
  @HttpCode(200)
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiHeader({ name: GUEST_KEY_HEADER, required: false })
  @ApiHeader({ name: CHECKOUT_KEY_HEADER, required: true })
  release(
    @Body() _dto: ReleaseDto,
    @CurrentUser() user: AuthUser | undefined,
    @Headers(GUEST_KEY_HEADER) guestKey?: string,
    @Headers(CHECKOUT_KEY_HEADER) checkoutKeyHeader?: string,
  ) {
    this.assertCallerIdentity(user, guestKey);
    const checkoutKey = requireCheckoutKeyHeader(checkoutKeyHeader);
    return this.svc.releaseReservations(checkoutKey);
  }

  /**
   * Production placeOrder — POST /v1/orders. First success and replay: 201 { id }.
   * Must be registered before GET :id. Payment Intent is not started here.
   */
  @Post()
  @HttpCode(201)
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiHeader({ name: GUEST_KEY_HEADER, required: false })
  @ApiHeader({ name: CHECKOUT_KEY_HEADER, required: true })
  @ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true })
  placeOrder(
    @Body() dto: PlaceOrderDto,
    @CurrentUser() user: AuthUser | undefined,
    @Headers(GUEST_KEY_HEADER) guestKey?: string,
    @Headers(CHECKOUT_KEY_HEADER) checkoutKeyHeader?: string,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKeyHeader?: string,
  ) {
    this.assertCallerIdentity(user, guestKey);
    const checkoutKey = requireCheckoutKeyHeader(checkoutKeyHeader);
    const idempotencyKey = requireIdempotencyKeyHeader(idempotencyKeyHeader);
    return this.svc.placeOrder({
      user,
      guestKeyHeader: guestKey,
      checkoutKey,
      idempotencyKey,
      dto,
    });
  }

  /**
   * Payment Intent — POST /v1/orders/:orderId/payment-intent.
   * First attempt (§7b) or §7 retry after FAILED. x-checkout-key / x-guest-key ignored.
   */
  @Post(":orderId/payment-intent")
  @HttpCode(200)
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiHeader({ name: ORDER_NUMBER_HEADER, required: false })
  @ApiHeader({ name: GUEST_ACCESS_TOKEN_HEADER, required: false })
  createPaymentIntent(
    @Param("orderId") orderId: string,
    @Body() _dto: CreatePaymentIntentDto,
    @CurrentUser() user: AuthUser | undefined,
    @Headers(ORDER_NUMBER_HEADER) orderNumberHeader?: string,
    @Headers(GUEST_ACCESS_TOKEN_HEADER) guestAccessTokenHeader?: string,
  ) {
    return this.svc.createPaymentIntent({
      orderId,
      user,
      orderNumberHeader,
      guestAccessTokenHeader,
    });
  }

  /** Ownership enforced — IDOR acceptance for 10.1 */
  @Get(":id")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  getOne(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.svc.getForUser(id, user);
  }

  private assertCallerIdentity(user: AuthUser | undefined, guestKey?: string): void {
    const hasUser = Boolean(user?.id);
    const hasGuest = Boolean(guestKey?.trim());
    if (!hasUser && !hasGuest) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "Registered session or x-guest-key required",
      });
    }
  }
}
