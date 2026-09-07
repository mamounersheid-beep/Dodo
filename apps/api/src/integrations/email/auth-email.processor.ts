import type { EnqueueAuthEmailInput } from "./email-integration.port";
import type { AuthEmailSender } from "./auth-email-sender.port";
import type { RedisAuthEmailDeliveryStore } from "./auth-email-delivery.store";

export type AuthEmailProcessResult = "sent" | "skipped";

/**
 * Idempotent Auth email processing (10.10 §2/§4).
 * - Skips send when business key already delivered.
 * - Marks delivered only after successful send.
 * - Must not touch VerificationToken / User / Sessions (caller responsibility).
 */
export async function processAuthEmailJob(
  payload: EnqueueAuthEmailInput,
  deps: {
    sender: AuthEmailSender;
    delivery: RedisAuthEmailDeliveryStore;
  },
): Promise<AuthEmailProcessResult> {
  if (await deps.delivery.wasDelivered(payload.idempotencyKey)) {
    return "skipped";
  }

  await deps.sender.sendAuthEmail(payload);
  await deps.delivery.markDelivered(payload.idempotencyKey);
  return "sent";
}
