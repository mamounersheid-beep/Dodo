import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { SHIPPING_PROVIDER_REGISTRY } from "../integrations/shipping/shipping-provider.port";
import type { ShippingProviderRegistry } from "../integrations/shipping/shipping-provider.registry";
import { PrismaService } from "../prisma/prisma.service";
import type { UpdateShippingRateTransitDaysDto } from "./dto/update-shipping-rate-transit-days.dto";

const TRANSIT_AUDIT_ACTION = "shipping.rate.estimated_transit_days.update";

@Injectable()
export class ShippingService {
  constructor(
    @Inject(SHIPPING_PROVIDER_REGISTRY)
    private readonly providers: ShippingProviderRegistry,
    private readonly prisma: PrismaService,
  ) {}

  skeleton() {
    return {
      module: "shipping",
      ready: true,
      step: "10.1",
      providers: this.providers.listCodes(),
      defaultProvider: "dhl",
    };
  }

  /**
   * Admin §12.9 — live Werktage transit on one ShippingRate.
   * Last-write-wins pair update. AuditLog only when values actually change.
   * Does not touch Order snapshots, processing days, 3g, or F5 schema.
   */
  async updateTransitDays(
    id: string,
    dto: UpdateShippingRateTransitDaysDto,
    actorId: string,
  ): Promise<{
    id: string;
    estimatedTransitDaysMin: number;
    estimatedTransitDaysMax: number;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.shippingRate.findUnique({
        where: { id },
        select: {
          id: true,
          estimatedTransitDaysMin: true,
          estimatedTransitDaysMax: true,
        },
      });
      if (!current) {
        throw new NotFoundException({
          error: "NOT_FOUND",
          message: "ShippingRate not found",
        });
      }

      const unchanged =
        current.estimatedTransitDaysMin === dto.estimatedTransitDaysMin &&
        current.estimatedTransitDaysMax === dto.estimatedTransitDaysMax;
      if (unchanged) {
        return {
          id: current.id,
          estimatedTransitDaysMin: current.estimatedTransitDaysMin,
          estimatedTransitDaysMax: current.estimatedTransitDaysMax,
        };
      }

      const updated = await tx.shippingRate.update({
        where: { id },
        data: {
          estimatedTransitDaysMin: dto.estimatedTransitDaysMin,
          estimatedTransitDaysMax: dto.estimatedTransitDaysMax,
        },
        select: {
          id: true,
          estimatedTransitDaysMin: true,
          estimatedTransitDaysMax: true,
        },
      });

      await tx.auditLog.create({
        data: {
          actorType: "ADMIN",
          actorId,
          action: TRANSIT_AUDIT_ACTION,
          entityType: "ShippingRate",
          entityId: id,
          beforeJson: {
            estimatedTransitDaysMin: current.estimatedTransitDaysMin,
            estimatedTransitDaysMax: current.estimatedTransitDaysMax,
          },
          afterJson: {
            estimatedTransitDaysMin: updated.estimatedTransitDaysMin,
            estimatedTransitDaysMax: updated.estimatedTransitDaysMax,
          },
        },
      });

      return updated;
    });
  }
}
