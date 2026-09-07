import { env } from "../../config/env";
import type { PrismaService } from "../../prisma/prisma.service";
import { buildOrderCancelledEmail } from "./order-cancelled.builder";
import type { EnqueueOrderCancelledInput } from "./email-integration.port";
import { resolveOrderCommunicationLocale } from "./email-integration.port";
import type { RedisOrderEmailDeliveryStore } from "./order-email-delivery.store";
import type { SmtpTransport } from "./smtp-transport.port";

export type OrderCancelledProcessResult = "sent" | "skipped";

/**
 * Idempotent order-cancelled processing (10.10 §4a / §3).
 * - Content from Order / OrderItem / seller snapshots only; locale = Order.locale.
 * - No guestAccessToken / no #16 link.
 * - Marks delivered only after successful SMTP send.
 * - Must not mutate Order / Payment / financial state.
 */
export async function processOrderCancelledJob(
  payload: EnqueueOrderCancelledInput,
  deps: {
    prisma: PrismaService;
    transport: SmtpTransport;
    delivery: RedisOrderEmailDeliveryStore;
  },
): Promise<OrderCancelledProcessResult> {
  if (await deps.delivery.wasDelivered(payload.idempotencyKey)) {
    return "skipped";
  }

  const order = await deps.prisma.order.findUnique({
    where: { id: payload.orderId },
    include: { items: true },
  });
  if (!order) {
    throw new Error(`order-cancelled: order not found id=${payload.orderId}`);
  }

  const locale = resolveOrderCommunicationLocale(order.locale);
  const built = buildOrderCancelledEmail({ order });

  if (built.communicationLocale !== locale) {
    throw new Error("order-cancelled: locale mismatch in builder");
  }

  if (built.text.includes("token=") || built.accessPath?.includes("token=")) {
    throw new Error("order-cancelled: guest token link forbidden");
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
