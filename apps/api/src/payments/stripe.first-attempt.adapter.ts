import { Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";
import type {
  FirstAttemptCreateInput,
  FirstAttemptClientPayload,
  FirstAttemptProviderAdapter,
  FirstAttemptProviderObject,
  ProviderCancelResult,
} from "./first-intent.identity";
import {
  ProviderCreateRejectedError,
  ProviderCreateUnknownError,
} from "./payment-provider.errors";
import {
  readHeader,
  WEBHOOK_FRESHNESS_SEC,
  type WebhookVerifyResult,
} from "./webhook.types";

const STRIPE_API = "https://api.stripe.com/v1";

/**
 * Stripe PaymentIntent create/retrieve. Uses Stripe Idempotency-Key (not a unified API name).
 */
@Injectable()
export class StripeFirstAttemptAdapter implements FirstAttemptProviderAdapter {
  readonly provider = "stripe" as const;

  async createOrRecover(input: FirstAttemptCreateInput): Promise<FirstAttemptProviderObject> {
    const secret = env.STRIPE_SECRET_KEY.trim();
    if (!secret) {
      throw new ProviderCreateUnknownError("Stripe is not configured");
    }
    const amount = toStripeAmount(input.amount);
    const body = new URLSearchParams({
      amount: String(amount),
      currency: input.currencyCode.toLowerCase(),
      "automatic_payment_methods[enabled]": "true",
      "metadata[orderId]": input.orderId,
    });
    let res: Response;
    try {
      res = await fetch(`${STRIPE_API}/payment_intents`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": input.idempotencyKey,
        },
        body,
      });
    } catch (e) {
      throw new ProviderCreateUnknownError(
        e instanceof Error ? e.message : "Stripe create network failure",
      );
    }
    if (res.status >= 400 && res.status < 500) {
      const text = await res.text().catch(() => "");
      throw new ProviderCreateRejectedError(`Stripe rejected create (${res.status}) ${text}`.trim());
    }
    if (!res.ok) {
      throw new ProviderCreateUnknownError(`Stripe create HTTP ${res.status}`);
    }
    const json = (await res.json()) as { id?: string; client_secret?: string | null };
    if (!json.id || !json.client_secret) {
      throw new ProviderCreateUnknownError("Stripe create missing id/client_secret");
    }
    return {
      providerIntentId: json.id,
      payload: { provider: "stripe", clientSecret: json.client_secret },
    };
  }

  async getClientPayload(providerIntentId: string): Promise<FirstAttemptClientPayload> {
    const secret = env.STRIPE_SECRET_KEY.trim();
    if (!secret) {
      throw new ProviderCreateUnknownError("Stripe is not configured");
    }
    let res: Response;
    try {
      res = await fetch(`${STRIPE_API}/payment_intents/${encodeURIComponent(providerIntentId)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
    } catch (e) {
      throw new ProviderCreateUnknownError(
        e instanceof Error ? e.message : "Stripe retrieve network failure",
      );
    }
    if (!res.ok) {
      throw new ProviderCreateUnknownError(`Stripe retrieve HTTP ${res.status}`);
    }
    const json = (await res.json()) as { client_secret?: string | null };
    if (!json.client_secret) {
      throw new ProviderCreateUnknownError("Stripe retrieve missing client_secret");
    }
    return { provider: "stripe", clientSecret: json.client_secret };
  }

  /**
   * R2.2-F — Stripe PaymentIntent cancel (capability-specific).
   * Already-canceled / captured / succeeded → not_cancellable.
   */
  async cancelOpenIntent(providerIntentId: string): Promise<ProviderCancelResult> {
    const secret = env.STRIPE_SECRET_KEY.trim();
    if (!secret) {
      return { outcome: "rejected", errorCode: "STRIPE_NOT_CONFIGURED" };
    }
    let current: Response;
    try {
      current = await fetch(
        `${STRIPE_API}/payment_intents/${encodeURIComponent(providerIntentId)}`,
        {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (e) {
      if (isAbortError(e)) return { outcome: "timeout", errorCode: "STRIPE_RETRIEVE_TIMEOUT" };
      return {
        outcome: "network_failure",
        errorCode: e instanceof Error ? e.message : "STRIPE_RETRIEVE_NETWORK",
      };
    }
    if (!current.ok) {
      if (current.status >= 400 && current.status < 500) {
        return { outcome: "rejected", errorCode: `STRIPE_RETRIEVE_${current.status}` };
      }
      return { outcome: "network_failure", errorCode: `STRIPE_RETRIEVE_${current.status}` };
    }
    const curJson = (await current.json()) as { status?: string };
    const status = curJson.status ?? "";
    if (status === "canceled") {
      return { outcome: "not_cancellable", errorCode: "ALREADY_CANCELED" };
    }
    if (
      status === "succeeded" ||
      status === "processing" ||
      status === "requires_capture"
    ) {
      return { outcome: "not_cancellable", errorCode: `STATUS_${status}` };
    }

    let res: Response;
    try {
      res = await fetch(
        `${STRIPE_API}/payment_intents/${encodeURIComponent(providerIntentId)}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (e) {
      if (isAbortError(e)) return { outcome: "timeout", errorCode: "STRIPE_CANCEL_TIMEOUT" };
      return {
        outcome: "network_failure",
        errorCode: e instanceof Error ? e.message : "STRIPE_CANCEL_NETWORK",
      };
    }
    if (res.status >= 400 && res.status < 500) {
      const text = await res.text().catch(() => "");
      if (/already.*?cancel/i.test(text) || res.status === 400) {
        return { outcome: "not_cancellable", errorCode: `STRIPE_CANCEL_${res.status}` };
      }
      return { outcome: "rejected", errorCode: `STRIPE_CANCEL_${res.status}` };
    }
    if (!res.ok) {
      return { outcome: "network_failure", errorCode: `STRIPE_CANCEL_${res.status}` };
    }
    return { outcome: "succeeded" };
  }

  /**
   * Stripe-Signature: HMAC-SHA256 of `${t}.${rawBody}` with the endpoint secret.
   * Freshness: |now − t| ≤ 300s (Stripe default).
   */
  async verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<WebhookVerifyResult> {
    const header = readHeader(headers, "stripe-signature");
    if (!header) return { outcome: "mismatch" };

    const secret = stripeWebhookSecret();
    if (!secret) return { outcome: "invalid", reason: "signature" };

    const sig = parseStripeSignature(header);
    if (!sig) return { outcome: "invalid", reason: "malformed" };

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - sig.timestamp) > WEBHOOK_FRESHNESS_SEC) {
      return { outcome: "invalid", reason: "freshness" };
    }

    if (!stripeHmacMatches(rawBody, secret, sig.timestamp, sig.v1)) {
      return { outcome: "invalid", reason: "signature" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      return { outcome: "invalid", reason: "malformed" };
    }
    if (!parsed || typeof parsed !== "object") {
      return { outcome: "invalid", reason: "malformed" };
    }
    const obj = parsed as {
      id?: unknown;
      type?: unknown;
      data?: { object?: { id?: unknown } };
    };
    if (typeof obj.id !== "string" || !obj.id || typeof obj.type !== "string" || !obj.type) {
      return { outcome: "invalid", reason: "malformed" };
    }

    if (obj.type === "payment_intent.succeeded") {
      const intentId = obj.data?.object?.id;
      if (typeof intentId !== "string" || !intentId) {
        return { outcome: "invalid", reason: "malformed" };
      }
      return {
        outcome: "verified",
        provider: "stripe",
        eventId: obj.id,
        eventType: obj.type,
        classification: "paid",
        providerIntentId: intentId,
      };
    }

    return {
      outcome: "verified",
      provider: "stripe",
      eventId: obj.id,
      eventType: obj.type,
      classification: "ignore",
      providerIntentId: null,
    };
  }
}

function stripeWebhookSecret(): string {
  return (process.env.STRIPE_WEBHOOK_SECRET ?? env.STRIPE_WEBHOOK_SECRET ?? "").trim();
}

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof Error && e.name === "AbortError") ||
    (typeof e === "object" && e !== null && "name" in e && (e as { name: string }).name === "TimeoutError")
  );
}

function parseStripeSignature(header: string): { timestamp: number; v1: string[] } | null {
  let timestamp: number | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq);
    const v = trimmed.slice(eq + 1);
    if (k === "t") {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      timestamp = n;
    } else if (k === "v1" && v) {
      v1.push(v);
    }
  }
  if (timestamp === undefined || v1.length === 0) return null;
  return { timestamp, v1 };
}

function stripeHmacMatches(rawBody: Buffer, secret: string, timestamp: number, v1: string[]): boolean {
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  return v1.some((sig) => {
    try {
      const got = Buffer.from(sig, "hex");
      return got.length === expectedBuf.length && timingSafeEqual(got, expectedBuf);
    } catch {
      return false;
    }
  });
}

function toStripeAmount(major: string): number {
  const n = Number(major);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ProviderCreateRejectedError("Invalid amount for Stripe");
  }
  return Math.round(n * 100);
}
