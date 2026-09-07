import { Injectable, NotImplementedException } from "@nestjs/common";
import type {
  CreateReturnLabelInput,
  CreateReturnLabelResult,
  CreateShipmentInput,
  CreateShipmentResult,
  ShippingProviderPort,
} from "../shipping-provider.port";

/**
 * DHL adapter stub — 10.12 / W1 call this via registry, not Order workflow directly.
 * Use DHL Group API (not legacy cig.dhl.de) when implementing labels/returns.
 */
@Injectable()
export class DhlShippingProvider implements ShippingProviderPort {
  readonly providerCode = "dhl";

  createShipment(_input: CreateShipmentInput): Promise<CreateShipmentResult> {
    throw new NotImplementedException({
      error: "NOT_IMPLEMENTED",
      message: "DHL shipment creation is wired for 10.12 — not 10.1",
    });
  }

  createReturnLabel(_input: CreateReturnLabelInput): Promise<CreateReturnLabelResult> {
    throw new NotImplementedException({
      error: "NOT_IMPLEMENTED",
      message: "DHL return label is wired for 10.12/W4 — not 10.1",
    });
  }

  async cancelShipment(_providerShipmentId: string): Promise<void> {
    throw new NotImplementedException({
      error: "NOT_IMPLEMENTED",
      message: "DHL cancel is wired for 10.12 — not 10.1",
    });
  }
}
