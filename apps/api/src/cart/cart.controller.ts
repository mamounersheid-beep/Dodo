import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { OptionalJwtAuthGuard } from "../common/guards/optional-jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { AuthUser } from "../auth/auth.types";
import { CartService } from "./cart.service";
import { AddCartItemDto, RecalculateCartDto, UpdateCartItemDto } from "./dto/cart.dto";
import { GUEST_KEY_HEADER } from "./cart.types";

@ApiTags("cart")
@Controller("cart")
@UseGuards(OptionalJwtAuthGuard)
@ApiHeader({ name: GUEST_KEY_HEADER, required: false })
export class CartController {
  constructor(private readonly svc: CartService) {}

  @Get("_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }

  @Get()
  @ApiBearerAuth()
  getCart(
    @CurrentUser() user: AuthUser | undefined,
    @Headers(GUEST_KEY_HEADER) guestKey?: string,
  ) {
    return this.svc.getOrCreateCart({ user: user ?? null, guestKey: guestKey ?? null });
  }

  /** Slice 3b+3c+3d — merchandise + DE shipping + optional coupon preview. */
  @Post("recalculate")
  @HttpCode(200)
  @ApiBearerAuth()
  recalculate(
    @Body() dto: RecalculateCartDto,
    @CurrentUser() user: AuthUser | undefined,
    @Headers(GUEST_KEY_HEADER) guestKey?: string,
  ) {
    return this.svc.recalculate({
      user: user ?? null,
      guestKey: guestKey ?? null,
      shippingCountryCode: dto.shippingCountryCode,
      couponCode: dto.couponCode,
      bonusPointsToRedeem: dto.bonusPointsToRedeem,
    });
  }

  /** Slice 3f — merge the guest cart into the authenticated user cart. No body; no pricing. */
  @Post("merge")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  merge(
    @CurrentUser() user: AuthUser,
    @Headers(GUEST_KEY_HEADER) guestKey?: string,
  ) {
    return this.svc.mergeGuestCart({ user, guestKey: guestKey ?? null });
  }

  @Post("items")
  @ApiBearerAuth()
  addItem(
    @Body() dto: AddCartItemDto,
    @CurrentUser() user: AuthUser | undefined,
    @Headers(GUEST_KEY_HEADER) guestKey?: string,
  ) {
    return this.svc.addItem(
      { user: user ?? null, guestKey: guestKey ?? null },
      dto.variantId,
      dto.quantity ?? 1,
    );
  }

  @Patch("items/:variantId")
  @ApiBearerAuth()
  updateItem(
    @Param("variantId") variantId: string,
    @Body() dto: UpdateCartItemDto,
    @CurrentUser() user: AuthUser | undefined,
    @Headers(GUEST_KEY_HEADER) guestKey?: string,
  ) {
    return this.svc.updateItem(
      { user: user ?? null, guestKey: guestKey ?? null },
      variantId,
      dto.quantity,
    );
  }

  @Delete("items/:variantId")
  @ApiBearerAuth()
  removeItem(
    @Param("variantId") variantId: string,
    @CurrentUser() user: AuthUser | undefined,
    @Headers(GUEST_KEY_HEADER) guestKey?: string,
  ) {
    return this.svc.removeItem(
      { user: user ?? null, guestKey: guestKey ?? null },
      variantId,
    );
  }
}
