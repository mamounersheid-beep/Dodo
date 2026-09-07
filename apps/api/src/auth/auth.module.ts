import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthEmailService } from "./auth-email.service";
import { VerificationTokenService } from "./verification-token.service";
import { AuditModule } from "../audit/audit.module";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { env } from "../config/env";

@Module({
  imports: [
    AuditModule,
    JwtModule.register({
      global: true,
      secret: env.JWT_ACCESS_SECRET,
      signOptions: {
        expiresIn: env.JWT_ACCESS_TTL as `${number}${"s" | "m" | "h" | "d"}`,
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthEmailService,
    VerificationTokenService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [
    AuthService,
    AuthEmailService,
    VerificationTokenService,
    JwtAuthGuard,
    RolesGuard,
    JwtModule,
  ],
})
export class AuthModule {}
