import { Injectable } from "@nestjs/common";
import { env } from "../config/env";
import type {
  RefundCreateInput,
  RefundProviderAdapter,
  RefundProviderOutcome,
  RefundReconcileInput,
} from "./refund-provider.port";

const STRIPE_API = "https://api.stripe.com/v1";

/**
 * Stripe Refunds — §4a metadata.dodo_refund_id + Idempotency-Key from Refund.id.
 */
@Injectable()
export class StripeRefundAdapter implements RefundProviderAdapter {
  readonly provider = "stripe" as const;

  async reconcile(input: RefundReconcileInput): Promise<RefundProviderOutcome> {
    const secret = env.STRIPE_SECRET_KEY.trim();
    if (!secret) return { kind: "lookup_failed" };

    if (input.providerRefundId) {
      const one = await this.retrieve(secret, input.providerRefundId);
      if (one) return one;
    }

    try {
      const res = await fetch(
        `${STRIPE_API}/refunds?payment_intent=${encodeURIComponent(input.providerIntentId)}&limit=100`,
        { headers: { Authorization: `Bearer ${secret}` } },
      );
      if (!res.ok) return { kind: "lookup_failed" };
      const json = (await res.json()) as {
        data?: Array<{ id?: string; status?: string; metadata?: { dodo_refund_id?: string } }>;
      };
      const match = (json.data ?? []).find((r) => r.metadata?.dodo_refund_id === input.refundId);
      if (!match?.id) return { kind: "pending" };
      return this.mapStatus(match.id, match.status);
    } catch {
      return { kind: "lookup_failed" };
    }
  }

  async createRefund(input: RefundCreateInput): Promise<RefundProviderOutcome> {
    const secret = env.STRIPE_SECRET_KEY.trim();
    if (!secret) return { kind: "pending" };

    const amount = toStripeAmount(input.amount);
    const body = new URLSearchParams({
      payment_intent: input.providerIntentId,
      amount: String(amount),
      "metadata[dodo_refund_id]": input.refundId,
    });

    let res: Response;
    try {
      res = await fetch(`${STRIPE_API}/refunds`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": `dodo-refund-${input.refundId}`,
        },
        body,
      });
    } catch {
      return { kind: "pending" };
    }

    if (res.status >= 400 && res.status < 500) {
      const text = await res.text().catch(() => "");
      return { kind: "rejected", errorCode: `stripe_${res.status}`, providerRefundId: null };
    }
    if (!res.ok) return { kind: "pending" };

    const json = (await res.json()) as { id?: string; status?: string };
    if (!json.id) return { kind: "pending" };
    return this.mapStatus(json.id, json.status);
  }

  private async retrieve(secret: string, providerRefundId: string): Promise<RefundProviderOutcome | null> {
    try {
      const res = await fetch(`${STRIPE_API}/refunds/${encodeURIComponent(providerRefundId)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) return { kind: "lookup_failed" };
      const json = (await res.json()) as { id?: string; status?: string };
      if (!json.id) return { kind: "lookup_failed" };
      return this.mapStatus(json.id, json.status);
    } catch {
      return { kind: "lookup_failed" };
    }
  }

  private mapStatus(id: string, status: string | undefined): RefundProviderOutcome {
    if (status === "succeeded") return { kind: "succeeded", providerRefundId: id };
    if (status === "failed" || status === "canceled") {
      return { kind: "rejected", providerRefundId: id, errorCode: status };
    }
    return { kind: "pending", providerRefundId: id };
  }
}

function toStripeAmount(decimal: string): number {
  const n = Number(decimal);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
