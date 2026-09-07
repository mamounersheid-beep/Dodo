import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, Matches, MaxLength, ValidateIf } from "class-validator";

const LOCALES = ["de", "en", "ar"] as const;

/** DE USt-IdNr format check only — no external validation in V1 (10.1). */
const VAT_DE = /^DE\d{9}$/;

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  companyName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v != null && v !== "")
  @IsString()
  @MaxLength(32)
  @Matches(VAT_DE, { message: "vatId must be a valid DE USt-IdNr (DE + 9 digits)" })
  vatId?: string | null;

  @ApiPropertyOptional({ enum: LOCALES })
  @IsOptional()
  @IsIn(LOCALES)
  locale?: (typeof LOCALES)[number];
}
