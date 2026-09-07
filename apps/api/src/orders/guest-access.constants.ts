/**
 * #16 Guest Access Token — V1 default TTL from placedAt (10.7 §1b).
 * Configurable in paper; execution uses this constant (no schema/env expansion in this slice).
 */
export const GUEST_ORDER_ACCESS_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Independent #16 Reissue Audit action (not Admin Resend). */
export const GUEST_ACCESS_REISSUE_AUDIT_ACTION = "order.guest_access.reissue";

/** Admin Resend success Audit — 10.10 §2b. */
export const ORDER_CONFIRMATION_RESEND_AUDIT_ACTION = "order.confirmation.resend";
