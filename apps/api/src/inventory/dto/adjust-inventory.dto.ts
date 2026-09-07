import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, MinLength, NotEquals } from "class-validator";

export class AdjustInventoryDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  variantId!: string;

  /** Signed delta to quantityOnHand (non-zero). */
  @ApiProperty({ description: "Signed integer delta; must not drive on-hand negative" })
  @IsInt()
  @NotEquals(0)
  delta!: number;

  @ApiPropertyOptional({ description: "Defaults to V1 MAIN" })
  @IsOptional()
  @IsString()
  locationId?: string;
}
