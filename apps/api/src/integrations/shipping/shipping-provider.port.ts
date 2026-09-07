/** Shipping provider abstraction — workflow stays in W1; DHL is first adapter (Execute Ergänzung). */

export type CreateShipmentInput = {
  orderId: string;
  shipmentId: string;
  weightGrams: number;
  recipient: {
    name: string;
    line1: string;
    line2?: string | null;
    postalCode: string;
    city: string;
    countryCode: string;
  };
};

export type CreateShipmentResult = {
  provider: string;
  providerShipmentId: string;
  trackingNumber?: string;
  trackingUrl?: string;
  labelObjectKey?: string;
};

export type CreateReturnLabelInput = {
  returnId: string;
  originalProviderShipmentId?: string;
  recipient: CreateShipmentInput["recipient"];
};

export type CreateReturnLabelResult = {
  provider: string;
  providerReturnId: string;
  trackingNumber?: string;
  trackingUrl?: string;
  labelObjectKey?: string;
};

export interface ShippingProviderPort {
  readonly providerCode: string;
  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  createReturnLabel(input: CreateReturnLabelInput): Promise<CreateReturnLabelResult>;
  cancelShipment(providerShipmentId: string): Promise<void>;
}

export const SHIPPING_PROVIDER = Symbol("SHIPPING_PROVIDER");
export const SHIPPING_PROVIDER_REGISTRY = Symbol("SHIPPING_PROVIDER_REGISTRY");
