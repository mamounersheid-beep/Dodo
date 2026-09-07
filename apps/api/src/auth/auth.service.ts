import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { RoleCode } from "@dodo/shared-types";
import type { Response, Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { durationToMs, env } from "../config/env";
import { hashPassword, hashToken, newRefreshToken, verifyPassword } from "./crypto.util";
import { REFRESH_COOKIE, type AuthUser, type JwtPayload } from "./auth.types";
import type { LoginDto } from "./dto/login.dto";
import type { RegisterDto } from "./dto/register.dto";
import type { ForgotPasswordDto } from "./dto/forgot-password.dto";
import type { ResetPasswordDto } from "./dto/reset-password.dto";
import type { VerifyEmailDto } from "./dto/verify-email.dto";
import { AuthEmailService } from "./auth-email.service";
import {
  VERIFICATION_TOKEN_TYPES,
  VerificationTokenInvalidError,
  VerificationTokenService,
} from "./verification-token.service";

const FORGOT_OK = {
  ok: true,
  message: "If an account exists for this email, instructions have been sent.",
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly tokens: VerificationTokenService,
    private readonly authEmail: AuthEmailService,
  ) {}

  ping() {
    return { module: "auth", ready: true, step: "10.1" };
  }

  async register(dto: RegisterDto, req: Request, res: Response) {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing && !existing.anonymizedAt) {
      throw new ConflictException({ error: "CONFLICT", message: "Email already registered" });
    }

    const passwordHash = await hashPassword(dto.password);
    const customerRole = await this.prisma.role.findUniqueOrThrow({
      where: { code: RoleCode.CUSTOMER },
    });

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          passwordHash,
          name: dto.name?.trim() || null,
          locale: dto.locale ?? "de",
          roles: { create: { roleId: customerRole.id } },
          bonusAccount: { create: {} },
        },
        include: { roles: { include: { role: true } } },
      });
      return created;
    });

    const issued = await this.tokens.issue({
      userId: user.id,
      email: user.email,
      type: VERIFICATION_TOKEN_TYPES.EMAIL_VERIFY,
    });
    await this.authEmail.sendForToken(issued, user.locale);

    await this.audit.write({
      actorType: "USER",
      actorId: user.id,
      action: "auth.register",
      entityType: "User",
      entityId: user.id,
    });

    return this.issueSession(user.id, this.rolesOf(user), req, res);
  }

  async login(dto: LoginDto, req: Request, res: Response) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { roles: { include: { role: true } } },
    });

    const fail = async (): Promise<never> => {
      await this.audit.write({
        actorType: "SYSTEM",
        action: "auth.login_failed",
        entityType: "User",
        entityId: email,
      });
      throw new UnauthorizedException({ error: "UNAUTHORIZED", message: "Invalid credentials" });
    };

    if (!user || user.deletedAt || user.anonymizedAt || !user.passwordHash) {
      return fail();
    }
    const ok = await verifyPassword(user.passwordHash, dto.password);
    if (!ok) return fail();

    await this.audit.write({
      actorType: "USER",
      actorId: user.id,
      action: "auth.login",
      entityType: "User",
      entityId: user.id,
    });

    return this.issueSession(user.id, this.rolesOf(user), req, res);
  }

  async refresh(req: Request, res: Response) {
    const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!raw) {
      throw new UnauthorizedException({ error: "UNAUTHORIZED", message: "Refresh cookie missing" });
    }
    const tokenHash = hashToken(raw);
    const session = await this.prisma.session.findFirst({
      where: { refreshTokenHash: tokenHash },
      include: { user: { include: { roles: { include: { role: true } } } } },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      this.clearRefreshCookie(res);
      throw new UnauthorizedException({ error: "UNAUTHORIZED", message: "Refresh revoked or expired" });
    }
    if (session.user.deletedAt || session.user.anonymizedAt) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      this.clearRefreshCookie(res);
      throw new UnauthorizedException({ error: "UNAUTHORIZED", message: "Account unavailable" });
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    return this.issueSession(session.userId, this.rolesOf(session.user), req, res);
  }

  async logout(req: Request, res: Response, user: AuthUser, sessionId: string) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.clearRefreshCookie(res);
    await this.audit.write({
      actorType: "USER",
      actorId: user.id,
      action: "auth.logout",
      entityType: "Session",
      entityId: sessionId,
    });
    return { ok: true };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && !user.anonymizedAt && !user.deletedAt && user.passwordHash) {
      await this.tokens.invalidateActiveForUser(
        user.id,
        VERIFICATION_TOKEN_TYPES.PASSWORD_RESET,
      );
      const issued = await this.tokens.issue({
        userId: user.id,
        email: user.email,
        type: VERIFICATION_TOKEN_TYPES.PASSWORD_RESET,
        invalidatePrevious: false,
      });
      await this.authEmail.sendForToken(issued, user.locale);
    }
    return FORGOT_OK;
  }

  async resetPassword(dto: ResetPasswordDto) {
    let consumed;
    try {
      consumed = await this.tokens.consume(dto.token, [VERIFICATION_TOKEN_TYPES.PASSWORD_RESET]);
    } catch (e) {
      if (e instanceof VerificationTokenInvalidError) {
        throw new BadRequestException({ error: "BAD_REQUEST", message: "Invalid or expired token" });
      }
      throw e;
    }

    if (!consumed.userId) {
      throw new BadRequestException({ error: "BAD_REQUEST", message: "Invalid or expired token" });
    }

    const passwordHash = await hashPassword(dto.newPassword);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { userId: consumed.userId!, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.verificationToken.updateMany({
        where: {
          userId: consumed.userId!,
          usedAt: null,
          id: { not: consumed.id },
        },
        data: { usedAt: now },
      });
      await tx.user.update({
        where: { id: consumed.userId! },
        data: { passwordHash },
      });
    });

    await this.audit.write({
      actorType: "USER",
      actorId: consumed.userId,
      action: "auth.password_reset",
      entityType: "User",
      entityId: consumed.userId,
    });

    return { ok: true };
  }

  async verifyEmail(dto: VerifyEmailDto) {
    let consumed;
    try {
      consumed = await this.tokens.consume(dto.token, [
        VERIFICATION_TOKEN_TYPES.EMAIL_VERIFY,
        VERIFICATION_TOKEN_TYPES.EMAIL_CHANGE,
      ]);
    } catch (e) {
      if (e instanceof VerificationTokenInvalidError) {
        throw new BadRequestException({ error: "BAD_REQUEST", message: "Invalid or expired token" });
      }
      throw e;
    }

    const now = new Date();

    if (consumed.type === VERIFICATION_TOKEN_TYPES.EMAIL_VERIFY) {
      if (!consumed.userId) {
        throw new BadRequestException({ error: "BAD_REQUEST", message: "Invalid or expired token" });
      }
      await this.prisma.user.update({
        where: { id: consumed.userId },
        data: { emailVerifiedAt: now },
      });
      await this.audit.write({
        actorType: "USER",
        actorId: consumed.userId,
        action: "auth.email_verified",
        entityType: "User",
        entityId: consumed.userId,
      });
      return { ok: true, type: consumed.type };
    }

    if (!consumed.userId) {
      throw new BadRequestException({ error: "BAD_REQUEST", message: "Invalid or expired token" });
    }

    const conflict = await this.prisma.user.findUnique({
      where: { email: consumed.email },
    });
    if (conflict && conflict.id !== consumed.userId) {
      throw new BadRequestException({ error: "BAD_REQUEST", message: "Invalid or expired token" });
    }

    await this.prisma.user.update({
      where: { id: consumed.userId },
      data: {
        email: consumed.email,
        emailVerifiedAt: now,
      },
    });

    await this.audit.write({
      actorType: "USER",
      actorId: consumed.userId,
      action: "email.change",
      entityType: "User",
      entityId: consumed.userId,
      afterJson: { email: consumed.email },
    });

    return { ok: true, type: consumed.type };
  }

  async me(user: AuthUser) {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      locale: row.locale,
      emailVerifiedAt: row.emailVerifiedAt,
      companyName: row.companyName,
      vatId: row.vatId,
    };
  }

  private rolesOf(user: { roles: { role: { code: string } }[] }): RoleCode[] {
    return user.roles.map((r) => r.role.code as RoleCode);
  }

  private async issueSession(
    userId: string,
    roles: RoleCode[],
    req: Request,
    res: Response,
  ) {
    const refreshRaw = newRefreshToken();
    const refreshTtlMs = durationToMs(env.JWT_REFRESH_TTL);
    const expiresAt = new Date(Date.now() + refreshTtlMs);
    const session = await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: hashToken(refreshRaw),
        expiresAt,
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"]?.toString() ?? null,
      },
    });

    const payload: JwtPayload = { sub: userId, sid: session.id, roles };
    const accessToken = await this.jwt.signAsync(payload);

    this.setRefreshCookie(res, refreshRaw, refreshTtlMs);
    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: env.JWT_ACCESS_TTL,
      user: { id: userId, roles },
    };
  }

  private setRefreshCookie(res: Response, token: string, maxAgeMs: number) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: env.COOKIE_SECURE ?? env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/v1/auth",
      maxAge: maxAgeMs,
    });
  }

  clearRefreshCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: env.COOKIE_SECURE ?? env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/v1/auth",
    });
  }
}
