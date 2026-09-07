import { IsInt, IsString, Matches, Min } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

/** Money as decimal string — never float in DTOs. */
export class MoneyDto {
  @ApiProperty({ example: "19.99" })
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: "money must be a decimal string" })
  amount!: string;
}

export class QuantityDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;
}
