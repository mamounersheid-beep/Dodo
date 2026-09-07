import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type {
  FirstAttemptClientPayload,
  FirstAttemptCreateInput,
  FirstAttemptProviderAdapter,
  FirstAttemptProviderName,
  FirstAttemptProviderObject,
  ProviderCancelOutcome,
  ProviderCancelResult,
} from "./first-intent.identity";
import {
  ProviderCreateRejectedError,
  ProviderCreateUnknownError,
} from "./payment-provider.errors";

export type InMemoryProviderMode = "ok" | "reject" | "unknown-once";
export type InMemoryCancelMode =
  | "ok"
  | "reject"
  | "timeout"
  | "network_failure"
  | "not_cancellable"
  | "already_canceled";

type Stored = {
  providerIntentId: string;
  payload: FirstAttemptClientPayload;
  canceled: boolean;
};

/**
 * Test / local fake. Create is idempotent on the first-attempt identity.
 * unknown-once: records the provider object then throws (lost HTTP response).
 */
@Injectable()
export class InMemoryFirstAttemptProviders {
  createCalls = 0;
  retrieveCalls = 0;
  cancelCalls = 0;
  stripeMode: InMemoryProviderMode = "ok";
  paypalMode: InMemoryProviderMode = "ok";
  stripeCancelMode: InMemoryCancelMode = "ok";
  paypalCancelMode: InMemoryCancelMode = "ok";
  createDelayMs = 0;
  /** Test hook — invoked at the start of cancelOpenIntent (after Cancel Tx must already be committed). */
  onCancelOpenIntent?: (providerIntentId: string) => void | Promise<void>;

  private readonly byKey = new Map<string, Stored>();
  private readonly byIntent = new Map<string, Stored>();

  reset(): void {
    this.createCalls = 0;
    this.retrieveCalls = 0;
    this.cancelCalls = 0;
    this.stripeMode = "ok";
    this.paypalMode = "ok";
    this.stripeCancelMode = "ok";
    this.paypalCancelMode = "ok";
    this.createDelayMs = 0;
    this.onCancelOpenIntent = undefined;
    this.byKey.clear();
    this.byIntent.clear();
  }

  adapters(): FirstAttemptProviderAdapter[] {
    return [this.adapter("stripe"), this.adapter("paypal")];
  }

  storedCount(): number {
    return this.byKey.size;
  }

  markCanceled(providerIntentId: string): void {
    const stored = this.byIntent.get(providerIntentId);
    if (stored) stored.canceled = true;
  }

  private adapter(provider: FirstAttemptProviderName): FirstAttemptProviderAdapter {
    return {
      provider,
      createOrRecover: (input) => this.createOrRecover(provider, input),
      getClientPayload: (providerIntentId) => this.getClientPayload(provider, providerIntentId),
      cancelOpenIntent: (providerIntentId) => this.cancelOpenIntent(provider, providerIntentId),
    };
  }

  private async createOrRecover(
    provider: FirstAttemptProviderName,
    input: FirstAttemptCreateInput,
  ): Promise<FirstAttemptProviderObject> {
    this.createCalls += 1;
    if (this.createDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.createDelayMs));
    }
    const mode = provider === "stripe" ? this.stripeMode : this.paypalMode;
    const mapKey = `${provider}:${input.idempotencyKey}`;

    if (mode === "reject") {
      throw new ProviderCreateRejectedError(`${provider} rejected create`);
    }

    const stored = this.ensureObject(provider, mapKey, input.idempotencyKey);

    if (mode === "unknown-once") {
      if (provider === "stripe") this.stripeMode = "ok";
      else this.paypalMode = "ok";
      throw new ProviderCreateUnknownError(`${provider} create outcome unknown`);
    }

    return { providerIntentId: stored.providerIntentId, payload: stored.payload };
  }

  private async getClientPayload(
    provider: FirstAttemptProviderName,
    providerIntentId: string,
  ): Promise<FirstAttemptClientPayload> {
    this.retrieveCalls += 1;
    const stored = this.byIntent.get(providerIntentId);
    if (!stored) {
      throw new ProviderCreateUnknownError(`${provider} object not found`);
    }
    return stored.payload;
  }

  private async cancelOpenIntent(
    provider: FirstAttemptProviderName,
    providerIntentId: string,
  ): Promise<ProviderCancelResult> {
    this.cancelCalls += 1;
    if (this.onCancelOpenIntent) {
      await this.onCancelOpenIntent(providerIntentId);
    }
    const stored = this.byIntent.get(providerIntentId);
    const mode = provider === "stripe" ? this.stripeCancelMode : this.paypalCancelMode;

    if (!stored) {
      return { outcome: "rejected", errorCode: "NOT_FOUND" };
    }
    if (stored.canceled || mode === "already_canceled") {
      stored.canceled = true;
      return { outcome: "not_cancellable", errorCode: "ALREADY_CANCELED" };
    }
    if (mode === "ok") {
      stored.canceled = true;
      return { outcome: "succeeded" };
    }
    const map: Record<
      Exclude<InMemoryCancelMode, "ok" | "already_canceled">,
      ProviderCancelOutcome
    > = {
      reject: "rejected",
      timeout: "timeout",
      network_failure: "network_failure",
      not_cancellable: "not_cancellable",
    };
    return { outcome: map[mode], errorCode: `TEST_${mode.toUpperCase()}` };
  }

  private ensureObject(
    provider: FirstAttemptProviderName,
    mapKey: string,
    idempotencyKey: string,
  ): Stored {
    const existing = this.byKey.get(mapKey);
    if (existing) return existing;
    const digest = createHash("sha256").update(mapKey).digest("hex").slice(0, 24);
    const providerIntentId =
      provider === "stripe" ? `pi_test_${digest}` : `PAYPAL-TEST-${digest}`;
    const payload: FirstAttemptClientPayload =
      provider === "stripe"
        ? { provider: "stripe", clientSecret: `cs_test_${digest}_secret` }
        : {
            provider: "paypal",
            approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${digest}`,
          };
    const stored: Stored = { providerIntentId, payload, canceled: false };
    this.byKey.set(mapKey, stored);
    this.byIntent.set(providerIntentId, stored);
    void idempotencyKey;
    return stored;
  }
}
