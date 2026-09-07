import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";

export class ForgotPasswordDto {
  @ApiProperty({ example: "kunde@example.com" })
  @IsString()
  @MaxLength(320)
  email!: string;
}
