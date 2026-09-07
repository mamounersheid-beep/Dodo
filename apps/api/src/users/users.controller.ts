import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Res,
  UseGuards,
  HttpCode,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { CurrentSession } from "../common/decorators/current-session.decorator";
import type { AuthUser } from "../auth/auth.types";
import { AnonymizeDto } from "../auth/dto/anonymize.dto";
import { ChangePasswordDto } from "../auth/dto/change-password.dto";
import { EmailChangeDto } from "../auth/dto/email-change.dto";
import { LogoutAllDto } from "../auth/dto/logout-all.dto";
import { UsersService } from "./users.service";
import { GdprService } from "./gdpr.service";
import { UpdateProfileDto } from "./dto/update-profile.dto";

@ApiTags("users")
@Controller()
export class UsersController {
  constructor(
    private readonly svc: UsersService,
    private readonly gdpr: GdprService,
  ) {}

  @Get("users/_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }

  @Patch("me/profile")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.svc.updateProfile(user, dto);
  }

  @Post("me/password")
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  changePassword(
    @CurrentUser() user: AuthUser,
    @CurrentSession() sessionId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.svc.changePassword(user, dto, sessionId);
  }

  @Post("me/email-change")
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  emailChange(@CurrentUser() user: AuthUser, @Body() dto: EmailChangeDto) {
    return this.svc.requestEmailChange(user, dto);
  }

  @Post("me/resend-verification")
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  resendVerification(@CurrentUser() user: AuthUser) {
    return this.svc.resendVerification(user);
  }

  @Get("me/sessions")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  listSessions(@CurrentUser() user: AuthUser, @CurrentSession() sessionId: string) {
    return this.svc.listSessions(user, sessionId);
  }

  @Post("me/sessions/logout-all")
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  logoutAll(
    @CurrentUser() user: AuthUser,
    @Body() dto: LogoutAllDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.svc.logoutAll(user, dto, res);
  }

  @Get("me/gdpr/export")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  exportData(@CurrentUser() user: AuthUser) {
    return this.gdpr.export(user);
  }

  @Post("me/gdpr/anonymize")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  anonymize(
    @CurrentUser() user: AuthUser,
    @Body() dto: AnonymizeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.gdpr.anonymize(user, dto, res);
  }
}
