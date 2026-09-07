/**
 * Focused Verification — W3 Admin HTTP Idempotency Durable Storage + 72h Cleanup
 * SoT: docs/10.9-payments-webhooks.md §4f Persist
 *
 * Requires: DATABASE_URL (migration 20260905210000_w3_admin_http_idempotency applied)
 * Run: pnpm --filter @dodo/api test:admin-http-idempotency
 *   (tsx) or after build: node dist/admin-http-idempotency.selftest.js
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { AdminHttpIdempotencyStatus } from "@dodo/database";
import {
  ADMIN_HTTP_IDEMPOTENCY_KEY_MAX,
  ADMIN_HTTP_IDEMPOTENCY_KEY_MIN,
  ADMIN_HTTP_IDEMPOTENCY_RESPONSE_MAX_BYTES,
  ADMIN_HTTP_IDEMPOTENCY_TTL_MS,
  AdminHttpIdempotencyError,
  W3_ADMIN_REFUND_NAMESPACE,
} from "./admin-http-idempotency/admin-http-idempotency.constants";
import {
  hashAdminHttpIdempotencyFingerprint,
  requireAdminHttpIdempotencyKey,
} from "./admin-http-idempotency/admin-http-idempotency.key";
import { AdminHttpIdempotencyService } from "./admin-http-idempotency/admin-http-idempotency.service";
import { PrismaService } from "./prisma/prisma.service";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

const IDS = [
  "I1_claim_creates_in_progress",
  "I2_same_key_replay",
  "I3_fingerprint_mismatch",
  "I4_concurrent_same_key_claim",
  "I5_in_progress_blocks_reentry",
  "I6_expiry_cleanup",
  "I7_reuse_only_after_delete",
  "I8_cleanup_in_progress_and_completed",
  "I9_response_body_16kib_boundary",
  "I10_key_length_8_128_boundary",
  "I11_unique_actor_namespace_key",
  "I12_expires_at_created_plus_72h",
] as const;

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function errCode(e: unknown): string | undefined {
  if (e instanceof ConflictException || e instanceof BadRequestException) {
    const body = e.getResponse();
    if (typeof body === "object" && body && "error" in body) {
      return String((body as { error: string }).error);
    }
  }
  return undefined;
}

function keyOf(len: number, prefix = "k"): string {
  const body = randomBytes(Math.ceil(len / 2))
    .toString("hex")
    .slice(0, Math.max(0, len - prefix.length));
  return (prefix + body).slice(0, len);
}

async function main() {
  console.log("Focused Verification — W3 Admin HTTP Idempotency (§4f Persist)\n");
  const results: Result[] = [];
  const prisma = new PrismaService();
  await prisma.$connect();
  const svc = new AdminHttpIdempotencyService(prisma);
  const stamp = `${Date.now()}`;
  const actorA = `actor-a-${stamp}`;
  const actorB = `actor-b-${stamp}`;
  const createdIds: string[] = [];

  const run = async (id: (typeof IDS)[number], fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ id, status: "PASS" });
      console.log(`  ✓ ${id}`);
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      results.push({ id, status: "FAIL", note });
      console.error(`  ✗ ${id}: ${note}`);
    }
  };

  const fp = (targetId: string, extra: Record<string, unknown> = {}) =>
    hashAdminHttpIdempotencyFingerprint({
      operation: "refund.create",
      targetId,
      canonicalBody: { amount: "10.00", confirmed: true, ...extra },
    });

  try {
    await run("I1_claim_creates_in_progress", async () => {
      const key = keyOf(16, "i1");
      const fingerprint = fp(`order-${stamp}-1`);
      const r = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key,
        fingerprint,
        operation: "refund.create",
        targetId: `order-${stamp}-1`,
      });
      if (r.kind !== "claimed") throw new Error(`expected claimed, got ${r.kind}`);
      createdIds.push(r.id);
      const row = await prisma.adminHttpIdempotency.findUniqueOrThrow({
        where: { id: r.id },
      });
      if (row.status !== AdminHttpIdempotencyStatus.IN_PROGRESS) {
        throw new Error(`status=${row.status}`);
      }
      if (row.namespace !== W3_ADMIN_REFUND_NAMESPACE) {
        throw new Error(`namespace=${row.namespace}`);
      }
    });

    await run("I2_same_key_replay", async () => {
      const key = keyOf(16, "i2");
      const targetId = `order-${stamp}-2`;
      const fingerprint = fp(targetId);
      const c = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key,
        fingerprint,
        operation: "refund.create",
        targetId,
      });
      if (c.kind !== "claimed") throw new Error("claim failed");
      createdIds.push(c.id);
      const body = { id: "refund-replay", status: "PENDING" };
      await svc.complete({ id: c.id, httpStatus: 201, body });
      const again = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key,
        fingerprint,
        operation: "refund.create",
        targetId,
      });
      if (again.kind !== "replay") throw new Error(`expected replay, got ${again.kind}`);
      if (again.httpStatus !== 201) throw new Error(`status=${again.httpStatus}`);
      if (JSON.stringify(again.body) !== JSON.stringify(body)) {
        throw new Error("body mismatch on replay");
      }
    });

    await run("I3_fingerprint_mismatch", async () => {
      const key = keyOf(16, "i3");
      const targetId = `order-${stamp}-3`;
      const c = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key,
        fingerprint: fp(targetId),
        operation: "refund.create",
        targetId,
      });
      if (c.kind !== "claimed") throw new Error("claim failed");
      createdIds.push(c.id);
      await svc.complete({
        id: c.id,
        httpStatus: 201,
        body: { id: "x" },
      });
      try {
        await svc.claimOrReplay({
          actorId: actorA,
          keyRaw: key,
          fingerprint: fp(targetId, { amount: "99.00" }),
          operation: "refund.create",
          targetId,
        });
        throw new Error("expected mismatch");
      } catch (e) {
        if (errCode(e) !== AdminHttpIdempotencyError.PAYLOAD_MISMATCH) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
    });

    await run("I4_concurrent_same_key_claim", async () => {
      const key = keyOf(16, "i4");
      const targetId = `order-${stamp}-4`;
      const fingerprint = fp(targetId);
      const input = {
        actorId: actorA,
        keyRaw: key,
        fingerprint,
        operation: "refund.create" as const,
        targetId,
      };
      const [a, b] = await Promise.all([
        svc.claimOrReplay(input).catch((e) => e),
        svc.claimOrReplay(input).catch((e) => e),
      ]);
      const outcomes = [a, b];
      const claimed = outcomes.filter(
        (o) => o && typeof o === "object" && "kind" in o && o.kind === "claimed",
      );
      const inProgress = outcomes.filter(
        (o) => errCode(o) === AdminHttpIdempotencyError.IN_PROGRESS,
      );
      if (claimed.length !== 1) {
        throw new Error(`expected exactly 1 claim, got ${claimed.length}`);
      }
      if (inProgress.length !== 1) {
        throw new Error(`expected exactly 1 IN_PROGRESS, got ${inProgress.length}`);
      }
      createdIds.push((claimed[0] as { id: string }).id);
      const count = await prisma.adminHttpIdempotency.count({
        where: { actorId: actorA, namespace: W3_ADMIN_REFUND_NAMESPACE, key },
      });
      if (count !== 1) throw new Error(`row count=${count}`);
    });

    await run("I5_in_progress_blocks_reentry", async () => {
      const key = keyOf(16, "i5");
      const targetId = `order-${stamp}-5`;
      const fingerprint = fp(targetId);
      const c = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key,
        fingerprint,
        operation: "refund.create",
        targetId,
      });
      if (c.kind !== "claimed") throw new Error("claim failed");
      createdIds.push(c.id);
      try {
        await svc.claimOrReplay({
          actorId: actorA,
          keyRaw: key,
          fingerprint,
          operation: "refund.create",
          targetId,
        });
        throw new Error("expected IN_PROGRESS");
      } catch (e) {
        if (errCode(e) !== AdminHttpIdempotencyError.IN_PROGRESS) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
    });

    await run("I6_expiry_cleanup", async () => {
      const key = keyOf(16, "i6");
      const targetId = `order-${stamp}-6`;
      const c = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key,
        fingerprint: fp(targetId),
        operation: "refund.create",
        targetId,
      });
      if (c.kind !== "claimed") throw new Error("claim failed");
      const past = new Date(Date.now() - 60_000);
      await prisma.adminHttpIdempotency.update({
        where: { id: c.id },
        data: { expiresAt: past },
      });
      const purged = await svc.purgeExpired(new Date());
      if (purged.deletedCount < 1) throw new Error("expected delete");
      const gone = await prisma.adminHttpIdempotency.findUnique({
        where: { id: c.id },
      });
      if (gone) throw new Error("row still present");
    });

    await run("I7_reuse_only_after_delete", async () => {
      const key = keyOf(16, "i7");
      const targetId = `order-${stamp}-7`;
      const fingerprint = fp(targetId);
      const c = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key,
        fingerprint,
        operation: "refund.create",
        targetId,
      });
      if (c.kind !== "claimed") throw new Error("claim failed");
      await svc.complete({ id: c.id, httpStatus: 201, body: { ok: true } });
      await prisma.adminHttpIdempotency.update({
        where: { id: c.id },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      // Before cleanup: still replayable, not reclaimable as IN_PROGRESS
      const before = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key,
        fingerprint,
        operation: "refund.create",
        targetId,
      });
      if (before.kind !== "replay") throw new Error("expected replay before delete");
      await svc.purgeExpired();
      const after = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key,
        fingerprint,
        operation: "refund.create",
        targetId,
      });
      if (after.kind !== "claimed") throw new Error("expected new claim after delete");
      createdIds.push(after.id);
    });

    await run("I8_cleanup_in_progress_and_completed", async () => {
      const kIp = keyOf(16, "i8a");
      const kDone = keyOf(16, "i8b");
      const ip = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: kIp,
        fingerprint: fp(`order-${stamp}-8a`),
        operation: "refund.create",
        targetId: `order-${stamp}-8a`,
      });
      const done = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: kDone,
        fingerprint: fp(`order-${stamp}-8b`),
        operation: "refund.create",
        targetId: `order-${stamp}-8b`,
      });
      if (ip.kind !== "claimed" || done.kind !== "claimed") {
        throw new Error("claims failed");
      }
      await svc.complete({ id: done.id, httpStatus: 200, body: { d: 1 } });
      const past = new Date(Date.now() - 1);
      await prisma.adminHttpIdempotency.updateMany({
        where: { id: { in: [ip.id, done.id] } },
        data: { expiresAt: past },
      });
      await svc.purgeExpired();
      const left = await prisma.adminHttpIdempotency.count({
        where: { id: { in: [ip.id, done.id] } },
      });
      if (left !== 0) throw new Error(`left=${left}`);
    });

    await run("I9_response_body_16kib_boundary", async () => {
      const key = keyOf(16, "i9");
      const targetId = `order-${stamp}-9`;
      const c = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key,
        fingerprint: fp(targetId),
        operation: "refund.create",
        targetId,
      });
      if (c.kind !== "claimed") throw new Error("claim failed");
      createdIds.push(c.id);
      const overhead = Buffer.byteLength(JSON.stringify({ p: "" }), "utf8");
      const okPayload = "x".repeat(
        ADMIN_HTTP_IDEMPOTENCY_RESPONSE_MAX_BYTES - overhead,
      );
      await svc.complete({
        id: c.id,
        httpStatus: 201,
        body: { p: okPayload },
      });
      const key2 = keyOf(16, "i9b");
      const c2 = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key2,
        fingerprint: fp(`${targetId}-b`),
        operation: "refund.create",
        targetId: `${targetId}-b`,
      });
      if (c2.kind !== "claimed") throw new Error("claim2 failed");
      createdIds.push(c2.id);
      const tooBig = "y".repeat(
        ADMIN_HTTP_IDEMPOTENCY_RESPONSE_MAX_BYTES - overhead + 1,
      );
      try {
        await svc.complete({
          id: c2.id,
          httpStatus: 201,
          body: { p: tooBig },
        });
        throw new Error("expected too large");
      } catch (e) {
        if (errCode(e) !== AdminHttpIdempotencyError.RESPONSE_TOO_LARGE) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
    });

    await run("I10_key_length_8_128_boundary", async () => {
      requireAdminHttpIdempotencyKey(keyOf(ADMIN_HTTP_IDEMPOTENCY_KEY_MIN));
      requireAdminHttpIdempotencyKey(keyOf(ADMIN_HTTP_IDEMPOTENCY_KEY_MAX));
      try {
        requireAdminHttpIdempotencyKey(keyOf(ADMIN_HTTP_IDEMPOTENCY_KEY_MIN - 1));
        throw new Error("expected invalid short");
      } catch (e) {
        if (errCode(e) !== AdminHttpIdempotencyError.KEY_INVALID) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
      try {
        requireAdminHttpIdempotencyKey(keyOf(ADMIN_HTTP_IDEMPOTENCY_KEY_MAX + 1));
        throw new Error("expected invalid long");
      } catch (e) {
        if (errCode(e) !== AdminHttpIdempotencyError.KEY_INVALID) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
      try {
        requireAdminHttpIdempotencyKey(undefined);
        throw new Error("expected required");
      } catch (e) {
        if (errCode(e) !== AdminHttpIdempotencyError.KEY_REQUIRED) {
          throw e instanceof Error ? e : new Error(String(e));
        }
      }
    });

    await run("I11_unique_actor_namespace_key", async () => {
      const key = keyOf(16, "i11");
      const targetA = `order-${stamp}-11a`;
      const targetB = `order-${stamp}-11b`;
      const a = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key,
        fingerprint: fp(targetA),
        operation: "refund.create",
        targetId: targetA,
      });
      const b = await svc.claimOrReplay({
        actorId: actorB,
        keyRaw: key,
        fingerprint: fp(targetB),
        operation: "refund.create",
        targetId: targetB,
      });
      if (a.kind !== "claimed" || b.kind !== "claimed") {
        throw new Error("both actors should claim same key string");
      }
      createdIds.push(a.id, b.id);
      const count = await prisma.adminHttpIdempotency.count({
        where: { key, namespace: W3_ADMIN_REFUND_NAMESPACE },
      });
      if (count !== 2) throw new Error(`expected 2 rows, got ${count}`);
    });

    await run("I12_expires_at_created_plus_72h", async () => {
      const key = keyOf(16, "i12");
      const targetId = `order-${stamp}-12`;
      const c = await svc.claimOrReplay({
        actorId: actorA,
        keyRaw: key,
        fingerprint: fp(targetId),
        operation: "refund.create",
        targetId,
      });
      if (c.kind !== "claimed") throw new Error("claim failed");
      createdIds.push(c.id);
      const row = await prisma.adminHttpIdempotency.findUniqueOrThrow({
        where: { id: c.id },
      });
      const delta = row.expiresAt.getTime() - row.createdAt.getTime();
      if (delta !== ADMIN_HTTP_IDEMPOTENCY_TTL_MS) {
        throw new Error(`delta=${delta} expected ${ADMIN_HTTP_IDEMPOTENCY_TTL_MS}`);
      }
    });
  } finally {
    if (createdIds.length) {
      await prisma.adminHttpIdempotency.deleteMany({
        where: { id: { in: createdIds } },
      });
    }
    await prisma.adminHttpIdempotency.deleteMany({
      where: {
        actorId: { in: [actorA, actorB] },
        namespace: W3_ADMIN_REFUND_NAMESPACE,
      },
    });
    await prisma.$disconnect();
  }

  printSummary(results);
  const failed = results.filter((r) => r.status === "FAIL");
  if (failed.length || results.length !== IDS.length) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
