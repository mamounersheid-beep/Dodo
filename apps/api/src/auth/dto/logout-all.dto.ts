import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength } from "class-validator";

export class LogoutAllDto {
  @ApiProperty()
  @IsString()
  @MaxLength(128)
  currentPassword!: string;
}
