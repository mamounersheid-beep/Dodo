import type IORedis from "ioredis";

/** Runtime delivery mark — no Email table (10.10). Key = business idempotency key. */
export function authEmailDeliveredRedisKey(idempotencyKey: string): string {
  return `auth-email:delivered:${idempotencyKey}`;
}

export class RedisAuthEmailDeliveryStore {
  constructor(private readonly redis: IORedis) {}

  async wasDelivered(idempotencyKey: string): Promise<boolean> {
    const v = await this.redis.get(authEmailDeliveredRedisKey(idempotencyKey));
    return v != null;
  }

  /** Mark only after successful send. */
  async markDelivered(idempotencyKey: string): Promise<void> {
    await this.redis.set(authEmailDeliveredRedisKey(idempotencyKey), "1");
  }

  async clearDelivered(idempotencyKey: string): Promise<void> {
    await this.redis.del(authEmailDeliveredRedisKey(idempotencyKey));
  }
}
