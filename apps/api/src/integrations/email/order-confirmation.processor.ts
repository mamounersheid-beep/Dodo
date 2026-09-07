import { env } from "../../config/env";
import type { PrismaService } from "../../prisma/prisma.service";
import { buildOrderConfirmationEmail } from "./order-confirmation.builder";
import type { EnqueueOrderConfirmationInput } from "./email-integration.port";
import { resolveOrderCommunicationLocale } from "./email-integration.port";
import type { RedisOrderEmailDeliveryStore } from "./order-email-delivery.store";
import type { SmtpTransport } from "./smtp-transport.port";

export type OrderConfirmationProcessResult = "sent" | "skipped";

/**
 * Idempotent Order Confirmation processing (10.10 §1b / §2 / §3).
 * - Content from Order / OrderItem snapshots only; locale = Order.locale (Tr3).
 * - Seller identity = Order.sellerIdentitySnapshotJson only (not live CompanySettings).
 * - Marks delivered only after successful SMTP send.
 * - Must not mutate Order / Payment / User / Session / Token / financial state.
 */
export async function processOrderConfirmationJob(
  payload: EnqueueOrderConfirmationInput,
  deps: {
    prisma: PrismaService;
    transport: SmtpTransport;
    delivery: RedisOrderEmailDeliveryStore;
  },
): Promise<OrderConfirmationProcessResult> {
  if (await deps.delivery.wasDelivered(payload.idempotencyKey)) {
    return "skipped";
  }

  const order = await deps.prisma.order.findUnique({
    where: { id: payload.orderId },
    include: { items: true },
  });
  if (!order) {
    throw new Error(`order-confirmation: order not found id=${payload.orderId}`);
  }

  const locale = resolveOrderCommunicationLocale(order.locale);
  const built = buildOrderConfirmationEmail({
    order,
    guestAccessToken: payload.guestAccessToken,
  });

  if (built.communicationLocale !== locale) {
    throw new Error("order-confirmation: locale mismatch in builder");
  }

  await deps.transport.sendMail({
    from: env.EMAIL_FROM,
    to: payload.to,
    subject: built.subject,
    text: built.text,
    meta: {
      template: payload.template,
      idempotencyKey: payload.idempotencyKey,
      communicationLocale: built.communicationLocale,
      orderId: order.id,
    },
  });

  await deps.delivery.markDelivered(payload.idempotencyKey);
  return "sent";
}
