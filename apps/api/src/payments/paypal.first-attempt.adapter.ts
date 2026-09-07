import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
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

/**
 * PayPal Orders v2. Uses PayPal-Request-Id (not a unified API name with Stripe).
 */
@Injectable()
export class PayPalFirstAttemptAdapter implements FirstAttemptProviderAdapter {
  readonly provider = "paypal" as const;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  async createOrRecover(input: FirstAttemptCreateInput): Promise<FirstAttemptProviderObject> {
    const token = await this.accessToken();
    const returnUrl = paypalReturnUrl();
    let res: Response;
    try {
      res = await fetch(`${paypalApiBase()}/v2/checkout/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": toPayPalRequestId(input.idempotencyKey),
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              custom_id: input.orderId,
              amount: {
                currency_code: input.currencyCode,
                value: toPayPalAmount(input.amount),
              },
            },
          ],
          application_context: {
            user_action: "PAY_NOW",
            return_url: returnUrl,
            cancel_url: returnUrl,
          },
        }),
      });
    } catch (e) {
      throw new ProviderCreateUnknownError(
        e instanceof Error ? e.message : "PayPal create network failure",
      );
    }
    if (res.status >= 400 && res.status < 500) {
      const text = await res.text().catch(() => "");
      throw new ProviderCreateRejectedError(`PayPal rejected create (${res.status}) ${text}`.trim());
    }
    if (!res.ok) {
      throw new ProviderCreateUnknownError(`PayPal create HTTP ${res.status}`);
    }
    const json = (await res.json()) as PayPalOrderJson;
    const approvalUrl = extractApprovalUrl(json);
    if (!json.id || !approvalUrl) {
      throw new ProviderCreateUnknownError("PayPal create missing id/approvalUrl");
    }
    return {
      providerIntentId: json.id,
      payload: { provider: "paypal", approvalUrl },
    };
  }

  async getClientPayload(providerIntentId: string): Promise<FirstAttemptClientPayload> {
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await fetch(`${paypalApiBase()}/v2/checkout/orders/${encodeURIComponent(providerIntentId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      throw new ProviderCreateUnknownError(
        e instanceof Error ? e.message : "PayPal retrieve network failure",
      );
    }
    if (!res.ok) {
      throw new ProviderCreateUnknownError(`PayPal retrieve HTTP ${res.status}`);
    }
    const json = (await res.json()) as PayPalOrderJson;
    const approvalUrl = extractApprovalUrl(json);
    if (!approvalUrl) {
      throw new ProviderCreateUnknownError("PayPal retrieve missing approvalUrl");
    }
    return { provider: "paypal", approvalUrl };
  }

  /**
   * R2.2-F — PayPal Orders v2 has no cancel for unpaid CAPTURE intents (capability-based).
   * Terminal / completed / voided → not_cancellable. Open unpaid → not_cancellable (no void API).
   */
  async cancelOpenIntent(providerIntentId: string): Promise<ProviderCancelResult> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch (e) {
      return {
        outcome: "rejected",
        errorCode: e instanceof Error ? e.message : "PAYPAL_NOT_CONFIGURED",
      };
    }
    let res: Response;
    try {
      res = await fetch(
        `${paypalApiBase()}/v2/checkout/orders/${encodeURIComponent(providerIntentId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (e) {
      if (isAbortError(e)) return { outcome: "timeout", errorCode: "PAYPAL_RETRIEVE_TIMEOUT" };
      return {
        outcome: "network_failure",
        errorCode: e instanceof Error ? e.message : "PAYPAL_RETRIEVE_NETWORK",
      };
    }
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        return { outcome: "rejected", errorCode: `PAYPAL_RETRIEVE_${res.status}` };
      }
      return { outcome: "network_failure", errorCode: `PAYPAL_RETRIEVE_${res.status}` };
    }
    const json = (await res.json()) as { status?: string };
    const status = (json.status ?? "").toUpperCase();
    if (
      status === "COMPLETED" ||
      status === "VOIDED" ||
      status === "EXPIRED" ||
      status === "APPROVED"
    ) {
      return { outcome: "not_cancellable", errorCode: `STATUS_${status || "UNKNOWN"}` };
    }
    // Unpaid CREATED / PAYER_ACTION_REQUIRED: no Orders-v2 cancel capability for CAPTURE intent.
    return { outcome: "not_cancellable", errorCode: "PAYPAL_NO_CANCEL_CAPABILITY" };
  }

  /**
   * PayPal transmission headers + POST /v1/notifications/verify-webhook-signature.
   * Local freshness on PAYPAL-TRANSMISSION-TIME before the verify call.
   * Does not fetch PAYPAL-CERT-URL (SSRF); host is allowlisted before it is sent to PayPal.
   */
  async verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<WebhookVerifyResult> {
    const transmissionId = readHeader(headers, "paypal-transmission-id");
    const transmissionTime = readHeader(headers, "paypal-transmission-time");
    const transmissionSig = readHeader(headers, "paypal-transmission-sig");
    const certUrl = readHeader(headers, "paypal-cert-url");
    const authAlgo = readHeader(headers, "paypal-auth-algo");

    const anyPayPal =
      Boolean(transmissionId) ||
      Boolean(transmissionTime) ||
      Boolean(transmissionSig) ||
      Boolean(certUrl) ||
      Boolean(authAlgo);
    if (!anyPayPal) return { outcome: "mismatch" };

    if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
      return { outcome: "invalid", reason: "malformed" };
    }

    const transmittedAt = Date.parse(transmissionTime);
    if (!Number.isFinite(transmittedAt)) {
      return { outcome: "invalid", reason: "malformed" };
    }
    if (Math.abs(Date.now() - transmittedAt) > WEBHOOK_FRESHNESS_SEC * 1000) {
      return { outcome: "invalid", reason: "freshness" };
    }

    if (!paypalCertUrlAllowed(certUrl)) {
      return { outcome: "invalid", reason: "signature" };
    }

    const webhookId = paypalWebhookId();
    if (!webhookId) {
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
    const event = parsed as {
      id?: unknown;
      event_type?: unknown;
      resource?: PayPalWebhookResource;
    };
    if (typeof event.id !== "string" || !event.id || typeof event.event_type !== "string" || !event.event_type) {
      return { outcome: "invalid", reason: "malformed" };
    }

    const verified = await this.verifyWithPayPalApi({
      authAlgo,
      certUrl,
      transmissionId,
      transmissionSig,
      transmissionTime,
      webhookId,
      webhookEvent: parsed,
    });
    if (verified === "invalid") return { outcome: "invalid", reason: "signature" };
    if (verified === "malformed") return { outcome: "invalid", reason: "malformed" };

    const eventType = event.event_type;
    if (eventType === "CHECKOUT.ORDER.COMPLETED" || eventType === "PAYMENT.CAPTURE.COMPLETED") {
      const intentId = paypalProviderIntentId(eventType, event.resource);
      if (!intentId) return { outcome: "invalid", reason: "malformed" };
      return {
        outcome: "verified",
        provider: "paypal",
        eventId: event.id,
        eventType,
        classification: "paid",
        providerIntentId: intentId,
      };
    }

    return {
      outcome: "verified",
      provider: "paypal",
      eventId: event.id,
      eventType,
      classification: "ignore",
      providerIntentId: null,
    };
  }

  private async verifyWithPayPalApi(input: {
    authAlgo: string;
    certUrl: string;
    transmissionId: string;
    transmissionSig: string;
    transmissionTime: string;
    webhookId: string;
    webhookEvent: unknown;
  }): Promise<"ok" | "invalid" | "malformed"> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch {
      return "invalid";
    }
    let res: Response;
    try {
      res = await fetch(`${paypalApiBase()}/v1/notifications/verify-webhook-signature`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_algo: input.authAlgo,
          cert_url: input.certUrl,
          transmission_id: input.transmissionId,
          transmission_sig: input.transmissionSig,
          transmission_time: input.transmissionTime,
          webhook_id: input.webhookId,
          webhook_event: input.webhookEvent,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return "invalid";
    }
    if (!res.ok) return "invalid";
    let json: { verification_status?: string };
    try {
      json = (await res.json()) as { verification_status?: string };
    } catch {
      return "malformed";
    }
    if (json.verification_status === "SUCCESS") return "ok";
    return "invalid";
  }

  private async accessToken(): Promise<string> {
    const id = paypalClientId();
    const secret = paypalClientSecret();
    if (!id || !secret) {
      throw new ProviderCreateUnknownError("PayPal is not configured");
    }
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 5_000) {
      return this.cachedToken.value;
    }
    const basic = Buffer.from(`${id}:${secret}`).toString("base64");
    let res: Response;
    try {
      res = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
    } catch (e) {
      throw new ProviderCreateUnknownError(
        e instanceof Error ? e.message : "PayPal OAuth network failure",
      );
    }
    if (!res.ok) {
      throw new ProviderCreateUnknownError(`PayPal OAuth HTTP ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new ProviderCreateUnknownError("PayPal OAuth missing access_token");
    }
    const ttlMs = Math.max(30, json.expires_in ?? 300) * 1000;
    this.cachedToken = { value: json.access_token, expiresAt: now + ttlMs };
    return json.access_token;
  }
}

type PayPalOrderJson = {
  id?: string;
  links?: Array<{ rel?: string; href?: string }>;
};

function extractApprovalUrl(json: PayPalOrderJson): string | null {
  const link = json.links?.find((l) => l.rel === "approve" || l.rel === "payer-action");
  return link?.href ?? null;
}

/**
 * Orders v2 PayPal-Request-Id: UUID-shaped, ≤38 chars, derived from the
 * canonical first-attempt identity (`dodo:first-intent:${orderId}`).
 * Must not be reused for later §7 retry.
 */
function toPayPalRequestId(canonicalIdentity: string): string {
  const hex = createHash("sha256").update(canonicalIdentity).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function paypalApiBase(): string {
  const base = env.PAYPAL_API_BASE.trim();
  return (base || "https://api-m.sandbox.paypal.com").replace(/\/$/, "");
}

function paypalReturnUrl(): string {
  const explicit = env.PAYPAL_RETURN_URL.trim();
  if (explicit) return explicit;
  const origin = env.API_CORS_ORIGINS[0] ?? "http://localhost:3000";
  return `${origin.replace(/\/$/, "")}/order-tracking`;
}

function toPayPalAmount(major: string): string {
  const n = Number(major);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ProviderCreateRejectedError("Invalid amount for PayPal");
  }
  return n.toFixed(2);
}

function paypalClientId(): string {
  return (process.env.PAYPAL_CLIENT_ID ?? env.PAYPAL_CLIENT_ID ?? "").trim();
}

function paypalClientSecret(): string {
  return (process.env.PAYPAL_CLIENT_SECRET ?? env.PAYPAL_CLIENT_SECRET ?? "").trim();
}

function paypalWebhookId(): string {
  return (process.env.PAYPAL_WEBHOOK_ID ?? env.PAYPAL_WEBHOOK_ID ?? "").trim();
}

const PAYPAL_CERT_HOSTS = new Set([
  "api.paypal.com",
  "api.sandbox.paypal.com",
  "api-m.paypal.com",
  "api-m.sandbox.paypal.com",
]);

function paypalCertUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return PAYPAL_CERT_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

type PayPalWebhookResource = {
  id?: unknown;
  supplementary_data?: { related_ids?: { order_id?: unknown } };
};

function paypalProviderIntentId(
  eventType: string,
  resource: PayPalWebhookResource | undefined,
): string | null {
  if (eventType === "CHECKOUT.ORDER.COMPLETED") {
    return typeof resource?.id === "string" && resource.id ? resource.id : null;
  }
  if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
    const orderId = resource?.supplementary_data?.related_ids?.order_id;
    return typeof orderId === "string" && orderId ? orderId : null;
  }
  return null;
}

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof Error && e.name === "AbortError") ||
    (typeof e === "object" &&
      e !== null &&
      "name" in e &&
      (e as { name: string }).name === "TimeoutError")
  );
}
