import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ReturnShippingCostWiderrufPolicy } from "@dodo/shared-types";
import { Transform } from "class-transformer";
import {
  Equals,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsString,
  Length,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

const LOCALES = ["de", "en", "ar"] as const;
const WIDERRUF_POLICIES = Object.values(ReturnShippingCostWiderrufPolicy);

/** Pair present together; min ≤ max when both are integers. Null clears both. */
@ValidatorConstraint({ name: "processingDaysPair", async: false })
class ProcessingDaysPairConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as {
      orderProcessingDaysMin?: unknown;
      orderProcessingDaysMax?: unknown;
    };
    const minDefined = Object.prototype.hasOwnProperty.call(obj, "orderProcessingDaysMin");
    const maxDefined = Object.prototype.hasOwnProperty.call(obj, "orderProcessingDaysMax");
    if (minDefined !== maxDefined) return false;
    const min = obj.orderProcessingDaysMin;
    const max = obj.orderProcessingDaysMax;
    if (min === undefined && max === undefined) return true;
    if (min === null && max === null) return true;
    if (typeof min !== "number" || typeof max !== "number") return false;
    if (!Number.isInteger(min) || !Number.isInteger(max)) return false;
    return min <= max;
  }

  defaultMessage(): string {
    return "orderProcessingDaysMin and orderProcessingDaysMax must be sent together (both integers with min <= max, or both null)";
  }
}

/**
 * Admin §12.18b PATCH — writable CompanySettings only.
 * currentPassword = established re-auth (W9 SC). confirmed = CI-2 confirmation.
 * Counters, EUR, and #7 flags are not on this DTO (forbidNonWhitelisted → 400).
 */
export class PatchCompanySettingsDto {
  @ApiProperty({ description: "Must be true (CI-2 confirmation)" })
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.confirmed)
  @IsBoolean()
  @Equals(true)
  confirmed!: true;

  @ApiProperty()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.currentPassword)
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  @ApiPropertyOptional()
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  legalName?: string;

  @ApiPropertyOptional()
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  line1?: string;

  @ApiPropertyOptional()
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  postalCode?: string;

  @ApiPropertyOptional()
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  city?: string;

  @ApiPropertyOptional()
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @Length(2, 2)
  countryCode?: string;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsEmail()
  supportEmail?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  supportPhone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  @MinLength(1)
  logoObjectKey?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  steuernummer?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  vatId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  kleinunternehmerId?: string | null;

  @ApiPropertyOptional()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.isKleinunternehmer)
  @ValidateIf((_, v) => v !== undefined)
  @IsBoolean()
  isKleinunternehmer?: boolean;

  @ApiPropertyOptional()
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  invoiceExemptionText?: string;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsDateString()
  kleinunternehmerSince?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  returnAddressName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  returnAddressLine1?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  returnAddressLine2?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  returnPostalCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  returnCity?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  @Length(2, 2)
  returnCountryCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  returnAddressPhone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  returnInstructionsMarkdown?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.returnShipWithinDays)
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsInt()
  @Min(0)
  returnShipWithinDays?: number | null;

  @ApiPropertyOptional({ nullable: true, enum: ReturnShippingCostWiderrufPolicy })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsIn(WIDERRUF_POLICIES)
  returnShippingCostWiderrufPolicy?: ReturnShippingCostWiderrufPolicy | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.orderProcessingDaysMin)
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsInt()
  @Min(0)
  @Validate(ProcessingDaysPairConstraint)
  orderProcessingDaysMin?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.orderProcessingDaysMax)
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsInt()
  @Min(0)
  orderProcessingDaysMax?: number | null;

  @ApiPropertyOptional({ enum: LOCALES })
  @ValidateIf((_, v) => v !== undefined)
  @IsIn(LOCALES)
  defaultLocale?: (typeof LOCALES)[number];

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  defaultManufacturerDisplayName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  defaultManufacturerAddressLine1?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  defaultManufacturerAddressLine2?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  defaultManufacturerPostalCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  defaultManufacturerCity?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  @Length(2, 2)
  defaultManufacturerCountryCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.defaultManufacturerEstablishedInUnion)
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsBoolean()
  defaultManufacturerEstablishedInUnion?: boolean | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsEmail()
  defaultManufacturerEmail?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  defaultEuResponsiblePersonDisplayName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  defaultEuResponsiblePersonAddressLine1?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  defaultEuResponsiblePersonAddressLine2?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  defaultEuResponsiblePersonPostalCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  defaultEuResponsiblePersonCity?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  @Length(2, 2)
  defaultEuResponsiblePersonCountryCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsEmail()
  defaultEuResponsiblePersonEmail?: string | null;
}
