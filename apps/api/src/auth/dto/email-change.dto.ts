import { ApiProperty } from "@nestjs/swagger";
import { IsEmail } from "class-validator";

export class EmailChangeDto {
  @ApiProperty({ example: "neu@example.com" })
  @IsEmail()
  newEmail!: string;
}
