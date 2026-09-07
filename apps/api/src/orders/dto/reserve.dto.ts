import { Type } from "class-transformer";
import { IsInt, IsString, Min, MinLength } from "class-validator";

/** RR-R8 — one line reserve; checkoutKey is header-only. */
export class ReserveDto {
  @IsString()
  @MinLength(1)
  variantId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}
