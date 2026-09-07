import { Injectable } from "@nestjs/common";
import { OrderStatus, RefundStatus } from "@dodo/database";
import type { AuthUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  compareNotificationKeys,
  decodeNotificationCursor,
  encodeNotificationCursor,
  isStrictlyAfterCursor,
  type NotificationCursorKey,
} from "./notification-cursor";
import { notificationTitle, resolveNcLocale } from "./notification-titles";
import {
  NC_DEFAULT_LIMIT,
  type NotificationDto,
  type NotificationType,
  type NotificationsListResponse,
} from "./notification.types";

type RawItem = NotificationCursorKey & {
  orderNumber: string;
};

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(
    user: AuthUser,
    opts: { limit?: number; cursor?: string },
  ): Promise<NotificationsListResponse> {
    const limit = opts.limit ?? NC_DEFAULT_LIMIT;
    const cursor = opts.cursor ? decodeNotificationCursor(opts.cursor) : null;
    const locale = resolveNcLocale(user.locale);

    const raw = await this.collectOwned(user.id);
    raw.sort(compareNotificationKeys);

    let filtered = raw;
    if (cursor) {
      filtered = raw.filter((item) => isStrictlyAfterCursor(item, cursor));
    }

    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    const items: NotificationDto[] = page.map((item) => ({
      id: item.id,
      type: item.type,
      title: notificationTitle(item.type, locale),
      occurredAt: item.occurredAt,
      deepLink: deepLinkFor(item.type, item.orderNumber),
      orderNumber: item.orderNumber,
    }));

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeNotificationCursor({
            occurredAt: last.occurredAt,
            type: last.type,
            id: last.id,
          })
        : null;

    return { items, nextCursor };
  }

  private async collectOwned(userId: string): Promise<RawItem[]> {
    const orders = await this.prisma.order.findMany({
      where: { userId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        placedAt: true,
        deliveredAt: true,
        invoices: {
          where: { status: { in: ["issued", "cancelled_by_credit_note"] } },
          select: { id: true, issuedAt: true },
        },
        shipments: {
          where: { shippedAt: { not: null } },
          select: { id: true, shippedAt: true },
        },
        refunds: {
          where: { status: RefundStatus.SUCCEEDED },
          select: { id: true, completedAt: true, createdAt: true },
        },
        returns: {
          select: { id: true, createdAt: true },
        },
      },
    });

    const out: RawItem[] = [];

    for (const order of orders) {
      out.push({
        type: "order_confirmed",
        id: `order_confirmed:${order.id}`,
        occurredAt: order.placedAt.toISOString(),
        orderNumber: order.orderNumber,
      });

      if (order.status === OrderStatus.DELIVERED && order.deliveredAt) {
        out.push({
          type: "delivered",
          id: `delivered:${order.id}`,
          occurredAt: order.deliveredAt.toISOString(),
          orderNumber: order.orderNumber,
        });
      }

      for (const inv of order.invoices) {
        out.push({
          type: "invoice",
          id: `invoice:${inv.id}`,
          occurredAt: inv.issuedAt.toISOString(),
          orderNumber: order.orderNumber,
        });
      }

      for (const ship of order.shipments) {
        if (!ship.shippedAt) continue;
        out.push({
          type: "shipped",
          id: `shipped:${ship.id}`,
          occurredAt: ship.shippedAt.toISOString(),
          orderNumber: order.orderNumber,
        });
      }

      for (const refund of order.refunds) {
        const at = refund.completedAt ?? refund.createdAt;
        out.push({
          type: "refund",
          id: `refund:${refund.id}`,
          occurredAt: at.toISOString(),
          orderNumber: order.orderNumber,
        });
      }

      for (const ret of order.returns) {
        out.push({
          type: "return",
          id: `return:${ret.id}`,
          occurredAt: ret.createdAt.toISOString(),
          orderNumber: order.orderNumber,
        });
      }
    }

    return out;
  }
}

function deepLinkFor(type: NotificationType, orderNumber: string): string {
  switch (type) {
    case "order_confirmed":
    case "shipped":
    case "delivered":
    case "refund":
      return `/account/orders/${orderNumber}`;
    case "invoice":
      return "/account/invoices";
    case "return":
      return "/account/returns";
  }
}
