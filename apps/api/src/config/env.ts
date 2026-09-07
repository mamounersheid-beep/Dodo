import { z } from "zod";
import { durationToMs } from "./duration";

export { durationToMs };

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET min 16 chars"),
  JWT_REFRESH_SECRET: z.string().min(16).optional(),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  MEILI_HOST: z.string().default("http://localhost:7700"),
  MEILI_MASTER_KEY: z.string().optional(),
  API_CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000,http://localhost:3002")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  /** Empty = SMTP not live-configured (adapter uses stub transport). */
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  EMAIL_FROM: z.string().default("noreply@example.com"),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  PAYPAL_CLIENT_ID: z.string().default(""),
  PAYPAL_CLIENT_SECRET: z.string().default(""),
  PAYPAL_API_BASE: z.string().default(""),
  PAYPAL_RETURN_URL: z.string().default(""),
  PAYPAL_WEBHOOK_ID: z.string().default(""),
});

function loadEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment — refuse to start: ${msg}`);
  }
  return parsed.data;
}

export const env = loadEnv();

/** True when SMTP_HOST is set — live nodemailer path. Never logs credentials. */
export function isSmtpLiveConfigured(): boolean {
  return env.SMTP_HOST.trim().length > 0;
}
