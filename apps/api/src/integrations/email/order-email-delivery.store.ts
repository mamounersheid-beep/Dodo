import type IORedis from "ioredis";

/**
 * Order Confirmation delivery mark — separate from Auth (`auth-email:delivered:*`).
 * Key = business work key `order-confirmation:{orderId}` (10.10 §2).
 */
export function orderConfirmationDeliveredRedisKey(idempotencyKey: string): string {
  return `order-email:delivered:${idempotencyKey}`;
}

export class RedisOrderEmailDeliveryStore {
  constructor(private readonly redis: IORedis) {}

  async wasDelivered(idempotencyKey: string): Promise<boolean> {
    const v = await this.redis.get(orderConfirmationDeliveredRedisKey(idempotencyKey));
    return v != null;
  }

  /** Mark only after successful send. */
  async markDelivered(idempotencyKey: string): Promise<void> {
    await this.redis.set(orderConfirmationDeliveredRedisKey(idempotencyKey), "1");
  }

  async clearDelivered(idempotencyKey: string): Promise<void> {
    await this.redis.del(orderConfirmationDeliveredRedisKey(idempotencyKey));
  }
}
