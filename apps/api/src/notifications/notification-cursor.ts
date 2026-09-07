import { BadRequestException } from "@nestjs/common";
import type { NotificationType } from "./notification.types";
import { NOTIFICATION_TYPES } from "./notification.types";

export type NotificationCursorKey = {
  occurredAt: string;
  type: NotificationType;
  id: string;
};

export function encodeNotificationCursor(key: NotificationCursorKey): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

export function decodeNotificationCursor(raw: string): NotificationCursorKey {
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new BadRequestException({
      error: "VALIDATION_ERROR",
      message: "Invalid cursor",
    });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new BadRequestException({
      error: "VALIDATION_ERROR",
      message: "Invalid cursor",
    });
  }
  const o = parsed as Record<string, unknown>;
  const occurredAt = o.occurredAt;
  const type = o.type;
  const id = o.id;
  if (
    typeof occurredAt !== "string" ||
    typeof type !== "string" ||
    typeof id !== "string" ||
    !(NOTIFICATION_TYPES as readonly string[]).includes(type) ||
    Number.isNaN(Date.parse(occurredAt))
  ) {
    throw new BadRequestException({
      error: "VALIDATION_ERROR",
      message: "Invalid cursor",
    });
  }
  return { occurredAt, type: type as NotificationType, id };
}

/** True if `item` sorts strictly after `cursor` under occurredAt DESC → type ASC → id ASC. */
export function isStrictlyAfterCursor(
  item: NotificationCursorKey,
  cursor: NotificationCursorKey,
): boolean {
  if (item.occurredAt < cursor.occurredAt) return true;
  if (item.occurredAt > cursor.occurredAt) return false;
  if (item.type > cursor.type) return true;
  if (item.type < cursor.type) return false;
  return item.id > cursor.id;
}

export function compareNotificationKeys(a: NotificationCursorKey, b: NotificationCursorKey): number {
  if (a.occurredAt !== b.occurredAt) {
    return a.occurredAt < b.occurredAt ? 1 : -1; // DESC
  }
  if (a.type !== b.type) {
    return a.type < b.type ? -1 : 1; // ASC
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1; // ASC
  }
  return 0;
}
