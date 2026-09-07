/**
 * Inventory — Hybrid reservation (#4+#19 / 10.3).
 * Paper defaults: checkout lock ~15min · unpaid bind TTL 48h.
 */

export const V1_LOCATION_CODE = "MAIN" as const;

/** Short checkout lock — Hybrid phase 1 */
export const CHECKOUT_RESERVATION_TTL_MS = 15 * 60 * 1000;

/** Unpaid order hold after bind — Hybrid phase 2 · V1 default 48h */
export const UNPAID_ORDER_TTL_MS = 48 * 60 * 60 * 1000;

/** StockMovement.reason values (10.3 V1) */
export const StockMovementReason = {
  SALE: "sale",
  CANCEL_RESTOCK: "cancel_restock",
  RETURN: "return",
  ADJUST: "adjust",
} as const;

/**
 * R2.2-B logical operation name only (`restock:cancel:{orderId}`).
 * Durable once-only marker = EXISTS StockMovement(orderId, reason=cancel_restock) — not this string alone.
 */
export function cancelRestockReferenceId(orderId: string): string {
  return `restock:cancel:${orderId}`;
}

export const InventoryError = {
  INVENTORY_NOT_FOUND: "INVENTORY_NOT_FOUND",
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  LOCATION_NOT_FOUND: "LOCATION_NOT_FOUND",
  RESERVATION_NOT_FOUND: "RESERVATION_NOT_FOUND",
  RESERVATION_NOT_ACTIVE: "RESERVATION_NOT_ACTIVE",
  INVALID_QUANTITY: "INVALID_QUANTITY",
  ADJUST_NEGATIVE_ON_HAND: "ADJUST_NEGATIVE_ON_HAND",
} as const;

export type InventoryErrorCode = (typeof InventoryError)[keyof typeof InventoryError];
