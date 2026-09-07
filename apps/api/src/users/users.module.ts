import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AuditModule } from "../audit/audit.module";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { GdprService } from "./gdpr.service";

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [UsersController],
  providers: [UsersService, GdprService],
})
export class UsersModule {}
