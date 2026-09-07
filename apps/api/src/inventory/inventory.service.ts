import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  CHECKOUT_RESERVATION_TTL_MS,
  InventoryError,
  StockMovementReason,
  UNPAID_ORDER_TTL_MS,
  V1_LOCATION_CODE,
  cancelRestockReferenceId,
} from "./inventory.constants";

type Tx = Parameters<Parameters<PrismaService["$transaction"]>[0]>[0];

function isActiveReservationFilter(now: Date) {
  return {
    releasedAt: null as null,
    convertedAt: null as null,
    expiresAt: { gt: now },
  };
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  skeleton() {
    return { module: "inventory", ready: true, commerce: false };
  }

  /** Resolve V1 single active location MAIN. */
  async resolveMainLocationId(tx?: Tx): Promise<string> {
    const db = tx ?? this.prisma;
    const loc = await db.location.findFirst({
      where: { code: V1_LOCATION_CODE, isActive: true },
      select: { id: true },
    });
    if (!loc) {
      throw new NotFoundException({
        error: InventoryError.LOCATION_NOT_FOUND,
        message: `Active location ${V1_LOCATION_CODE} not found`,
      });
    }
    return loc.id;
  }

  /**
   * available = quantityOnHand − Σ(active reservation quantities)
   * active = releasedAt IS NULL ∧ convertedAt IS NULL ∧ expiresAt > now()
   */
  async available(variantId: string, locationId: string, tx?: Tx): Promise<number> {
    const db = tx ?? this.prisma;
    const inv = await db.inventory.findUnique({
      where: { locationId_variantId: { locationId, variantId } },
      select: { quantityOnHand: true },
    });
    if (!inv) {
      throw new NotFoundException({
        error: InventoryError.INVENTORY_NOT_FOUND,
        message: "Inventory row not found",
      });
    }
    const reserved = await this.sumActiveReserved(db, variantId, locationId);
    return inv.quantityOnHand - reserved;
  }

  /** stockOK = available ≥ qty */
  async stockOK(variantId: string, locationId: string, qty: number, tx?: Tx): Promise<boolean> {
    if (!Number.isInteger(qty) || qty <= 0) return false;
    const avail = await this.available(variantId, locationId, tx);
    return avail >= qty;
  }

  /**
   * Hybrid phase 1 — short lock (~15min).
   * Concurrent-safe via Inventory row FOR UPDATE.
   * Same (checkoutKey, variantId, locationId) updates the existing row.
   */
  async reserve(
    checkoutKey: string,
    variantId: string,
    locationId: string,
    qty: number,
  ): Promise<{ reservationId: string; quantity: number; expiresAt: Date; availableAfter: number }> {
    if (!checkoutKey?.trim()) {
      throw new ConflictException({
        error: InventoryError.INVALID_QUANTITY,
        message: "checkoutKey required",
      });
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new ConflictException({
        error: InventoryError.INVALID_QUANTITY,
        message: "quantity must be a positive integer",
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; quantityOnHand: number }>>`
        SELECT id, "quantityOnHand"
        FROM "Inventory"
        WHERE "locationId" = ${locationId} AND "variantId" = ${variantId}
        FOR UPDATE
      `;
      if (!locked.length) {
        throw new NotFoundException({
          error: InventoryError.INVENTORY_NOT_FOUND,
          message: "Inventory row not found",
        });
      }
      const onHand = locked[0].quantityOnHand;
      const now = new Date();

      const existing = await tx.reservation.findUnique({
        where: {
          checkoutKey_variantId_locationId: { checkoutKey, variantId, locationId },
        },
      });

      const activeOthers = await this.sumActiveReserved(tx, variantId, locationId, {
        excludeReservationId:
          existing &&
          existing.releasedAt == null &&
          existing.convertedAt == null &&
          existing.expiresAt > now
            ? existing.id
            : undefined,
      });

      const room = onHand - activeOthers;
      if (qty > room) {
        throw new ConflictException({
          error: InventoryError.INSUFFICIENT_STOCK,
          message: "Insufficient available stock",
          available: room,
        });
      }

      if (existing?.convertedAt) {
        throw new ConflictException({
          error: InventoryError.RESERVATION_NOT_ACTIVE,
          message: "Reservation already converted; cannot reserve with same checkoutKey",
        });
      }

      const expiresAt = new Date(now.getTime() + CHECKOUT_RESERVATION_TTL_MS);

      const row = existing
        ? await tx.reservation.update({
            where: { id: existing.id },
            data: {
              quantity: qty,
              expiresAt,
              releasedAt: null,
              convertedAt: null,
              orderId: null,
              checkoutKey,
            },
          })
        : await tx.reservation.create({
            data: {
              checkoutKey,
              variantId,
              locationId,
              quantity: qty,
              expiresAt,
            },
          });

      const availableAfter = onHand - (await this.sumActiveReserved(tx, variantId, locationId));
      return {
        reservationId: row.id,
        quantity: row.quantity,
        expiresAt: row.expiresAt,
        availableAfter,
      };
    });
  }

  /**
   * Release active reservations for checkoutKey — sets releasedAt only.
   * MUST NOT change quantityOnHand or write StockMovement.
   * Hybrid phase 1 / pre-bind only (after bind checkoutKey is cleared).
   */
  async release(checkoutKey: string): Promise<{ releasedCount: number }> {
    if (!checkoutKey?.trim()) {
      throw new ConflictException({
        error: InventoryError.INVALID_QUANTITY,
        message: "checkoutKey required",
      });
    }
    const now = new Date();
    const result = await this.prisma.reservation.updateMany({
      where: {
        checkoutKey,
        ...isActiveReservationFilter(now),
      },
      data: { releasedAt: now },
    });
    return { releasedCount: result.count };
  }

  /**
   * Order-bound release (after bind) — SoT release(orderId).
   * Sets releasedAt on non-converted reservations for the order.
   * Includes already time-expired rows still missing releasedAt.
   * MUST NOT change quantityOnHand or write StockMovement.
   */
  async releaseByOrderId(
    orderId: string,
    tx?: Tx,
  ): Promise<{ releasedCount: number }> {
    if (!orderId?.trim()) {
      throw new ConflictException({
        error: InventoryError.INVALID_QUANTITY,
        message: "orderId required",
      });
    }

    const run = async (db: Tx) => {
      const now = new Date();
      const result = await db.reservation.updateMany({
        where: {
          orderId,
          releasedAt: null,
          convertedAt: null,
        },
        data: { releasedAt: now },
      });
      return { releasedCount: result.count };
    };

    if (tx) return run(tx);
    return this.prisma.$transaction(run);
  }

  /**
   * §7a / P9 — order-bound reserve for payment retry (not checkoutKey / phase 1).
   * Rows: orderId set · checkoutKey NULL · expiresAt = unpaid window end.
   * Concurrent-safe via Inventory row FOR UPDATE. Upserts per (orderId, variant, location).
   */
  async reserveForOrder(
    orderId: string,
    lines: Array<{ variantId: string; quantity: number }>,
    expiresAt: Date,
    tx: Tx,
  ): Promise<{ reservationIds: string[] }> {
    if (!orderId?.trim()) {
      throw new ConflictException({
        error: InventoryError.INVALID_QUANTITY,
        message: "orderId required",
      });
    }
    const now = new Date();
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
      throw new ConflictException({
        error: InventoryError.RESERVATION_NOT_ACTIVE,
        message: "Order unpaid reservation window has expired",
      });
    }

    const locationId = await this.resolveMainLocationId(tx);
    const sorted = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
    const reservationIds: string[] = [];

    for (const line of sorted) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new ConflictException({
          error: InventoryError.INVALID_QUANTITY,
          message: "quantity must be a positive integer",
        });
      }

      const locked = await tx.$queryRaw<Array<{ id: string; quantityOnHand: number }>>`
        SELECT id, "quantityOnHand"
        FROM "Inventory"
        WHERE "locationId" = ${locationId} AND "variantId" = ${line.variantId}
        FOR UPDATE
      `;
      if (!locked.length) {
        throw new NotFoundException({
          error: InventoryError.INVENTORY_NOT_FOUND,
          message: "Inventory row not found",
        });
      }
      const onHand = locked[0].quantityOnHand;

      const existing = await tx.reservation.findFirst({
        where: {
          orderId,
          variantId: line.variantId,
          locationId,
          convertedAt: null,
        },
        orderBy: { id: "asc" },
      });

      const activeExcludeId =
        existing &&
        existing.releasedAt == null &&
        existing.convertedAt == null &&
        existing.expiresAt > now
          ? existing.id
          : undefined;

      const activeOthers = await this.sumActiveReserved(tx, line.variantId, locationId, {
        excludeReservationId: activeExcludeId,
      });
      const room = onHand - activeOthers;
      if (line.quantity > room) {
        throw new ConflictException({
          error: InventoryError.INSUFFICIENT_STOCK,
          message: "Insufficient available stock",
          available: room,
        });
      }

      const row = existing
        ? await tx.reservation.update({
            where: { id: existing.id },
            data: {
              quantity: line.quantity,
              expiresAt,
              releasedAt: null,
              convertedAt: null,
              orderId,
              checkoutKey: null,
            },
          })
        : await tx.reservation.create({
            data: {
              orderId,
              checkoutKey: null,
              variantId: line.variantId,
              locationId,
              quantity: line.quantity,
              expiresAt,
            },
          });

      reservationIds.push(row.id);
    }

    return { reservationIds };
  }

  /**
   * Admin adjust — delta to quantityOnHand + StockMovement(adjust) + AuditLog (same Tx).
   * Rejects resulting negative on-hand.
   */
  async adjust(input: {
    variantId: string;
    locationId?: string;
    delta: number;
    actorId: string;
  }): Promise<{ inventoryId: string; quantityOnHand: number; movementId: string }> {
    if (!Number.isInteger(input.delta) || input.delta === 0) {
      throw new ConflictException({
        error: InventoryError.INVALID_QUANTITY,
        message: "delta must be a non-zero integer",
      });
    }
    if (!input.actorId?.trim()) {
      throw new ConflictException({
        error: InventoryError.INVALID_QUANTITY,
        message: "actorId required",
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const locationId = input.locationId ?? (await this.resolveMainLocationId(tx));
      const locked = await tx.$queryRaw<Array<{ id: string; quantityOnHand: number }>>`
        SELECT id, "quantityOnHand"
        FROM "Inventory"
        WHERE "locationId" = ${locationId} AND "variantId" = ${input.variantId}
        FOR UPDATE
      `;
      if (!locked.length) {
        throw new NotFoundException({
          error: InventoryError.INVENTORY_NOT_FOUND,
          message: "Inventory row not found",
        });
      }
      const before = locked[0].quantityOnHand;
      const after = before + input.delta;
      if (after < 0) {
        throw new ConflictException({
          error: InventoryError.ADJUST_NEGATIVE_ON_HAND,
          message: "adjust would make quantityOnHand negative",
          available: before,
        });
      }

      await tx.inventory.update({
        where: { id: locked[0].id },
        data: { quantityOnHand: after },
      });
      const movement = await tx.stockMovement.create({
        data: {
          inventoryId: locked[0].id,
          delta: input.delta,
          reason: StockMovementReason.ADJUST,
          actorId: input.actorId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorType: "ADMIN",
          actorId: input.actorId,
          action: "inventory.adjust",
          entityType: "Inventory",
          entityId: locked[0].id,
          beforeJson: { quantityOnHand: before, variantId: input.variantId, locationId },
          afterJson: {
            quantityOnHand: after,
            variantId: input.variantId,
            locationId,
            delta: input.delta,
            movementId: movement.id,
          },
        },
      });

      return {
        inventoryId: locked[0].id,
        quantityOnHand: after,
        movementId: movement.id,
      };
    });
  }

  /**
   * R2.2-B — restock from prior sale movements.
   * Durable once-only: EXISTS StockMovement(orderId, reason=cancel_restock).
   * Logical name restock:cancel:{orderId} may be stored on referenceId (not the marker).
   * Does not transition Order — caller (Orders) owns CANCELLED in the same Tx.
   */
  async cancelRestock(
    orderId: string,
    tx?: Tx,
    opts?: { actorId?: string },
  ): Promise<{ restockedQuantity: number; idempotent: boolean; movementIds: string[] }> {
    if (!orderId?.trim()) {
      throw new ConflictException({
        error: InventoryError.INVALID_QUANTITY,
        message: "orderId required",
      });
    }

    const run = async (db: Tx) => {
      const prior = await db.stockMovement.findMany({
        where: { orderId, reason: StockMovementReason.CANCEL_RESTOCK },
        select: { id: true, delta: true },
      });
      if (prior.length > 0) {
        return {
          restockedQuantity: prior.reduce((s, m) => s + m.delta, 0),
          idempotent: true,
          movementIds: prior.map((m) => m.id),
        };
      }

      const sales = await db.stockMovement.findMany({
        where: { orderId, reason: StockMovementReason.SALE },
        select: { inventoryId: true, delta: true },
      });

      const byInv = new Map<string, number>();
      for (const s of sales) {
        // sale deltas are negative; restock qty = −delta
        byInv.set(s.inventoryId, (byInv.get(s.inventoryId) ?? 0) + -s.delta);
      }

      const inventoryIds = [...byInv.keys()].sort();
      const movementIds: string[] = [];
      let restockedQuantity = 0;
      const refId = cancelRestockReferenceId(orderId);

      for (const inventoryId of inventoryIds) {
        const qty = byInv.get(inventoryId)!;
        if (qty <= 0) continue;
        const locked = await db.$queryRaw<Array<{ id: string; quantityOnHand: number }>>`
          SELECT id, "quantityOnHand"
          FROM "Inventory"
          WHERE id = ${inventoryId}
          FOR UPDATE
        `;
        if (!locked.length) {
          throw new NotFoundException({
            error: InventoryError.INVENTORY_NOT_FOUND,
            message: "Inventory row not found",
          });
        }
        await db.inventory.update({
          where: { id: inventoryId },
          data: { quantityOnHand: { increment: qty } },
        });
        const mov = await db.stockMovement.create({
          data: {
            inventoryId,
            delta: qty,
            reason: StockMovementReason.CANCEL_RESTOCK,
            orderId,
            actorId: opts?.actorId,
            referenceType: "Order",
            referenceId: refId,
          },
        });
        movementIds.push(mov.id);
        restockedQuantity += qty;
      }

      return { restockedQuantity, idempotent: false, movementIds };
    };

    if (tx) return run(tx);
    return this.prisma.$transaction(run);
  }

  /**
   * Return restock service — StockMovement(return) only when ReturnItem.restock === true.
   * No silent restock when restock is false. Idempotent per returnItemId (referenceId).
   */
  async applyReturnRestock(
    lines: Array<{
      returnItemId: string;
      variantId: string;
      quantity: number;
      restock: boolean;
    }>,
    opts?: { orderId?: string; actorId?: string; locationId?: string; tx?: Tx },
  ): Promise<{ restockedLines: number; skippedLines: number; movementIds: string[] }> {
    const run = async (db: Tx) => {
      const locationId = opts?.locationId ?? (await this.resolveMainLocationId(db));
      let restockedLines = 0;
      let skippedLines = 0;
      const movementIds: string[] = [];

      for (const line of lines) {
        if (!line.restock) {
          skippedLines += 1;
          continue;
        }
        if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
          throw new ConflictException({
            error: InventoryError.INVALID_QUANTITY,
            message: "return restock quantity must be a positive integer",
          });
        }

        const existing = await db.stockMovement.findFirst({
          where: {
            reason: StockMovementReason.RETURN,
            referenceId: line.returnItemId,
          },
          select: { id: true },
        });
        if (existing) {
          movementIds.push(existing.id);
          restockedLines += 1;
          continue;
        }

        const locked = await db.$queryRaw<Array<{ id: string; quantityOnHand: number }>>`
          SELECT id, "quantityOnHand"
          FROM "Inventory"
          WHERE "locationId" = ${locationId} AND "variantId" = ${line.variantId}
          FOR UPDATE
        `;
        if (!locked.length) {
          throw new NotFoundException({
            error: InventoryError.INVENTORY_NOT_FOUND,
            message: "Inventory row not found",
          });
        }

        await db.inventory.update({
          where: { id: locked[0].id },
          data: { quantityOnHand: { increment: line.quantity } },
        });
        const mov = await db.stockMovement.create({
          data: {
            inventoryId: locked[0].id,
            delta: line.quantity,
            reason: StockMovementReason.RETURN,
            orderId: opts?.orderId,
            actorId: opts?.actorId,
            referenceType: "ReturnItem",
            referenceId: line.returnItemId,
          },
        });
        movementIds.push(mov.id);
        restockedLines += 1;
      }

      return { restockedLines, skippedLines, movementIds };
    };

    if (opts?.tx) return run(opts.tx);
    return this.prisma.$transaction(run);
  }

  /**
   * Hybrid phase 2 — bind checkoutKey → orderId for later placeOrder Tx.
   * Extends expiresAt to now + UNPAID_ORDER_TTL (48h) · clears checkoutKey.
   * No sale / convert / quantityOnHand change.
   */
  async bind(
    checkoutKey: string,
    orderId: string,
    tx?: Tx,
  ): Promise<{ boundCount: number; expiresAt: Date }> {
    if (!checkoutKey?.trim() || !orderId?.trim()) {
      throw new ConflictException({
        error: InventoryError.INVALID_QUANTITY,
        message: "checkoutKey and orderId required",
      });
    }

    const run = async (db: Tx) => {
      const now = new Date();
      const active = await db.reservation.findMany({
        where: {
          checkoutKey,
          ...isActiveReservationFilter(now),
        },
      });
      if (active.length === 0) {
        throw new NotFoundException({
          error: InventoryError.RESERVATION_NOT_FOUND,
          message: "No active reservation for checkoutKey",
        });
      }

      const expiresAt = new Date(now.getTime() + UNPAID_ORDER_TTL_MS);

      for (const row of active) {
        await db.reservation.update({
          where: { id: row.id },
          data: {
            orderId,
            expiresAt,
            checkoutKey: null,
          },
        });
      }

      return { boundCount: active.length, expiresAt };
    };

    if (tx) return run(tx);
    return this.prisma.$transaction(run);
  }

  /**
   * Convert order-bound active reservations into a sale.
   * One transaction: convertedAt + decrement quantityOnHand + StockMovement reason=sale.
   * No partial convert · no negative on-hand · already-converted does not write again.
   */
  async convert(orderId: string, tx?: Tx): Promise<{ convertedCount: number }> {
    if (!orderId?.trim()) {
      throw new ConflictException({
        error: InventoryError.INVALID_QUANTITY,
        message: "orderId required",
      });
    }

    const run = async (db: Tx) => {
      const now = new Date();
      const rows = await db.reservation.findMany({
        where: { orderId },
      });
      if (rows.length === 0) {
        throw new NotFoundException({
          error: InventoryError.RESERVATION_NOT_FOUND,
          message: "No reservation for orderId",
        });
      }

      const active = rows.filter(
        (r) => r.releasedAt == null && r.convertedAt == null && r.expiresAt > now,
      );
      if (active.length !== rows.length) {
        throw new ConflictException({
          error: InventoryError.RESERVATION_NOT_ACTIVE,
          message: "Reservation missing, released, expired, or already converted",
        });
      }

      const lockKeys = [...new Map(
        active.map((r) => [`${r.locationId}\0${r.variantId}`, { locationId: r.locationId, variantId: r.variantId }]),
      ).values()].sort((a, b) => {
        const loc = a.locationId.localeCompare(b.locationId);
        return loc !== 0 ? loc : a.variantId.localeCompare(b.variantId);
      });

      const lockedByPair = new Map<string, { id: string; quantityOnHand: number }>();
      for (const key of lockKeys) {
        const locked = await db.$queryRaw<Array<{ id: string; quantityOnHand: number }>>`
          SELECT id, "quantityOnHand"
          FROM "Inventory"
          WHERE "locationId" = ${key.locationId} AND "variantId" = ${key.variantId}
          FOR UPDATE
        `;
        if (!locked.length) {
          throw new NotFoundException({
            error: InventoryError.INVENTORY_NOT_FOUND,
            message: "Inventory row not found",
          });
        }
        lockedByPair.set(`${key.locationId}\0${key.variantId}`, locked[0]);
      }

      const afterLock = await db.reservation.findMany({
        where: { orderId },
      });
      const stillActive = afterLock.filter(
        (r) => r.releasedAt == null && r.convertedAt == null && r.expiresAt > now,
      );
      if (stillActive.length !== afterLock.length || stillActive.length !== active.length) {
        throw new ConflictException({
          error: InventoryError.RESERVATION_NOT_ACTIVE,
          message: "Reservation missing, released, expired, or already converted",
        });
      }

      const decrementByPair = new Map<string, number>();
      for (const r of stillActive) {
        const pair = `${r.locationId}\0${r.variantId}`;
        decrementByPair.set(pair, (decrementByPair.get(pair) ?? 0) + r.quantity);
      }
      for (const [pair, qty] of decrementByPair) {
        const locked = lockedByPair.get(pair);
        if (!locked) {
          throw new NotFoundException({
            error: InventoryError.INVENTORY_NOT_FOUND,
            message: "Inventory row not found",
          });
        }
        if (locked.quantityOnHand - qty < 0) {
          throw new ConflictException({
            error: InventoryError.INSUFFICIENT_STOCK,
            message: "Insufficient on-hand stock for convert",
            available: locked.quantityOnHand,
          });
        }
      }

      for (const r of stillActive) {
        const pair = `${r.locationId}\0${r.variantId}`;
        const locked = lockedByPair.get(pair)!;
        await db.reservation.update({
          where: { id: r.id },
          data: { convertedAt: now },
        });
        await db.inventory.update({
          where: { id: locked.id },
          data: { quantityOnHand: { decrement: r.quantity } },
        });
        await db.stockMovement.create({
          data: {
            inventoryId: locked.id,
            delta: -r.quantity,
            reason: StockMovementReason.SALE,
            orderId,
          },
        });
        locked.quantityOnHand -= r.quantity;
      }

      return { convertedCount: stillActive.length };
    };

    if (tx) return run(tx);
    return this.prisma.$transaction(run);
  }

  private async sumActiveReserved(
    db: Tx | PrismaService,
    variantId: string,
    locationId: string,
    opts?: { excludeReservationId?: string },
  ): Promise<number> {
    const now = new Date();
    const agg = await db.reservation.aggregate({
      where: {
        variantId,
        locationId,
        ...isActiveReservationFilter(now),
        ...(opts?.excludeReservationId ? { id: { not: opts.excludeReservationId } } : {}),
      },
      _sum: { quantity: true },
    });
    return agg._sum.quantity ?? 0;
  }
}
