import { Injectable } from "@nestjs/common";
import type { ActorType, Prisma } from "@dodo/database";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  skeleton() {
    return { module: "audit", ready: true, commerce: false };
  }

  async write(input: {
    actorType: ActorType;
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    beforeJson?: Prisma.InputJsonValue;
    afterJson?: Prisma.InputJsonValue;
  }) {
    return this.prisma.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        beforeJson: input.beforeJson ?? undefined,
        afterJson: input.afterJson ?? undefined,
      },
    });
  }
}
