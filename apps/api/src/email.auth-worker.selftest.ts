/**
 * 10.10 Slice B — Auth Email Worker + Idempotent Processing (test-only).
 *
 * Requires: REDIS_URL + DATABASE_URL (env bootstrap / token integrity)
 * Run (after build): node dist/email.auth-worker.selftest.js
 */
import "reflect-metadata";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { env } from "./config/env";
import {
  VERIFICATION_TOKEN_TYPES,
  VerificationTokenService,
} from "./auth/verification-token.service";
import { PrismaService } from "./prisma/prisma.service";
import { RedisAuthEmailDeliveryStore } from "./integrations/email/auth-email-delivery.store";
import { processAuthEmailJob } from "./integrations/email/auth-email.processor";
import type { AuthEmailSender } from "./integrations/email/auth-email-sender.port";
import {
  AUTH_EMAIL_QUEUE_NAME,
  type EnqueueAuthEmailInput,
} from "./integrations/email/email-integration.port";
import { QueuedEmailAdapter } from "./integrations/email/queued-email.adapter";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

class RecordingAuthEmailSender implements AuthEmailSender {
  readonly sends: EnqueueAuthEmailInput[] = [];
  failNext = false;

  async sendAuthEmail(payload: EnqueueAuthEmailInput): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("forced send failure");
    }
    this.sends.push({ ...payload });
  }
}

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(label: string, fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`${label}: timeout after ${ms}ms`);
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const scenarioIds = [
    "W1 worker processes three templates",
    "W2 each job sends once",
    "W3 replay no second send",
    "W4 communicationLocale forwarded",
    "W5 send failure preserves token",
    "W6 send failure preserves User/Sessions",
  ];

  console.log("10.10 Slice B — Auth Email Worker + Idempotent Processing\n");

  const run = async (id: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ id, status: "PASS" });
      console.log(`  ✓ ${id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id, status: "FAIL", note: msg });
      console.error(`  ✗ ${id}: ${msg}`);
    }
  };

  let queueConn: IORedis | undefined;
  let workerConn: IORedis | undefined;
  let storeConn: IORedis | undefined;
  let queue: Queue<EnqueueAuthEmailInput, void, string> | undefined;
  let worker: Worker<EnqueueAuthEmailInput, void, string> | undefined;
  let adapter: QueuedEmailAdapter | undefined;
  let prisma: PrismaService | undefined;
  let failUserId = "";
  let failEmail = "";
  const sender = new RecordingAuthEmailSender();

  const templates = ["email_verify", "password_reset", "email_change"] as const;
  const locales = ["de", "en", "ar"] as const;
  const payloads: EnqueueAuthEmailInput[] = templates.map((template, i) => {
    const tokenId = `sliceB-${template}-${stamp}`;
    return {
      idempotencyKey: `auth:${template}:${tokenId}`,
      to: `sliceB-${template}-${stamp}@auth.invalid`,
      template,
      tokenId,
      rawToken: `raw-B-${template}-${stamp}`,
      communicationLocale: locales[i]!,
    };
  });

  try {
    queueConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    workerConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    storeConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const delivery = new RedisAuthEmailDeliveryStore(storeConn);

    queue = new Queue(AUTH_EMAIL_QUEUE_NAME, { connection: queueConn });
    await queue.waitUntilReady();

    // Clean prior marks/jobs for these keys
    for (const p of payloads) {
      await delivery.clearDelivered(p.idempotencyKey);
      const existing = await queue.getJob(p.idempotencyKey);
      if (existing) await existing.remove().catch(() => undefined);
    }

    worker = new Worker<EnqueueAuthEmailInput, void, string>(
      AUTH_EMAIL_QUEUE_NAME,
      async (job) => {
        await processAuthEmailJob(job.data, { sender, delivery });
      },
      { connection: workerConn, concurrency: 2 },
    );
    await worker.waitUntilReady();

    adapter = new QueuedEmailAdapter();

    await run("W1 worker processes three templates", async () => {
      for (const p of payloads) {
        await adapter!.enqueueAuthEmail(p);
      }
      await waitUntil("W1 sends", () => sender.sends.length >= 3);
      const got = new Set(sender.sends.map((s) => s.template));
      for (const t of templates) {
        if (!got.has(t)) throw new Error(`missing template ${t}`);
      }
      for (const p of payloads) {
        const job = await queue!.getJob(p.idempotencyKey);
        if (!job) throw new Error(`missing job ${p.idempotencyKey}`);
        await waitUntil(`W1 completed ${p.idempotencyKey}`, async () => {
          const state = await job.getState();
          return state === "completed";
        });
      }
    });

    await run("W2 each job sends once", async () => {
      if (sender.sends.length !== 3) {
        throw new Error(`expected 3 sends, got ${sender.sends.length}`);
      }
      const keys = sender.sends.map((s) => s.idempotencyKey);
      if (new Set(keys).size !== 3) throw new Error("duplicate sends by key");
    });

    await run("W3 replay no second send", async () => {
      const before = sender.sends.length;
      // Processor-level replay (at-least-once)
      for (const p of payloads) {
        const r = await processAuthEmailJob(p, { sender, delivery });
        if (r !== "skipped") throw new Error(`expected skipped, got ${r}`);
      }
      // Queue-level replay: remove completed job + re-enqueue same business key
      for (const p of payloads) {
        const job = await queue!.getJob(p.idempotencyKey);
        if (job) await job.remove();
        await adapter!.enqueueAuthEmail(p);
      }
      await waitUntil("W3 reprocess", async () => {
        for (const p of payloads) {
          const job = await queue!.getJob(p.idempotencyKey);
          if (!job) return false;
          if ((await job.getState()) !== "completed") return false;
        }
        return true;
      });
      if (sender.sends.length !== before) {
        throw new Error(`replay caused extra sends (${before} → ${sender.sends.length})`);
      }
    });

    await run("W4 communicationLocale forwarded", async () => {
      for (const p of payloads) {
        const hit = sender.sends.find((s) => s.idempotencyKey === p.idempotencyKey);
        if (!hit) throw new Error(`no send for ${p.idempotencyKey}`);
        if (hit.communicationLocale !== p.communicationLocale) {
          throw new Error(
            `locale=${hit.communicationLocale} expected ${p.communicationLocale}`,
          );
        }
        if ("locale" in hit && (hit as { locale?: unknown }).locale !== undefined) {
          throw new Error("legacy locale field present on send payload");
        }
      }
    });

    await run("W5 send failure preserves token", async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      const tokens = new VerificationTokenService(prisma);
      const email = `sliceB-fail-${stamp}@auth.invalid`;
      const user = await prisma.user.create({
        data: { email, passwordHash: "not-used", locale: "de" },
      });
      const role = await prisma.role.findUniqueOrThrow({ where: { code: "CUSTOMER" } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

      const issued = await tokens.issue({
        userId: user.id,
        email,
        type: VERIFICATION_TOKEN_TYPES.PASSWORD_RESET,
      });
      const failPayload: EnqueueAuthEmailInput = {
        idempotencyKey: `auth:password_reset:${issued.id}`,
        to: email,
        template: "password_reset",
        tokenId: issued.id,
        rawToken: issued.raw,
        communicationLocale: "de",
      };
      await delivery.clearDelivered(failPayload.idempotencyKey);

      const failSender = new RecordingAuthEmailSender();
      failSender.failNext = true;
      let threw = false;
      try {
        await processAuthEmailJob(failPayload, { sender: failSender, delivery });
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("expected send failure to throw");
      if (failSender.sends.length !== 0) throw new Error("failed send was recorded");

      const tok = await prisma.verificationToken.findUniqueOrThrow({ where: { id: issued.id } });
      if (tok.usedAt) throw new Error("VerificationToken.usedAt set after send failure");

      failUserId = user.id;
      failEmail = email;
    });

    await run("W6 send failure preserves User/Sessions", async () => {
      if (!prisma) throw new Error("prisma not ready");
      if (!failUserId || !failEmail) throw new Error("W5 setup missing");

      const user = await prisma.user.findUniqueOrThrow({ where: { id: failUserId } });
      if (user.email !== failEmail) throw new Error("User.email changed");
      if (user.emailVerifiedAt) throw new Error("emailVerifiedAt changed");
      if (user.locale !== "de") throw new Error("User.locale changed");

      const sessions = await prisma.session.count({ where: { userId: failUserId } });
      if (sessions !== 0) throw new Error("unexpected sessions created/changed");
      const revoked = await prisma.session.count({
        where: { userId: failUserId, revokedAt: { not: null } },
      });
      if (revoked !== 0) throw new Error("sessions revoked");
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of scenarioIds) {
      if (!results.some((r) => r.id === id)) {
        results.push({ id, status: "BLOCKED", note: msg });
        console.error(`  ⊘ ${id}: BLOCKED`);
      }
    }
  } finally {
    for (const p of payloads) {
      const job = await queue?.getJob(p.idempotencyKey).catch(() => undefined);
      if (job) await job.remove().catch(() => undefined);
      await storeConn
        ?.del(`auth-email:delivered:${p.idempotencyKey}`)
        .catch(() => undefined);
    }
    await worker?.close().catch(() => undefined);
    await adapter?.onModuleDestroy().catch(() => undefined);
    await queue?.close().catch(() => undefined);
    queueConn?.disconnect();
    workerConn?.disconnect();
    storeConn?.disconnect();
    await prisma?.$disconnect().catch(() => undefined);
  }

  printSummary(results);
  const failed = results.some((r) => r.status !== "PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
