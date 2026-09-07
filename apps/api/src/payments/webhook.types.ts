import type { FirstAttemptProviderName } from "./first-intent.identity";

export type WebhookClassification = "paid" | "ignore";

export type WebhookVerifyMismatch = { outcome: "mismatch" };

export type WebhookVerifyInvalid = {
  outcome: "invalid";
  reason: "signature" | "freshness" | "malformed";
};

export type WebhookVerifyOk = {
  outcome: "verified";
  provider: FirstAttemptProviderName;
  eventId: string;
  eventType: string;
  classification: WebhookClassification;
  providerIntentId: string | null;
};

export type WebhookVerifyResult = WebhookVerifyMismatch | WebhookVerifyInvalid | WebhookVerifyOk;

/** Stripe default replay window. PayPal local freshness uses the same bound. */
export const WEBHOOK_FRESHNESS_SEC = 300;

export function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : undefined;
}
