import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { AuthEmailService } from "../auth/auth-email.service";
import { hashPassword, verifyPassword } from "../auth/crypto.util";
import type { AuthUser } from "../auth/auth.types";
import type { ChangePasswordDto } from "../auth/dto/change-password.dto";
import type { EmailChangeDto } from "../auth/dto/email-change.dto";
import type { LogoutAllDto } from "../auth/dto/logout-all.dto";
import {
  VERIFICATION_TOKEN_TYPES,
  VerificationTokenService,
} from "../auth/verification-token.service";
import type { UpdateProfileDto } from "./dto/update-profile.dto";

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly tokens: VerificationTokenService,
    private readonly authEmail: AuthEmailService,
  ) {}

  skeleton() {
    return { module: "users", ready: true, step: "10.1" };
  }

  async updateProfile(user: AuthUser, dto: UpdateProfileDto) {
    const data: {
      name?: string | null;
      companyName?: string | null;
      vatId?: string | null;
      locale?: string;
    } = {};

    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.companyName !== undefined) data.companyName = dto.companyName;
    if (dto.vatId !== undefined) data.vatId = dto.vatId;
    if (dto.locale !== undefined) data.locale = dto.locale;

    await this.prisma.user.update({
      where: { id: user.id },
      data,
    });

    await this.audit.write({
      actorType: "USER",
      actorId: user.id,
      action: "profile.update",
      entityType: "User",
      entityId: user.id,
      afterJson: data,
    });

    return this.auth.me(user);
  }

  async changePassword(user: AuthUser, dto: ChangePasswordDto, sessionId: string) {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!row.passwordHash || !(await verifyPassword(row.passwordHash, dto.currentPassword))) {
      throw new UnauthorizedException({ error: "UNAUTHORIZED", message: "Current password incorrect" });
    }

    const passwordHash = await hashPassword(dto.newPassword);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.session.updateMany({
        where: {
          userId: user.id,
          revokedAt: null,
          id: { not: sessionId },
        },
        data: { revokedAt: now },
      });
    });

    await this.audit.write({
      actorType: "USER",
      actorId: user.id,
      action: "password.change",
      entityType: "User",
      entityId: user.id,
    });

    return { ok: true };
  }

  async requestEmailChange(user: AuthUser, dto: EmailChangeDto) {
    const newEmail = dto.newEmail.trim().toLowerCase();
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    if (newEmail === row.email) {
      throw new BadRequestException({ error: "BAD_REQUEST", message: "New email must differ from current" });
    }

    const taken = await this.prisma.user.findUnique({ where: { email: newEmail } });
    if (taken && !taken.anonymizedAt) {
      throw new ConflictException({ error: "CONFLICT", message: "Email already registered" });
    }

    const issued = await this.tokens.issue({
      userId: user.id,
      email: newEmail,
      type: VERIFICATION_TOKEN_TYPES.EMAIL_CHANGE,
    });
    await this.authEmail.sendForToken(issued, row.locale);

    return { ok: true, message: "Verification email sent to the new address" };
  }

  async resendVerification(user: AuthUser) {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (row.emailVerifiedAt) {
      return { ok: true, message: "Already verified" };
    }

    const issued = await this.tokens.issue({
      userId: user.id,
      email: row.email,
      type: VERIFICATION_TOKEN_TYPES.EMAIL_VERIFY,
    });
    await this.authEmail.sendForToken(issued, row.locale);

    return { ok: true };
  }

  async listSessions(user: AuthUser, currentSessionId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
        ip: true,
        userAgent: true,
      },
    });

    return sessions.map((s) => ({
      ...s,
      isCurrent: s.id === currentSessionId && !s.revokedAt,
    }));
  }

  async logoutAll(user: AuthUser, dto: LogoutAllDto, res: Response) {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!row.passwordHash || !(await verifyPassword(row.passwordHash, dto.currentPassword))) {
      throw new UnauthorizedException({ error: "UNAUTHORIZED", message: "Password incorrect" });
    }

    const now = new Date();
    await this.prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    });
    this.auth.clearRefreshCookie(res);

    await this.audit.write({
      actorType: "USER",
      actorId: user.id,
      action: "auth.logout_all",
      entityType: "User",
      entityId: user.id,
    });

    return { ok: true };
  }
}
