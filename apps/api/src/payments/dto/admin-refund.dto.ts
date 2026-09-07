import {
  Equals,
  IsBoolean,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
} from "class-validator";

/** §4e CreateAdminRefundDto — amount XOR full; confirmed + currentPassword required. */
export class CreateAdminRefundDto {
  @ValidateIf((o: CreateAdminRefundDto) => o.full !== true)
  @IsString()
  @MinLength(1)
  amount?: string;

  @ValidateIf((o: CreateAdminRefundDto) => o.amount === undefined)
  @IsBoolean()
  @Equals(true)
  full?: true;

  @IsOptional()
  @IsString()
  paymentId?: string;

  @IsOptional()
  @IsString()
  returnRequestId?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  currencyCode?: string;

  @IsBoolean()
  @Equals(true)
  confirmed!: true;

  @IsString()
  @MinLength(1)
  currentPassword!: string;
}

export class CancelAdminRefundDto {
  @IsBoolean()
  @Equals(true)
  confirmed!: true;

  @IsString()
  @MinLength(1)
  currentPassword!: string;
}

export class RetryAdminRefundDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  amount?: string;

  @IsOptional()
  @IsBoolean()
  @Equals(true)
  full?: true;

  @IsOptional()
  @IsString()
  paymentId?: string;

  @IsOptional()
  @IsString()
  returnRequestId?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  currencyCode?: string;

  @IsBoolean()
  @Equals(true)
  confirmed!: true;

  @IsString()
  @MinLength(1)
  currentPassword!: string;
}

/** Empty recover body — forbid extra fields via ValidationPipe. */
export class RecoverAdminRefundDto {}

export type AdminRefundDto = {
  id: string;
  orderId: string;
  paymentId: string;
  returnRequestId: string | null;
  amount: string;
  currencyCode: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  providerRefundId: string | null;
  reason: string | null;
  createdAt: string;
  completedAt: string | null;
  orderPaymentStatus: string;
};
