import type { NcLocale, NotificationType } from "./notification.types";
import { NC_SUPPORTED_LOCALES } from "./notification.types";

/** Closed server-owned (type × locale) title map — 10.10 §7. */
const TITLE_MAP: Record<NotificationType, Record<NcLocale, string>> = {
  order_confirmed: {
    de: "Ihre Bestellung wurde bestätigt",
    en: "Your order was confirmed",
    ar: "تم تأكيد طلبك",
  },
  shipped: {
    de: "Ihre Bestellung wurde versandt",
    en: "Your order was shipped",
    ar: "تم شحن طلبك",
  },
  delivered: {
    de: "Ihre Bestellung wurde zugestellt",
    en: "Your order was delivered",
    ar: "تم تسليم طلبك",
  },
  invoice: {
    de: "Ihre Rechnung wurde ausgestellt",
    en: "Your invoice was issued",
    ar: "تم إصدار فاتورتك",
  },
  refund: {
    de: "Ihre Erstattung wurde ausgeführt",
    en: "Your refund was completed",
    ar: "تم تنفيذ الاسترداد",
  },
  return: {
    de: "Ihre Rücksendung wurde angefordert",
    en: "Your return was requested",
    ar: "تم استلام طلب الإرجاع",
  },
};

export function resolveNcLocale(raw: string | null | undefined): NcLocale {
  if (raw && (NC_SUPPORTED_LOCALES as readonly string[]).includes(raw)) {
    return raw as NcLocale;
  }
  return "de";
}

export function notificationTitle(type: NotificationType, locale: NcLocale): string {
  return TITLE_MAP[type][locale];
}
