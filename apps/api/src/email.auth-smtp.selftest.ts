/**
 * 10.10 Slice D — SMTP Adapter for Auth Transactional Email (test-only).
 *
 * Uses injectable SmtpTransport stub (no live credentials required).
 * Live SMTP = set SMTP_HOST (+ related env) — operational follow-up.
 *
 * Requires: REDIS_URL + DATABASE_URL
 * Run (after build): node dist/email.auth-smtp.selftest.js
 */
import "reflect-metadata";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { env, isSmtpLiveConfigured } from "./config/env";
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
import {
  AUTH_EMAIL_QUEUE_NAME,
  type EnqueueAuthEmailInput,
} from "./integrations/email/email-integration.port";
import { QueuedEmailAdapter } from "./integrations/email/queued-email.adapter";
import { SmtpAuthEmailSender } from "./integrations/email/smtp-auth-email.sender";
import type { SmtpMailMessage, SmtpTransport } from "./integrations/email/smtp-transport.port";
import type { AuthEmailDlqPayload } from "./integrations/email/auth-email.worker";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

class RecordingSmtpTransport implements SmtpTransport {
  readonly messages: SmtpMailMessage[] = [];
  failuresBeforeSuccess = 0;
  alwaysFail = false;
  callCount = 0;

  async sendMail(message: SmtpMailMessage): Promise<void> {
    this.callCount += 1;
    if (this.alwaysFail || this.failuresBeforeSuccess > 0) {
      if (this.failuresBeforeSuccess > 0) this.failuresBeforeSuccess -= 1;
      throw new Error("forced SMTP failure");
    }
    this.messages.push({ ...message, meta: { ...message.meta } });
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
    "M1 worker → SMTP adapter",
    "M2 three templates reach SMTP",
    "M3 communicationLocale forwarded",
    "M4 success writes delivered mark once",
    "M5 replay no second SMTP send",
    "M6 SMTP failure no mark",
    "M7 SMTP failure preserves Token/User/Sessions",
    "M8 retry/DLQ still works with SMTP adapter",
  ];

  console.log("10.10 Slice D — SMTP Adapter for Auth Transactional Email\n");
  console.log(
    `live_smtp_configured=${isSmtpLiveConfigured()} (test uses RecordingSmtpTransport; live activation = operational follow-up)\n`,
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
  const transport = new RecordingSmtpTransport();
  const smtpSender = new SmtpAuthEmailSender(transport);
  const jobKeys: string[] = [];

  const mk = (
    template: EnqueueAuthEmailInput["template"],
    locale: EnqueueAuthEmailInput["communicationLocale"],
    tag: string,
  ): EnqueueAuthEmailInput => {
    const tokenId = `sliceD-${template}-${tag}-${stamp}`;
    const idempotencyKey = `auth:${template}:${tokenId}`;
    jobKeys.push(idempotencyKey);
    return {
      idempotencyKey,
      to: `sliceD-${tag}-${stamp}@auth.invalid`,
      template,
      tokenId,
      rawToken: `raw-D-${tag}-${stamp}`,
      communicationLocale: locale,
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
        await processAuthEmailJob(job.data, { sender: smtpSender, delivery });
      },
      { connection: workerConn, concurrency: 1 },
    );
    worker.on("failed", (job, err) => {
      void (async () => {
        if (!job) return;
        const max = job.opts.attempts ?? AUTH_EMAIL_JOB_ATTEMPTS;
        if (job.attemptsMade < max) return;
        const dlqId = authEmailDlqJobId(job.data.template, job.data.tokenId);
        if (await dlq!.getJob(dlqId)) return;
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

    const clean = async (p: EnqueueAuthEmailInput) => {
      await delivery.clearDelivered(p.idempotencyKey);
      const j = await queue!.getJob(p.idempotencyKey);
      if (j) await j.remove().catch(() => undefined);
      const d = await dlq!.getJob(authEmailDlqJobId(p.template, p.tokenId));
      if (d) await d.remove().catch(() => undefined);
    };

    const payloads = [
      mk("email_verify", "de", "t1"),
      mk("password_reset", "en", "t2"),
      mk("email_change", "ar", "t3"),
    ];

    await run("M1 worker → SMTP adapter", async () => {
      transport.messages.length = 0;
      transport.callCount = 0;
      transport.alwaysFail = false;
      transport.failuresBeforeSuccess = 0;
      for (const p of payloads) await clean(p);
      for (const p of payloads) await adapter!.enqueueAuthEmail(p);
      await waitUntil("M1 all completed", async () => {
        for (const p of payloads) {
          const j = await queue!.getJob(p.idempotencyKey);
          if (!j || (await j.getState()) !== "completed") return false;
        }
        return true;
      });
      if (transport.messages.length < 1) throw new Error("SMTP transport received nothing");
    });

    await run("M2 three templates reach SMTP", async () => {
      const templates = new Set(transport.messages.map((m) => m.meta.template));
      for (const t of ["email_verify", "password_reset", "email_change"] as const) {
        if (!templates.has(t)) throw new Error(`missing SMTP message for ${t}`);
      }
      if (transport.messages.length !== 3) {
        throw new Error(`expected 3 SMTP messages, got ${transport.messages.length}`);
      }
    });

    await run("M3 communicationLocale forwarded", async () => {
      for (const p of payloads) {
        const msg = transport.messages.find((m) => m.meta.idempotencyKey === p.idempotencyKey);
        if (!msg) throw new Error(`missing message for ${p.idempotencyKey}`);
        if (msg.meta.communicationLocale !== p.communicationLocale) {
          throw new Error(
            `locale=${msg.meta.communicationLocale} expected ${p.communicationLocale}`,
          );
        }
        if (!msg.text.includes(`communicationLocale=${p.communicationLocale}`)) {
          throw new Error("communicationLocale missing from mail body");
        }
      }
    });

    await run("M4 success writes delivered mark once", async () => {
      for (const p of payloads) {
        if (!(await delivery.wasDelivered(p.idempotencyKey))) {
          throw new Error(`missing delivered mark for ${p.idempotencyKey}`);
        }
      }
    });

    await run("M5 replay no second SMTP send", async () => {
      const before = transport.messages.length;
      for (const p of payloads) {
        const r = await processAuthEmailJob(p, { sender: smtpSender, delivery });
        if (r !== "skipped") throw new Error(`expected skipped, got ${r}`);
      }
      if (transport.messages.length !== before) {
        throw new Error("replay caused extra SMTP send");
      }
    });

    await run("M6 SMTP failure no mark", async () => {
      const p = mk("email_verify", "de", "fail");
      await clean(p);
      const failTransport = new RecordingSmtpTransport();
      failTransport.alwaysFail = true;
      const failSender = new SmtpAuthEmailSender(failTransport);
      let threw = false;
      try {
        await processAuthEmailJob(p, { sender: failSender, delivery });
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("expected SMTP failure to throw");
      if (await delivery.wasDelivered(p.idempotencyKey)) {
        throw new Error("delivered mark written after SMTP failure");
      }
      if (failTransport.messages.length !== 0) throw new Error("failed send was recorded");
    });

    await run("M7 SMTP failure preserves Token/User/Sessions", async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      const tokens = new VerificationTokenService(prisma);
      const email = `sliceD-m7-${stamp}@auth.invalid`;
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
      const p: EnqueueAuthEmailInput = {
        idempotencyKey: `auth:password_reset:${issued.id}`,
        to: email,
        template: "password_reset",
        tokenId: issued.id,
        rawToken: issued.raw,
        communicationLocale: "de",
      };
      jobKeys.push(p.idempotencyKey);
      await clean(p);

      const failTransport = new RecordingSmtpTransport();
      failTransport.alwaysFail = true;
      const failSender = new SmtpAuthEmailSender(failTransport);
      try {
        await processAuthEmailJob(p, { sender: failSender, delivery });
      } catch {
        /* expected */
      }

      const tok = await prisma.verificationToken.findUniqueOrThrow({ where: { id: issued.id } });
      if (tok.usedAt) throw new Error("token usedAt set");
      const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      if (u.email !== email || u.emailVerifiedAt) throw new Error("User mutated");
      if ((await prisma.session.count({ where: { userId: user.id } })) !== 0) {
        throw new Error("sessions mutated");
      }
    });

    await run("M8 retry/DLQ still works with SMTP adapter", async () => {
      transport.messages.length = 0;
      transport.callCount = 0;
      transport.alwaysFail = false;
      transport.failuresBeforeSuccess = 2;
      const p = mk("email_change", "en", "retry");
      await clean(p);
      await adapter!.enqueueAuthEmail(p);
      await waitUntil("M8 completed", async () => {
        const j = await queue!.getJob(p.idempotencyKey);
        return !!j && (await j.getState()) === "completed";
      });
      if (transport.callCount !== 3) {
        throw new Error(`expected 3 SMTP attempts, got ${transport.callCount}`);
      }
      if (transport.messages.length !== 1) {
        throw new Error(`expected 1 successful SMTP send, got ${transport.messages.length}`);
      }
      if (!(await delivery.wasDelivered(p.idempotencyKey))) {
        throw new Error("missing delivered mark after retry success");
      }

      // Exhaustion → DLQ
      transport.callCount = 0;
      transport.messages.length = 0;
      transport.alwaysFail = true;
      const ex = mk("email_verify", "de", "dlq");
      await clean(ex);
      await adapter!.enqueueAuthEmail(ex);
      await waitUntil("M8 failed", async () => {
        const j = await queue!.getJob(ex.idempotencyKey);
        return !!j && (await j.getState()) === "failed";
      });
      await waitUntil("M8 DLQ", async () => {
        return (await dlq!.getJob(authEmailDlqJobId(ex.template, ex.tokenId))) != null;
      });
      if (await delivery.wasDelivered(ex.idempotencyKey)) {
        throw new Error("mark must not exist after DLQ exhaustion");
      }
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
    for (const id of jobKeys) {
      const j = await queue?.getJob(id).catch(() => undefined);
      if (j) await j.remove().catch(() => undefined);
      const parts = id.split(":");
      if (parts.length === 3 && parts[0] === "auth") {
        const d = await dlq
          ?.getJob(authEmailDlqJobId(parts[1]!, parts[2]!))
          .catch(() => undefined);
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
  process.exit(results.some((r) => r.status !== "PASS") ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
