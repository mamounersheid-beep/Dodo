/**
 * 10.10 Slice C — Auth Email Retry + DLQ (test-only).
 *
 * Requires: REDIS_URL + DATABASE_URL
 * Run (after build): node dist/email.auth-retry-dlq.selftest.js
 *
 * Execution choices under test (not paper requirements):
 *   attempts=3, fixed backoff=50ms, DLQ queue=email-dlq
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
import {
  AUTH_EMAIL_DLQ_NAME,
  AUTH_EMAIL_JOB_ATTEMPTS,
  AUTH_EMAIL_JOB_OPTIONS,
  authEmailDlqJobId,
} from "./integrations/email/auth-email.queue-config";
import type { AuthEmailSender } from "./integrations/email/auth-email-sender.port";
import type { AuthEmailDlqPayload } from "./integrations/email/auth-email.worker";
import {
  AUTH_EMAIL_QUEUE_NAME,
  type EnqueueAuthEmailInput,
} from "./integrations/email/email-integration.port";
import { QueuedEmailAdapter } from "./integrations/email/queued-email.adapter";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

class ControllableSender implements AuthEmailSender {
  readonly sends: EnqueueAuthEmailInput[] = [];
  /** Fail this many times before succeeding (0 = always succeed). */
  failuresBeforeSuccess = 0;
  /** If true, always fail. */
  alwaysFail = false;
  callCount = 0;

  async sendAuthEmail(payload: EnqueueAuthEmailInput): Promise<void> {
    this.callCount += 1;
    if (this.alwaysFail || this.failuresBeforeSuccess > 0) {
      if (this.failuresBeforeSuccess > 0) this.failuresBeforeSuccess -= 1;
      throw new Error("forced transient send failure");
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

async function waitUntil(
  label: string,
  fn: () => boolean | Promise<boolean>,
  ms = 20_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error(`${label}: timeout after ${ms}ms`);
}

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const scenarioIds = [
    "R1 success no extra retry",
    "R2 transient failure retries",
    "R3 no delivered mark before success",
    "R4 retry success single send+mark",
    "R5 exhaustion → DLQ/failed",
    "R6 replay after success no second send",
    "R7 Token/User/Sessions unchanged",
  ];

  console.log("10.10 Slice C — Auth Email Retry + DLQ\n");
  console.log(
    `execution choice: attempts=${AUTH_EMAIL_JOB_ATTEMPTS} backoff=${AUTH_EMAIL_JOB_OPTIONS.backoff.delay}ms dlq=${AUTH_EMAIL_DLQ_NAME}\n`,
  );

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
  let dlqConn: IORedis | undefined;
  let queue: Queue<EnqueueAuthEmailInput, void, string> | undefined;
  let dlq: Queue<AuthEmailDlqPayload, void, string> | undefined;
  let worker: Worker<EnqueueAuthEmailInput, void, string> | undefined;
  let adapter: QueuedEmailAdapter | undefined;
  let prisma: PrismaService | undefined;
  const sender = new ControllableSender();
  const jobIds: string[] = [];

  const mkPayload = (
    template: EnqueueAuthEmailInput["template"],
    suffix: string,
  ): EnqueueAuthEmailInput => {
    const tokenId = `sliceC-${template}-${suffix}-${stamp}`;
    const idempotencyKey = `auth:${template}:${tokenId}`;
    jobIds.push(idempotencyKey);
    return {
      idempotencyKey,
      to: `sliceC-${suffix}-${stamp}@auth.invalid`,
      template,
      tokenId,
      rawToken: `raw-C-${suffix}-${stamp}`,
      communicationLocale: "de",
    };
  };

  try {
    queueConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    workerConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    storeConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    dlqConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const delivery = new RedisAuthEmailDeliveryStore(storeConn);

    queue = new Queue(AUTH_EMAIL_QUEUE_NAME, {
      connection: queueConn,
      defaultJobOptions: { ...AUTH_EMAIL_JOB_OPTIONS },
    });
    dlq = new Queue(AUTH_EMAIL_DLQ_NAME, { connection: dlqConn });
    await queue.waitUntilReady();
    await dlq.waitUntilReady();

    worker = new Worker<EnqueueAuthEmailInput, void, string>(
      AUTH_EMAIL_QUEUE_NAME,
      async (job) => {
        await processAuthEmailJob(job.data, { sender, delivery });
      },
      { connection: workerConn, concurrency: 1 },
    );

    worker.on("failed", (job, err) => {
      void (async () => {
        if (!job) return;
        const max = job.opts.attempts ?? AUTH_EMAIL_JOB_ATTEMPTS;
        if (job.attemptsMade < max) return;
        const dlqId = authEmailDlqJobId(job.data.template, job.data.tokenId);
        const existing = await dlq!.getJob(dlqId);
        if (existing) return;
        await dlq!.add(
          "dead",
          {
            ...job.data,
            failedAt: new Date().toISOString(),
            attemptsMade: job.attemptsMade,
            failedReason: err.message,
            sourceJobId: String(job.id),
          },
          { jobId: dlqId },
        );
      })();
    });

    await worker.waitUntilReady();
    adapter = new QueuedEmailAdapter();

    const clean = async (key: string, template?: string, tokenId?: string) => {
      await delivery.clearDelivered(key);
      const j = await queue!.getJob(key);
      if (j) await j.remove().catch(() => undefined);
      if (template && tokenId) {
        const d = await dlq!.getJob(authEmailDlqJobId(template, tokenId));
        if (d) await d.remove().catch(() => undefined);
      }
    };

    // --- R1 ---
    await run("R1 success no extra retry", async () => {
      sender.alwaysFail = false;
      sender.failuresBeforeSuccess = 0;
      sender.callCount = 0;
      sender.sends.length = 0;
      const p = mkPayload("email_verify", "r1");
      await clean(p.idempotencyKey, p.template, p.tokenId);
      await adapter!.enqueueAuthEmail(p);
      await waitUntil("R1 completed", async () => {
        const j = await queue!.getJob(p.idempotencyKey);
        return !!j && (await j.getState()) === "completed";
      });
      if (sender.callCount !== 1) throw new Error(`expected 1 call, got ${sender.callCount}`);
      if (sender.sends.length !== 1) throw new Error("expected 1 send");
      const j = await queue!.getJob(p.idempotencyKey);
      if ((j?.attemptsMade ?? 0) > 1) {
        throw new Error(`unexpected retries attemptsMade=${j?.attemptsMade}`);
      }
    });

    // --- R2 + R3 + R4 (linked) ---
    let retryPayload: EnqueueAuthEmailInput | undefined;
    await run("R2 transient failure retries", async () => {
      sender.sends.length = 0;
      sender.callCount = 0;
      sender.alwaysFail = false;
      sender.failuresBeforeSuccess = 2; // fail, fail, then succeed on 3rd
      retryPayload = mkPayload("password_reset", "r2");
      await clean(retryPayload.idempotencyKey, retryPayload.template, retryPayload.tokenId);

      await adapter!.enqueueAuthEmail(retryPayload);

      await waitUntil("R2 completed after retries", async () => {
        const j = await queue!.getJob(retryPayload!.idempotencyKey);
        return !!j && (await j.getState()) === "completed";
      });

      if (sender.callCount !== 3) {
        throw new Error(`expected 3 attempts (2 fail + 1 ok), got ${sender.callCount}`);
      }
    });

    await run("R3 no delivered mark before success", async () => {
      if (!retryPayload) throw new Error("R2 payload missing");
      if (!(await delivery.wasDelivered(retryPayload.idempotencyKey))) {
        throw new Error("expected delivered mark after eventual success");
      }
      // Fresh failure must not write mark (proves mark-only-after-success)
      const probe = mkPayload("email_change", "r3probe");
      await delivery.clearDelivered(probe.idempotencyKey);
      const failSender = new ControllableSender();
      failSender.alwaysFail = true;
      try {
        await processAuthEmailJob(probe, { sender: failSender, delivery });
      } catch {
        /* expected */
      }
      if (await delivery.wasDelivered(probe.idempotencyKey)) {
        throw new Error("mark written despite send failure");
      }
      if (failSender.sends.length !== 0) throw new Error("failed send recorded as success");
    });

    await run("R4 retry success single send+mark", async () => {
      if (!retryPayload) throw new Error("R2 payload missing");
      if (sender.sends.length !== 1) {
        throw new Error(`expected exactly 1 successful send, got ${sender.sends.length}`);
      }
      if (sender.sends[0]!.idempotencyKey !== retryPayload.idempotencyKey) {
        throw new Error("send key mismatch");
      }
      if (!(await delivery.wasDelivered(retryPayload.idempotencyKey))) {
        throw new Error("missing delivered mark");
      }
    });

    // --- R5 ---
    let exhaustPayload: EnqueueAuthEmailInput | undefined;
    await run("R5 exhaustion → DLQ/failed", async () => {
      sender.sends.length = 0;
      sender.callCount = 0;
      sender.alwaysFail = true;
      sender.failuresBeforeSuccess = 0;
      exhaustPayload = mkPayload("email_change", "r5");
      await clean(exhaustPayload.idempotencyKey, exhaustPayload.template, exhaustPayload.tokenId);
      await adapter!.enqueueAuthEmail(exhaustPayload);

      await waitUntil("R5 failed state", async () => {
        const j = await queue!.getJob(exhaustPayload!.idempotencyKey);
        return !!j && (await j.getState()) === "failed";
      });
      await waitUntil("R5 DLQ present", async () => {
        const d = await dlq!.getJob(
          authEmailDlqJobId(exhaustPayload!.template, exhaustPayload!.tokenId),
        );
        return d != null;
      });

      const j = await queue!.getJob(exhaustPayload.idempotencyKey);
      if ((j?.attemptsMade ?? 0) < AUTH_EMAIL_JOB_ATTEMPTS) {
        throw new Error(`attemptsMade=${j?.attemptsMade} expected ${AUTH_EMAIL_JOB_ATTEMPTS}`);
      }
      if (await delivery.wasDelivered(exhaustPayload.idempotencyKey)) {
        throw new Error("delivered mark must not exist after exhaustion");
      }
      if (sender.sends.length !== 0) throw new Error("unexpected successful send on exhaustion");

      const dead = await dlq!.getJob(
        authEmailDlqJobId(exhaustPayload.template, exhaustPayload.tokenId),
      );
      const data = dead!.data;
      if (data.idempotencyKey !== exhaustPayload.idempotencyKey) {
        throw new Error("DLQ payload key mismatch");
      }
      if (data.attemptsMade < AUTH_EMAIL_JOB_ATTEMPTS) {
        throw new Error("DLQ attemptsMade too low");
      }
      if (!data.failedReason) throw new Error("DLQ missing failedReason");
    });

    // --- R6 ---
    await run("R6 replay after success no second send", async () => {
      if (!retryPayload) throw new Error("missing retry payload");
      const before = sender.sends.length;
      // Ensure we're measuring against the successful R2 key; reset alwaysFail
      sender.alwaysFail = false;
      const r = await processAuthEmailJob(retryPayload, { sender, delivery });
      if (r !== "skipped") throw new Error(`expected skipped, got ${r}`);
      if (sender.sends.length !== before) throw new Error("replay caused extra send");
    });

    // --- R7 ---
    await run("R7 Token/User/Sessions unchanged", async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      const tokens = new VerificationTokenService(prisma);
      const email = `sliceC-r7-${stamp}@auth.invalid`;
      const user = await prisma.user.create({
        data: { email, passwordHash: "not-used", locale: "en" },
      });
      const role = await prisma.role.findUniqueOrThrow({ where: { code: "CUSTOMER" } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

      const issued = await tokens.issue({
        userId: user.id,
        email,
        type: VERIFICATION_TOKEN_TYPES.EMAIL_VERIFY,
      });
      const p: EnqueueAuthEmailInput = {
        idempotencyKey: `auth:email_verify:${issued.id}`,
        to: email,
        template: "email_verify",
        tokenId: issued.id,
        rawToken: issued.raw,
        communicationLocale: "en",
      };
      jobIds.push(p.idempotencyKey);
      await clean(p.idempotencyKey, p.template, p.tokenId);

      sender.alwaysFail = true;
      sender.sends.length = 0;
      sender.callCount = 0;
      await adapter!.enqueueAuthEmail(p);
      await waitUntil("R7 failed", async () => {
        const j = await queue!.getJob(p.idempotencyKey);
        return !!j && (await j.getState()) === "failed";
      });

      const tok = await prisma.verificationToken.findUniqueOrThrow({ where: { id: issued.id } });
      if (tok.usedAt) throw new Error("token usedAt set after exhaustion");
      const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      if (userAfter.email !== email) throw new Error("User.email changed");
      if (userAfter.emailVerifiedAt) throw new Error("emailVerifiedAt set");
      if (userAfter.locale !== "en") throw new Error("locale changed");
      const sessions = await prisma.session.count({ where: { userId: user.id } });
      if (sessions !== 0) throw new Error("sessions mutated");
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
    for (const id of jobIds) {
      const j = await queue?.getJob(id).catch(() => undefined);
      if (j) await j.remove().catch(() => undefined);
      const parts = id.split(":");
      if (parts.length === 3 && parts[0] === "auth") {
        const d = await dlq?.getJob(authEmailDlqJobId(parts[1]!, parts[2]!)).catch(() => undefined);
        if (d) await d.remove().catch(() => undefined);
      }
      await storeConn?.del(`auth-email:delivered:${id}`).catch(() => undefined);
    }
    await worker?.close().catch(() => undefined);
    await adapter?.onModuleDestroy().catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await dlq?.close().catch(() => undefined);
    queueConn?.disconnect();
    workerConn?.disconnect();
    storeConn?.disconnect();
    dlqConn?.disconnect();
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
