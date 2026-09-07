import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Min, MinLength } from "class-validator";

export class AddCartItemDto {
  @IsString()
  @MinLength(1)
  variantId!: string;

  /** Defaults to 1 when omitted (controller/service). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity?: number;
}

export class UpdateCartItemDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}

/** Slice 3c+3d+3e — shipping country + optional coupon + optional bonus preview. */
export class RecalculateCartDto {
  @IsString()
  @MinLength(1)
  shippingCountryCode!: string;

  /** Optional Gutschein code — request-scoped; empty/whitespace = absent (B1). */
  @IsOptional()
  @IsString()
  couponCode?: string;

  /**
   * Slice 3e D1 — optional Bonus+ preview intent.
   * Non-negative integer points. Absent = no Bonus path (3d contract unchanged).
   * Value 0 is valid (triggers guest/store gates but yields effectivePoints=0).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  bonusPointsToRedeem?: number;
}
