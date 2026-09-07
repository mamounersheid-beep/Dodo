/**
 * 10.10 Slice A — Auth Transactional Email Queue Foundation (test-only).
 *
 * Requires: REDIS_URL (+ DATABASE_URL for env bootstrap / token failure case)
 * Run (after build): node dist/email.auth-queue.selftest.js
 */
import "reflect-metadata";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "./config/env";
import { AuthEmailService } from "./auth/auth-email.service";
import {
  VERIFICATION_TOKEN_TYPES,
  VerificationTokenService,
} from "./auth/verification-token.service";
import { PrismaService } from "./prisma/prisma.service";
import {
  AUTH_EMAIL_QUEUE_NAME,
  type EnqueueAuthEmailInput,
} from "./integrations/email/email-integration.port";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";
import { QueuedEmailAdapter } from "./integrations/email/queued-email.adapter";

type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED"; note?: string };

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

const LOCALES = new Set(["de", "en", "ar"]);

async function main() {
  const stamp = Date.now();
  const results: Result[] = [];
  const scenarioIds = [
    "Q1 enqueue three templates",
    "Q2 idempotency key shape",
    "Q3 communicationLocale",
    "Q4 duplicate jobId no-op",
    "Q5 enqueue failure preserves token",
  ];

  console.log("10.10 Slice A — Auth Email Queue Foundation\n");

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

  let adapter: QueuedEmailAdapter | undefined;
  let inspect: Queue | undefined;
  let inspectConn: IORedis | undefined;
  let prisma: PrismaService | undefined;

  try {
    adapter = new QueuedEmailAdapter();
    inspectConn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    inspect = new Queue(AUTH_EMAIL_QUEUE_NAME, { connection: inspectConn });
    await inspect.waitUntilReady();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of scenarioIds) {
      results.push({ id, status: "BLOCKED", note: msg });
      console.error(`  ⊘ ${id}: BLOCKED`);
    }
    printSummary(results);
    process.exit(2);
  }

  const jobIds: string[] = [];
  const templates = ["email_verify", "password_reset", "email_change"] as const;
  const locales = ["de", "en", "ar"] as const;

  const baseInputs: EnqueueAuthEmailInput[] = templates.map((template, i) => {
    const tokenId = `sliceA-${template}-${stamp}`;
    const idempotencyKey = `auth:${template}:${tokenId}`;
    jobIds.push(idempotencyKey);
    return {
      idempotencyKey,
      to: `sliceA-${template}-${stamp}@auth.invalid`,
      template,
      tokenId,
      rawToken: `raw-${template}-${stamp}`,
      communicationLocale: locales[i]!,
    };
  });

  try {
    // Isolate: remove any prior jobs with these ids
    for (const id of jobIds) {
      const existing = await inspect.getJob(id);
      if (existing) await existing.remove();
    }

    await run("Q1 enqueue three templates", async () => {
      for (const input of baseInputs) {
        await adapter!.enqueueAuthEmail(input);
      }
      for (const input of baseInputs) {
        const job = await inspect!.getJob(input.idempotencyKey);
        if (!job) throw new Error(`missing job ${input.idempotencyKey}`);
        if (job.name !== input.template) {
          throw new Error(`job name=${job.name} expected ${input.template}`);
        }
        const data = job.data as EnqueueAuthEmailInput;
        if (data.template !== input.template) throw new Error("template mismatch in payload");
        if (data.tokenId !== input.tokenId) throw new Error("tokenId mismatch");
      }
    });

    await run("Q2 idempotency key shape", async () => {
      for (const input of baseInputs) {
        const job = await inspect!.getJob(input.idempotencyKey);
        if (!job) throw new Error(`missing job ${input.idempotencyKey}`);
        const data = job.data as EnqueueAuthEmailInput;
        const expected = `auth:${input.template}:${input.tokenId}`;
        if (data.idempotencyKey !== expected) {
          throw new Error(`idempotencyKey=${data.idempotencyKey} expected ${expected}`);
        }
        if (job.id !== expected) {
          throw new Error(`BullMQ jobId=${job.id} expected ${expected}`);
        }
      }
    });

    await run("Q3 communicationLocale", async () => {
      for (const input of baseInputs) {
        const job = await inspect!.getJob(input.idempotencyKey);
        if (!job) throw new Error(`missing job ${input.idempotencyKey}`);
        const data = job.data as EnqueueAuthEmailInput & { locale?: unknown };
        if (!LOCALES.has(data.communicationLocale)) {
          throw new Error(`invalid communicationLocale=${String(data.communicationLocale)}`);
        }
        if (data.communicationLocale !== input.communicationLocale) {
          throw new Error(
            `communicationLocale=${data.communicationLocale} expected ${input.communicationLocale}`,
          );
        }
        if ("locale" in data && data.locale !== undefined) {
          throw new Error("payload must not carry legacy locale field");
        }
      }
    });

    await run("Q4 duplicate jobId no-op", async () => {
      const waitingBefore = await inspect!.getJobCountByTypes("waiting", "delayed", "prioritized");
      const first = baseInputs[0]!;
      await adapter!.enqueueAuthEmail(first);
      await adapter!.enqueueAuthEmail(first);
      const waitingAfter = await inspect!.getJobCountByTypes("waiting", "delayed", "prioritized");
      const job = await inspect!.getJob(first.idempotencyKey);
      if (!job) throw new Error("job disappeared after duplicate enqueue");
      // Exactly one job for this id; waiting count must not grow by +2
      if (waitingAfter > waitingBefore + 0) {
        // first enqueue already counted in waitingBefore; duplicates must not add
        // waitingBefore already includes the three jobs from Q1 — duplicate must not increase
        throw new Error(
          `duplicate enqueue increased queue depth (${waitingBefore} → ${waitingAfter})`,
        );
      }
    });

    await run("Q5 enqueue failure preserves token", async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      const tokens = new VerificationTokenService(prisma);
      const email = `sliceA-fail-${stamp}@auth.invalid`;

      const user = await prisma.user.create({
        data: {
          email,
          passwordHash: "not-used-for-this-test",
          locale: "de",
        },
      });
      const role = await prisma.role.findUniqueOrThrow({ where: { code: "CUSTOMER" } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

      const issued = await tokens.issue({
        userId: user.id,
        email,
        type: VERIFICATION_TOKEN_TYPES.EMAIL_VERIFY,
      });

      const before = await prisma.verificationToken.findUniqueOrThrow({
        where: { id: issued.id },
      });
      if (before.usedAt) throw new Error("setup: token already used");
      const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      const sessionCountBefore = await prisma.session.count({ where: { userId: user.id } });

      const failingPort = createEmailIntegrationStub({
        enqueueAuthEmail: async () => {
          throw new Error("forced enqueue failure");
        },
      });
      const svc = new AuthEmailService(failingPort);
      await svc.sendForToken(issued, "de");

      const after = await prisma.verificationToken.findUniqueOrThrow({
        where: { id: issued.id },
      });
      if (after.usedAt) throw new Error("token was invalidated on enqueue failure");

      const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      if (userAfter.email !== userBefore.email) throw new Error("User.email changed on enqueue failure");
      if (userAfter.emailVerifiedAt !== userBefore.emailVerifiedAt) {
        throw new Error("emailVerifiedAt changed on enqueue failure");
      }
      if (userAfter.locale !== userBefore.locale) throw new Error("User.locale changed");

      const sessionCountAfter = await prisma.session.count({ where: { userId: user.id } });
      if (sessionCountAfter !== sessionCountBefore) {
        throw new Error("Session rows changed on enqueue failure");
      }
      const revoked = await prisma.session.count({
        where: { userId: user.id, revokedAt: { not: null } },
      });
      if (revoked !== 0) throw new Error("sessions revoked on enqueue failure");
    });
  } finally {
    for (const id of jobIds) {
      const job = await inspect.getJob(id).catch(() => undefined);
      if (job) await job.remove().catch(() => undefined);
    }
    await adapter.onModuleDestroy().catch(() => undefined);
    if (inspect) await inspect.close().catch(() => undefined);
    if (inspectConn) inspectConn.disconnect();
    if (prisma) await prisma.$disconnect().catch(() => undefined);
  }

  printSummary(results);
  const failed = results.some((r) => r.status !== "PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
