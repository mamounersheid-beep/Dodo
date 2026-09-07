import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export class HomeSectionNamesDto {
  @IsOptional()
  @IsString()
  de?: string;

  @IsOptional()
  @IsString()
  en?: string;

  @IsOptional()
  @IsString()
  ar?: string;
}

export class PatchHomeSectionDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  itemLimit?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => HomeSectionNamesDto)
  names?: HomeSectionNamesDto;
}

export class ReplaceStorePicksDto {
  @IsArray()
  @ArrayMaxSize(24)
  @IsString({ each: true })
  productIds!: string[];
}
