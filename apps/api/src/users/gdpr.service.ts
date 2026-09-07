import {
  Injectable,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { hashPassword, verifyPassword } from "../auth/crypto.util";
import type { AuthUser } from "../auth/auth.types";
import type { AnonymizeDto } from "../auth/dto/anonymize.dto";

@Injectable()
export class GdprService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async export(user: AuthUser) {
    const full = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: {
        addresses: true,
        orders: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            paymentStatus: true,
            grandTotal: true,
            currencyCode: true,
            createdAt: true,
            invoices: {
              select: { id: true, invoiceNumber: true, issuedAt: true, grandTotalSnapshot: true },
            },
          },
        },
        bonusAccount: { include: { ledger: { orderBy: { createdAt: "asc" } } } },
        sessions: {
          select: {
            id: true,
            createdAt: true,
            expiresAt: true,
            revokedAt: true,
            ip: true,
            userAgent: true,
          },
        },
        reviews: {
          select: {
            id: true,
            productId: true,
            rating: true,
            body: true,
            status: true,
            createdAt: true,
          },
        },
        roles: { include: { role: true } },
      },
    });

    // Paper Decision 2026-09-03: CookieConsent where userId = authenticated user only
    // (no guest visitorKey merge; no User↔CookieConsent Prisma relation)
    const cookieConsents = await this.prisma.cookieConsent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });

    await this.audit.write({
      actorType: "USER",
      actorId: user.id,
      action: "gdpr.export",
      entityType: "User",
      entityId: user.id,
    });

    return {
      exportedAt: new Date().toISOString(),
      user: {
        id: full.id,
        email: full.email,
        name: full.name,
        companyName: full.companyName,
        vatId: full.vatId,
        locale: full.locale,
        createdAt: full.createdAt,
        roles: full.roles.map((r) => r.role.code),
      },
      addresses: full.addresses,
      orders: full.orders,
      bonus: full.bonusAccount
        ? {
            balanceCached: full.bonusAccount.balanceCached,
            ledger: full.bonusAccount.ledger,
          }
        : null,
      sessions: full.sessions,
      reviews: full.reviews,
      cookieConsents,
    };
  }

  async anonymize(user: AuthUser, dto: AnonymizeDto, res: Response) {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    // Gap B Paper Decision 2026-09-03: public rejection body via res (bypass AllExceptionsFilter rewrite)
    if (!row.passwordHash || !(await verifyPassword(row.passwordHash, dto.password))) {
      res.status(401).json({ status: "rejected", reason: "INVALID_PASSWORD" });
      return;
    }
    if (row.anonymizedAt) {
      res.status(400).json({ status: "rejected", reason: "ALREADY_ANONYMIZED" });
      return;
    }

    const anonymizedEmail = `deleted-${user.id}@anonymized.invalid`;
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      // Gap C Paper Decision 2026-09-03: invalidate all active VerificationTokens for this user
      await tx.verificationToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      });
      await tx.address.deleteMany({ where: { userId: user.id } });
      await tx.wishlistItem.deleteMany({ where: { userId: user.id } });
      await tx.cookieConsent.deleteMany({ where: { userId: user.id } });
      // Reviews kept for product integrity (FK Restrict); scrub free-text PII only
      await tx.review.updateMany({
        where: { userId: user.id },
        data: { body: null },
      });
      await tx.user.update({
        where: { id: user.id },
        data: {
          email: anonymizedEmail,
          passwordHash: await hashPassword(cryptoRandomPassword()),
          name: null,
          companyName: null,
          vatId: null,
          anonymizedAt: now,
          deletedAt: now,
        },
      });
      // Bonus ledger retained (orders link); balance zeroed with documented ADJUST if account exists
      const account = await tx.bonusAccount.findUnique({ where: { userId: user.id } });
      if (account && account.balanceCached !== 0) {
        await tx.bonusLedger.create({
          data: {
            accountId: account.id,
            type: "ADJUST",
            points: -account.balanceCached,
            idempotencyKey: `gdpr-anonymize:${user.id}`,
            actorType: "USER",
            actorId: user.id,
            note: "GDPR anonymize — balance cleared; historic ledger rows kept",
          },
        });
        await tx.bonusAccount.update({
          where: { id: account.id },
          data: { balanceCached: 0 },
        });
      }
    });

    this.auth.clearRefreshCookie(res);

    await this.audit.write({
      actorType: "USER",
      actorId: user.id,
      action: "gdpr.anonymize",
      entityType: "User",
      entityId: user.id,
      afterJson: { email: anonymizedEmail, anonymizedAt: now.toISOString() },
    });

    return { status: "done", anonymizedAt: now.toISOString() };
  }
}

function cryptoRandomPassword(): string {
  return randomBytes(32).toString("base64url");
}
