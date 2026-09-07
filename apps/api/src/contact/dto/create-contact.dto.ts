import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import {
  CONTACT_EMAIL_MAX,
  CONTACT_MESSAGE_MAX,
  CONTACT_NAME_MAX,
  CONTACT_ORDER_NUMBER_MAX,
  CONTACT_SUBJECTS,
} from "../contact.constants";

export class CreateContactDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(CONTACT_NAME_MAX)
  name!: string;

  @ApiProperty()
  @IsEmail()
  @MaxLength(CONTACT_EMAIL_MAX)
  email!: string;

  @ApiProperty({ enum: CONTACT_SUBJECTS })
  @IsIn(CONTACT_SUBJECTS)
  subject!: (typeof CONTACT_SUBJECTS)[number];

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(CONTACT_MESSAGE_MAX)
  message!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(CONTACT_ORDER_NUMBER_MAX)
  orderNumber?: string;
}
