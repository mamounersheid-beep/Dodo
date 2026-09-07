import { Injectable } from "@nestjs/common";
import type {
  RefundCreateInput,
  RefundProviderAdapter,
  RefundProviderName,
  RefundProviderOutcome,
  RefundReconcileInput,
} from "./refund-provider.port";

export type InMemoryRefundMode =
  | "succeed"
  | "reject"
  | "pending"
  | "timeout"
  | "lookup_failed"
  | "orphan_on_failed";

type StoredRefund = {
  refundId: string;
  providerRefundId: string;
  status: "succeeded" | "rejected" | "pending";
  providerIntentId: string;
};

/**
 * Test fake for W3 Admin Refund HTTP. Create is idempotent on Refund.id.
 */
@Injectable()
export class InMemoryRefundProviders {
  createCalls = 0;
  reconcileCalls = 0;
  mode: InMemoryRefundMode = "succeed";
  private readonly byRefundId = new Map<string, StoredRefund>();

  reset(): void {
    this.createCalls = 0;
    this.reconcileCalls = 0;
    this.mode = "succeed";
    this.byRefundId.clear();
  }

  adapters(): RefundProviderAdapter[] {
    return [this.adapter("stripe"), this.adapter("paypal")];
  }

  seedSucceeded(refundId: string, providerIntentId: string, providerRefundId?: string): void {
    this.byRefundId.set(refundId, {
      refundId,
      providerIntentId,
      providerRefundId: providerRefundId ?? `re_mem_${refundId}`,
      status: "succeeded",
    });
  }

  private adapter(provider: RefundProviderName): RefundProviderAdapter {
    return {
      provider,
      reconcile: async (input) => this.reconcile(input),
      createRefund: async (input) => this.create(input),
    };
  }

  private async reconcile(input: RefundReconcileInput): Promise<RefundProviderOutcome> {
    this.reconcileCalls += 1;
    if (this.mode === "lookup_failed") return { kind: "lookup_failed" };
    const existing = this.byRefundId.get(input.refundId);
    if (!existing) {
      if (input.providerRefundId) {
        for (const row of this.byRefundId.values()) {
          if (row.providerRefundId === input.providerRefundId) {
            return this.toOutcome(row);
          }
        }
      }
      return { kind: "pending" };
    }
    return this.toOutcome(existing);
  }

  private async create(input: RefundCreateInput): Promise<RefundProviderOutcome> {
    this.createCalls += 1;
    const existing = this.byRefundId.get(input.refundId);
    if (existing) return this.toOutcome(existing);

    if (this.mode === "timeout") {
      const id = `re_mem_pending_${input.refundId}`;
      this.byRefundId.set(input.refundId, {
        refundId: input.refundId,
        providerIntentId: input.providerIntentId,
        providerRefundId: id,
        status: "pending",
      });
      return { kind: "pending", providerRefundId: id };
    }
    if (this.mode === "reject") {
      const id = `re_mem_fail_${input.refundId}`;
      this.byRefundId.set(input.refundId, {
        refundId: input.refundId,
        providerIntentId: input.providerIntentId,
        providerRefundId: id,
        status: "rejected",
      });
      return { kind: "rejected", providerRefundId: id, errorCode: "card_decline" };
    }
    if (this.mode === "pending") {
      const id = `re_mem_open_${input.refundId}`;
      this.byRefundId.set(input.refundId, {
        refundId: input.refundId,
        providerIntentId: input.providerIntentId,
        providerRefundId: id,
        status: "pending",
      });
      return { kind: "pending", providerRefundId: id };
    }
    if (this.mode === "lookup_failed") {
      return { kind: "lookup_failed" };
    }

    const id = `re_mem_${input.refundId}`;
    this.byRefundId.set(input.refundId, {
      refundId: input.refundId,
      providerIntentId: input.providerIntentId,
      providerRefundId: id,
      status: "succeeded",
    });
    return { kind: "succeeded", providerRefundId: id };
  }

  private toOutcome(row: StoredRefund): RefundProviderOutcome {
    if (row.status === "succeeded") {
      return { kind: "succeeded", providerRefundId: row.providerRefundId };
    }
    if (row.status === "rejected") {
      return { kind: "rejected", providerRefundId: row.providerRefundId };
    }
    return { kind: "pending", providerRefundId: row.providerRefundId };
  }
}
