import { Injectable } from "@nestjs/common";
import { env } from "../config/env";
import type {
  RefundCreateInput,
  RefundProviderAdapter,
  RefundProviderOutcome,
  RefundReconcileInput,
} from "./refund-provider.port";

/**
 * PayPal refunds — §4a custom_id = Refund.id · PayPal-Request-Id from Refund.id.
 * Capture resolution uses Payment.providerIntentId (no new capture column).
 */
@Injectable()
export class PayPalRefundAdapter implements RefundProviderAdapter {
  readonly provider = "paypal" as const;

  async reconcile(input: RefundReconcileInput): Promise<RefundProviderOutcome> {
    const token = await this.accessToken();
    if (!token) return { kind: "lookup_failed" };

    if (input.providerRefundId) {
      const one = await this.retrieve(token, input.providerRefundId);
      if (one) return one;
    }
    // Without a stored providerRefundId, V1 stays PENDING until recover finds an id.
    return { kind: "pending" };
  }

  async createRefund(input: RefundCreateInput): Promise<RefundProviderOutcome> {
    const token = await this.accessToken();
    if (!token) return { kind: "pending" };

    const base = env.PAYPAL_API_BASE.trim().replace(/\/+$/, "") || "https://api-m.sandbox.paypal.com";
    const captureId = input.providerIntentId;
    let res: Response;
    try {
      res = await fetch(`${base}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": `dodo-refund-${input.refundId}`,
        },
        body: JSON.stringify({
          amount: {
            value: input.amount,
            currency_code: input.currencyCode,
          },
          custom_id: input.refundId,
        }),
      });
    } catch {
      return { kind: "pending" };
    }

    if (res.status >= 400 && res.status < 500) {
      return { kind: "rejected", errorCode: `paypal_${res.status}`, providerRefundId: null };
    }
    if (!res.ok) return { kind: "pending" };

    const json = (await res.json()) as { id?: string; status?: string };
    if (!json.id) return { kind: "pending" };
    return this.mapStatus(json.id, json.status);
  }

  private async retrieve(token: string, providerRefundId: string): Promise<RefundProviderOutcome | null> {
    const base = env.PAYPAL_API_BASE.trim().replace(/\/+$/, "") || "https://api-m.sandbox.paypal.com";
    try {
      const res = await fetch(`${base}/v2/payments/refunds/${encodeURIComponent(providerRefundId)}`, {
        headers: { Authorization: `Bearer ${token}` },
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
    const s = (status ?? "").toUpperCase();
    if (s === "COMPLETED") return { kind: "succeeded", providerRefundId: id };
    if (s === "CANCELLED" || s === "FAILED") {
      return { kind: "rejected", providerRefundId: id, errorCode: s };
    }
    return { kind: "pending", providerRefundId: id };
  }

  private async accessToken(): Promise<string | null> {
    const id = env.PAYPAL_CLIENT_ID.trim();
    const secret = env.PAYPAL_CLIENT_SECRET.trim();
    if (!id || !secret) return null;
    const base = env.PAYPAL_API_BASE.trim().replace(/\/+$/, "") || "https://api-m.sandbox.paypal.com";
    try {
      const res = await fetch(`${base}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { access_token?: string };
      return json.access_token ?? null;
    } catch {
      return null;
    }
  }
}
