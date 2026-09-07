import { Injectable } from "@nestjs/common";
import Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { env } from "../config/env";

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async checkReady() {
    const checks: Record<string, "up" | "down"> = {
      postgres: "down",
      redis: "down",
      meilisearch: "down",
    };

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.postgres = "up";
    } catch {
      checks.postgres = "down";
    }

    const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    try {
      await redis.connect();
      const pong = await redis.ping();
      checks.redis = pong === "PONG" ? "up" : "down";
    } catch {
      checks.redis = "down";
    } finally {
      redis.disconnect();
    }

    try {
      const headers: Record<string, string> = {};
      if (env.MEILI_MASTER_KEY) headers.Authorization = `Bearer ${env.MEILI_MASTER_KEY}`;
      const res = await fetch(`${env.MEILI_HOST}/health`, { headers });
      checks.meilisearch = res.ok ? "up" : "down";
    } catch {
      checks.meilisearch = "down";
    }

    const ready = Object.values(checks).every((v) => v === "up");
    return { ready, status: ready ? "ok" : "degraded", checks, commerce: false, step: 9 };
  }
}
