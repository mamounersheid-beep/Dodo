import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import {
  AdminHttpIdempotencyStatus,
  Prisma,
} from "@dodo/database";
import { PrismaService } from "../prisma/prisma.service";
import {
  ADMIN_HTTP_IDEMPOTENCY_RESPONSE_MAX_BYTES,
  ADMIN_HTTP_IDEMPOTENCY_TTL_MS,
  AdminHttpIdempotencyError,
  W3_ADMIN_REFUND_NAMESPACE,
  type AdminHttpIdempotencyOperation,
} from "./admin-http-idempotency.constants";
import { requireAdminHttpIdempotencyKey } from "./admin-http-idempotency.key";

export type AdminHttpIdempotencyClaimResult =
  | { kind: "claimed"; id: string }
  | { kind: "replay"; httpStatus: number; body: unknown };

export type AdminHttpClaimInput = {
  actorId: string;
  keyRaw: string | undefined;
  fingerprint: string;
  operation: AdminHttpIdempotencyOperation;
  targetId: string;
};

@Injectable()
export class AdminHttpIdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claim or replay for (actorId, w3.admin.refund, key).
   * Pre-claim auth/404 failures must not call this (no row poison).
   */
  async claimOrReplay(input: AdminHttpClaimInput): Promise<AdminHttpIdempotencyClaimResult> {
    const key = requireAdminHttpIdempotencyKey(input.keyRaw);
    const namespace = W3_ADMIN_REFUND_NAMESPACE;
    const existing = await this.prisma.adminHttpIdempotency.findUnique({
      where: {
        actorId_namespace_key: {
          actorId: input.actorId,
          namespace,
          key,
        },
      },
    });
    if (existing) {
      return this.resolveExisting(existing, input.fingerprint);
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ADMIN_HTTP_IDEMPOTENCY_TTL_MS);
    try {
      const row = await this.prisma.adminHttpIdempotency.create({
        data: {
          actorId: input.actorId,
          namespace,
          key,
          fingerprint: input.fingerprint,
          operation: input.operation,
          targetId: input.targetId,
          status: AdminHttpIdempotencyStatus.IN_PROGRESS,
          createdAt,
          expiresAt,
        },
      });
      return { kind: "claimed", id: row.id };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        const again = await this.prisma.adminHttpIdempotency.findUnique({
          where: {
            actorId_namespace_key: {
              actorId: input.actorId,
              namespace,
              key,
            },
          },
        });
        if (!again) {
          throw e;
        }
        return this.resolveExisting(again, input.fingerprint);
      }
      throw e;
    }
  }

  /**
   * Post-claim pre-mutation business failure — delete IN_PROGRESS so key is reusable.
   */
  async deleteClaim(id: string): Promise<void> {
    await this.prisma.adminHttpIdempotency.deleteMany({
      where: { id, status: AdminHttpIdempotencyStatus.IN_PROGRESS },
    });
  }

  /**
   * After mutation/provider outcome — COMPLETED + exact HTTP status/body for replay.
   */
  async complete(input: {
    id: string;
    httpStatus: number;
    body: unknown;
  }): Promise<void> {
    const bodyJson = this.assertResponseBodySize(input.body);
    const completedAt = new Date();
    await this.prisma.adminHttpIdempotency.update({
      where: { id: input.id },
      data: {
        status: AdminHttpIdempotencyStatus.COMPLETED,
        httpStatus: input.httpStatus,
        responseBodyJson: bodyJson as Prisma.InputJsonValue,
        completedAt,
      },
    });
  }

  /**
   * Binding cleanup: hard-delete every row where expiresAt <= now (any status).
   */
  async purgeExpired(now: Date = new Date()): Promise<{ deletedCount: number }> {
    const result = await this.prisma.adminHttpIdempotency.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return { deletedCount: result.count };
  }

  private resolveExisting(
    row: {
      fingerprint: string;
      status: AdminHttpIdempotencyStatus;
      httpStatus: number | null;
      responseBodyJson: Prisma.JsonValue | null;
    },
    fingerprint: string,
  ): AdminHttpIdempotencyClaimResult {
    if (row.fingerprint !== fingerprint) {
      throw new ConflictException({
        error: AdminHttpIdempotencyError.PAYLOAD_MISMATCH,
        message: "Idempotency-Key reused with a different payload",
      });
    }
    if (row.status === AdminHttpIdempotencyStatus.IN_PROGRESS) {
      throw new ConflictException({
        error: AdminHttpIdempotencyError.IN_PROGRESS,
        message: "Idempotency-Key request still in progress",
      });
    }
    if (row.httpStatus == null) {
      throw new ConflictException({
        error: AdminHttpIdempotencyError.IN_PROGRESS,
        message: "Idempotency-Key request still in progress",
      });
    }
    return {
      kind: "replay",
      httpStatus: row.httpStatus,
      body: row.responseBodyJson,
    };
  }

  private assertResponseBodySize(body: unknown): unknown {
    const encoded = Buffer.byteLength(JSON.stringify(body ?? null), "utf8");
    if (encoded > ADMIN_HTTP_IDEMPOTENCY_RESPONSE_MAX_BYTES) {
      throw new BadRequestException({
        error: AdminHttpIdempotencyError.RESPONSE_TOO_LARGE,
        message: `responseBodyJson exceeds ${ADMIN_HTTP_IDEMPOTENCY_RESPONSE_MAX_BYTES} bytes`,
      });
    }
    return body;
  }
}
