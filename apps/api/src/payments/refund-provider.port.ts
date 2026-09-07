/**
 * W3 §4a provider refund port — used by Admin Refund HTTP §4e.
 * Logical identity = Refund.id (metadata.dodo_refund_id / PayPal custom_id).
 */

export type RefundProviderName = "stripe" | "paypal";

export type RefundProviderOutcome =
  | { kind: "succeeded"; providerRefundId: string }
  | { kind: "rejected"; providerRefundId?: string | null; errorCode?: string }
  | { kind: "pending"; providerRefundId?: string | null }
  | { kind: "lookup_failed" }
  | { kind: "orphan_succeeded"; providerRefundId: string };

export type RefundCreateInput = {
  refundId: string;
  provider: RefundProviderName;
  providerIntentId: string;
  amount: string;
  currencyCode: string;
};

export type RefundReconcileInput = {
  refundId: string;
  provider: RefundProviderName;
  providerIntentId: string;
  providerRefundId: string | null;
};

export interface RefundProviderAdapter {
  readonly provider: RefundProviderName;
  /** Reconcile before create; must not create. */
  reconcile(input: RefundReconcileInput): Promise<RefundProviderOutcome>;
  /** Create only after reconcile proves no prior refund for Refund.id. */
  createRefund(input: RefundCreateInput): Promise<RefundProviderOutcome>;
}

export const REFUND_PROVIDER_ADAPTERS = Symbol("REFUND_PROVIDER_ADAPTERS");

/** Optional test override — when set, AdminRefundService uses in-memory adapters. */
export const REFUND_PROVIDER_MEMORY = Symbol("REFUND_PROVIDER_MEMORY");
