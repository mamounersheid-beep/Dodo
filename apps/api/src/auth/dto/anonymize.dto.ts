import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength } from "class-validator";

export class AnonymizeDto {
  @ApiProperty({ description: "Current password confirmation" })
  @IsString()
  @MinLength(1)
  password!: string;
}
