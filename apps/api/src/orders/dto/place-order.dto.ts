import { Type } from "class-transformer";
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";

/** Closed Address members (10.7 / PO-P-R15). */
export class PlaceOrderAddressDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @MinLength(1)
  line1!: string;

  @IsOptional()
  @IsString()
  line2?: string;

  @IsString()
  @MinLength(1)
  postalCode!: string;

  @IsString()
  @MinLength(1)
  city!: string;

  @IsString()
  @Matches(/^[A-Z]{2}$/)
  countryCode!: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

/**
 * Production PlaceOrderDto whitelist (PO-P). Extra keys → 400.
 * Idempotency-Key / x-checkout-key / x-guest-key are headers, not body fields.
 */
export class PlaceOrderDto {
  @ValidateNested()
  @Type(() => PlaceOrderAddressDto)
  shippingAddressJson!: PlaceOrderAddressDto;

  @ValidateNested()
  @Type(() => PlaceOrderAddressDto)
  billingAddressJson!: PlaceOrderAddressDto;

  @IsIn(["stripe", "paypal"])
  paymentMethodCode!: "stripe" | "paypal";

  @IsBoolean()
  @Equals(true)
  acceptedAgb!: true;

  @IsBoolean()
  @Equals(true)
  acceptedWiderrufInfo!: true;

  @ValidateIf((_, v) => v !== undefined)
  @IsEmail()
  guestEmail?: string;

  @IsOptional()
  @IsString()
  couponCode?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  bonusPointsToRedeem?: number;
}
