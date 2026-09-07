import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsInt,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

/** min ≤ max after both fields pass integer ≥ 0. */
@ValidatorConstraint({ name: "transitDaysMinLteMax", async: false })
class TransitDaysMinLteMaxConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as {
      estimatedTransitDaysMin?: unknown;
      estimatedTransitDaysMax?: unknown;
    };
    const min = obj.estimatedTransitDaysMin;
    const max = obj.estimatedTransitDaysMax;
    if (typeof min !== "number" || typeof max !== "number") return true;
    if (!Number.isInteger(min) || !Number.isInteger(max)) return true;
    return min <= max;
  }

  defaultMessage(): string {
    return "estimatedTransitDaysMin must be <= estimatedTransitDaysMax";
  }
}

/**
 * Admin §12.9 — both transit fields required on every PATCH (atomic pair).
 * Raw JSON types: extra keys → 400 (forbidNonWhitelisted). 0 is valid.
 */
export class UpdateShippingRateTransitDaysDto {
  @ApiProperty()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.estimatedTransitDaysMin)
  @IsInt()
  @Min(0)
  @Validate(TransitDaysMinLteMaxConstraint)
  estimatedTransitDaysMin!: number;

  @ApiProperty()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.estimatedTransitDaysMax)
  @IsInt()
  @Min(0)
  estimatedTransitDaysMax!: number;
}
