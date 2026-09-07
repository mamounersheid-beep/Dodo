import { Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { hashToken, tokensEqual } from "../auth/crypto.util";

export const VERIFICATION_TOKEN_TYPES = {
  EMAIL_VERIFY: "email_verify",
  EMAIL_CHANGE: "email_change",
  PASSWORD_RESET: "password_reset",
} as const;

export type VerificationTokenType =
  (typeof VERIFICATION_TOKEN_TYPES)[keyof typeof VERIFICATION_TOKEN_TYPES];

const TTL_MS: Record<VerificationTokenType, number> = {
  email_verify: 24 * 60 * 60 * 1000,
  email_change: 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
};

export type IssuedVerificationToken = {
  id: string;
  raw: string;
  type: VerificationTokenType;
  email: string;
  userId: string | null;
};

@Injectable()
export class VerificationTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(params: {
    userId: string | null;
    email: string;
    type: VerificationTokenType;
    invalidatePrevious?: boolean;
  }): Promise<IssuedVerificationToken> {
    const email = params.email.trim().toLowerCase();

    if (params.invalidatePrevious !== false && params.userId) {
      await this.prisma.verificationToken.updateMany({
        where: {
          userId: params.userId,
          type: params.type,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });
    }

    const raw = randomBytes(32).toString("base64url");
    const record = await this.prisma.verificationToken.create({
      data: {
        userId: params.userId,
        email,
        type: params.type,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + TTL_MS[params.type]),
      },
    });

    return {
      id: record.id,
      raw,
      type: params.type,
      email,
      userId: params.userId,
    };
  }

  async consume(
    raw: string,
    allowedTypes: VerificationTokenType[],
  ): Promise<{ id: string; type: VerificationTokenType; userId: string | null; email: string }> {
    const tokenHash = hashToken(raw);
    const candidates = await this.prisma.verificationToken.findMany({
      where: {
        type: { in: allowedTypes },
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const match = candidates.find((c) => tokensEqual(c.tokenHash, tokenHash));
    if (!match) {
      throw new VerificationTokenInvalidError();
    }

    await this.prisma.verificationToken.update({
      where: { id: match.id },
      data: { usedAt: new Date() },
    });

    return {
      id: match.id,
      type: match.type as VerificationTokenType,
      userId: match.userId,
      email: match.email,
    };
  }

  async invalidateActiveForUser(userId: string, type: VerificationTokenType): Promise<void> {
    await this.prisma.verificationToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: new Date() },
    });
  }
}

export class VerificationTokenInvalidError extends Error {
  constructor() {
    super("VERIFICATION_TOKEN_INVALID");
  }
}
