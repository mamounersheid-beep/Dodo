import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  IsArray,
  ArrayMinSize,
} from "class-validator";
import { Type } from "class-transformer";

export class CreateCategoryDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sizeGuideMarkdown?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresGrundpreis?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(["standard", "restricted"])
  gpsrCatalogTier?: "standard" | "restricted";
}

export class UpdateCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sizeGuideMarkdown?: string | null;

  @ApiPropertyOptional({ description: "Activate/deactivate — Audit on change" })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresGrundpreis?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(["standard", "restricted"])
  gpsrCatalogTier?: "standard" | "restricted";
}

export class CreateBrandDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  slug?: string;
}

export class CreateProductBaseVariantDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  @ApiProperty({ example: "29.90" })
  @IsNumberString()
  price!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  weightGrams!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ean?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;
}

export class CreateProductDto {
  @ApiProperty()
  @IsString()
  categoryId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  brandId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  description!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  seoTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  seoDescription?: string;

  /** UI-only Simple|Variable — not a DB column (10.2). */
  @ApiPropertyOptional({ enum: ["simple", "variable"] })
  @IsOptional()
  @IsIn(["simple", "variable"])
  mode?: "simple" | "variable";

  /** Required when mode=simple — creates the base ProductVariant. */
  @ApiPropertyOptional({ type: CreateProductBaseVariantDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateProductBaseVariantDto)
  baseVariant?: CreateProductBaseVariantDto;

  /** Draft default false — publish via isActive with P1–P6 guards. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(["inherit", "require", "exempt"])
  grundpreisRequirement?: "inherit" | "require" | "exempt";

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  safetyInformationRequired?: boolean;
}

export class UpdateProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  brandId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  seoTitle?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  seoDescription?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(["inherit", "require", "exempt"])
  grundpreisRequirement?: "inherit" | "require" | "exempt";

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(["store_default", "product_specific"])
  manufacturerSource?: "store_default" | "product_specific";

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  manufacturerDisplayName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  manufacturerAddressLine1?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  manufacturerPostalCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  manufacturerCity?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  manufacturerCountryCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  manufacturerEstablishedInUnion?: boolean | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  manufacturerEmail?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  euResponsiblePersonDisplayName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  euResponsiblePersonAddressLine1?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  euResponsiblePersonPostalCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  euResponsiblePersonCity?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  euResponsiblePersonCountryCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  euResponsiblePersonEmail?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  safetyInformationRequired?: boolean;
}

export class UpsertProductTranslationDto {
  @ApiProperty({ enum: ["de", "en", "ar"] })
  @IsIn(["de", "en", "ar"])
  locale!: "de" | "en" | "ar";

  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  description!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  seoTitle?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  seoDescription?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  safetyInformationMarkdown?: string | null;
}

export class CreateVariantDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ean?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  attributesJson?: Record<string, string | number | boolean>;

  @ApiProperty({ example: "29.90", description: "Decimal string EUR" })
  @IsNumberString()
  price!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  weightGrams!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  lengthMm?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  widthMm?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  heightMm?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  grundpreisAmount?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  grundpreisUnit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateVariantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ean?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  attributesJson?: Record<string, string | number | boolean> | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  price?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  weightGrams?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  lengthMm?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  widthMm?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  heightMm?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  grundpreisAmount?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  grundpreisUnit?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateImageDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  objectKey!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  variantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  alt?: string;

  @ApiProperty({ example: "4:5" })
  @IsString()
  @Matches(/^4:5$/)
  aspectRatio!: string;
}

export class BundleItemDto {
  @ApiProperty()
  @IsString()
  variantId!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;
}

export class CreateBundleDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  discountPercent?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ type: [BundleItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BundleItemDto)
  items!: BundleItemDto[];
}

export class LinkRelatedProductDto {
  @ApiProperty()
  @IsString()
  relatedProductId!: string;

  @ApiPropertyOptional({ default: "related" })
  @IsOptional()
  @IsIn(["related"])
  type?: "related";
}
