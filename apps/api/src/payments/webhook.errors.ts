/** Valid signed PAID-class event with no local Payment mapping — provider should retry (503). */
export class WebhookOrphanError extends Error {
  constructor() {
    super("Webhook PAID event has no local Payment mapping");
    this.name = "WebhookOrphanError";
  }
}

/** Convert/sale/REDEEM cannot complete safely — abort the settlement transaction (500). */
export class WebhookSettlementAbortError extends Error {
  constructor() {
    super("Webhook settlement could not complete safely");
    this.name = "WebhookSettlementAbortError";
  }
}
