/**
 * §7d PI-CF-R5 — first-attempt provider idempotency identity.
 * Deterministic from immutable Order.id. Must not be reused for §7 retry.
 */
export function firstAttemptProviderIdempotencyIdentity(orderId: string): string {
  return `dodo:first-intent:${orderId}`;
}

/**
 * §7 retry — provider idempotency identity for a retry attempt.
 * Distinct from first-intent; `attemptKey` is stable under Order lock
 * (e.g. next attempt ordinal, or existing Payment.id when recovering a shell).
 */
export function retryAttemptProviderIdempotencyIdentity(
  orderId: string,
  attemptKey: string,
): string {
  return `dodo:retry-intent:${orderId}:${attemptKey}`;
}

export type FirstAttemptProviderName = "stripe" | "paypal";

export type StripeClientPayload = {
  provider: "stripe";
  clientSecret: string;
};

export type PayPalClientPayload = {
  provider: "paypal";
  approvalUrl: string;
};

export type FirstAttemptClientPayload = StripeClientPayload | PayPalClientPayload;

export type FirstAttemptProviderObject = {
  providerIntentId: string;
  payload: FirstAttemptClientPayload;
};

export type FirstAttemptCreateInput = {
  orderId: string;
  amount: string;
  currencyCode: string;
  idempotencyKey: string;
};

/** Adapter-level cancel outcomes (R2.2-F). `skipped` is decided by PaymentsService without calling the adapter. */
export type ProviderCancelOutcome =
  | "succeeded"
  | "rejected"
  | "timeout"
  | "network_failure"
  | "not_cancellable";

export type ProviderCancelResult = {
  outcome: ProviderCancelOutcome;
  errorCode?: string;
};

export interface FirstAttemptProviderAdapter {
  readonly provider: FirstAttemptProviderName;
  createOrRecover(input: FirstAttemptCreateInput): Promise<FirstAttemptProviderObject>;
  getClientPayload(providerIntentId: string): Promise<FirstAttemptClientPayload>;
  /** Best-effort cancel/void of an open first-attempt provider object (R2.2-F). */
  cancelOpenIntent(providerIntentId: string): Promise<ProviderCancelResult>;
}
