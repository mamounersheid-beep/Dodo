/**
 * Test-only capture for EMAIL_INTEGRATION stub (Unit 1+ / Auth acceptance tests).
 */
import type { EnqueueAuthEmailInput } from "./integrations/email/email-integration.port";

export type CapturedAuthEmail = EnqueueAuthEmailInput & { capturedAt: Date };

const captures: CapturedAuthEmail[] = [];

export function captureAuthEmail(input: EnqueueAuthEmailInput): void {
  captures.push({ ...input, capturedAt: new Date() });
}

export function clearAuthEmailCaptures(): void {
  captures.length = 0;
}

export function lastPasswordResetRawToken(): string | undefined {
  for (let i = captures.length - 1; i >= 0; i--) {
    const row = captures[i];
    if (row?.template === "password_reset") return row.rawToken;
  }
  return undefined;
}

export function passwordResetCaptureCount(): number {
  return captures.filter((c) => c.template === "password_reset").length;
}

export function lastEmailVerifyRawToken(): string | undefined {
  for (let i = captures.length - 1; i >= 0; i--) {
    const row = captures[i];
    if (row?.template === "email_verify") return row.rawToken;
  }
  return undefined;
}

export function emailVerifyCaptureCount(): number {
  return captures.filter((c) => c.template === "email_verify").length;
}

export function lastEmailChangeCapture(): CapturedAuthEmail | undefined {
  for (let i = captures.length - 1; i >= 0; i--) {
    const row = captures[i];
    if (row?.template === "email_change") return row;
  }
  return undefined;
}

export function lastEmailChangeRawToken(): string | undefined {
  return lastEmailChangeCapture()?.rawToken;
}
