/** Closed V1 Notification Center types — 10.10 §7. */
export const NOTIFICATION_TYPES = [
  "order_confirmed",
  "shipped",
  "delivered",
  "invoice",
  "refund",
  "return",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationDto = {
  id: string;
  type: NotificationType;
  title: string;
  occurredAt: string;
  deepLink: string;
  orderNumber: string;
};

export type NotificationsListResponse = {
  items: NotificationDto[];
  nextCursor: string | null;
};

export const NC_DEFAULT_LIMIT = 20;
export const NC_MAX_LIMIT = 50;

export const NC_SUPPORTED_LOCALES = ["de", "en", "ar"] as const;
export type NcLocale = (typeof NC_SUPPORTED_LOCALES)[number];
