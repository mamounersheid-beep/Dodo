import { BadRequestException, HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { ActorType } from "@dodo/database";
import type { AuthUser } from "../auth/auth.types";
import { COMPANY_SETTINGS_ID } from "../company-settings/company-settings.service";
import { QueuedEmailAdapter } from "../integrations/email/queued-email.adapter";
import { PrismaService } from "../prisma/prisma.service";
import {
  CONTACT_AUDIT_ACTION,
  CONTACT_THROTTLE_LIMIT,
  CONTACT_THROTTLE_TTL_MS,
  type ContactSubject,
} from "./contact.constants";

export type ContactSubmitInput = {
  name: string;
  email: string;
  subject: ContactSubject;
  message: string;
  orderNumber?: string;
};

@Injectable()
export class ContactService {
  private readonly emailHits = new Map<string, number[]>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QueuedEmailAdapter) private readonly email: QueuedEmailAdapter,
  ) {}

  async submit(input: ContactSubmitInput, user: AuthUser | undefined): Promise<{ message: string }> {
    this.assertEmailRateLimit(input.email);

    const orderNumber = present(input.orderNumber);
    if (user && orderNumber) {
      const owned = await this.prisma.order.findFirst({
        where: { orderNumber, userId: user.id },
        select: { id: true },
      });
      if (!owned) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: "Invalid request",
        });
      }
    }

    const settings = await this.prisma.companySettings.findUnique({
      where: { id: COMPANY_SETTINGS_ID },
      select: { supportEmail: true },
    });
    const supportEmail = present(settings?.supportEmail);
    const submissionId = randomBytes(12).toString("hex");
    const queued = supportEmail !== undefined;

    await this.prisma.auditLog.create({
      data: {
        actorType: ActorType.USER,
        actorId: user?.id ?? null,
        action: CONTACT_AUDIT_ACTION,
        entityType: "Contact",
        entityId: submissionId,
        afterJson: {
          subject: input.subject,
          orderNumberPresent: orderNumber !== undefined,
          queued,
          registered: user !== undefined,
        },
      },
    });

    if (supportEmail !== undefined) {
      await this.email.enqueueContactForm({
        submissionId,
        to: supportEmail,
        name: input.name.trim(),
        replyEmail: input.email.trim(),
        subject: input.subject,
        message: input.message.trim(),
        orderNumber,
        userId: user?.id,
      });
    }

    return { message: "Accepted" };
  }

  private assertEmailRateLimit(email: string): void {
    const key = email.trim().toLowerCase();
    const now = Date.now();
    const hits = (this.emailHits.get(key) ?? []).filter((t) => now - t < CONTACT_THROTTLE_TTL_MS);
    if (hits.length >= CONTACT_THROTTLE_LIMIT) {
      throw new HttpException(
        { error: "RATE_LIMITED", message: "Too many requests" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    hits.push(now);
    this.emailHits.set(key, hits);
  }
}

function present(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const t = value.trim();
  return t.length === 0 ? undefined : t;
}
