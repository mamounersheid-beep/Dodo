import { Injectable } from "@nestjs/common";
import type { ShippingProviderPort } from "./shipping-provider.port";

@Injectable()
export class ShippingProviderRegistry {
  private readonly providers = new Map<string, ShippingProviderPort>();

  register(provider: ShippingProviderPort): void {
    this.providers.set(provider.providerCode, provider);
  }

  get(code: string): ShippingProviderPort | undefined {
    return this.providers.get(code);
  }

  getDefault(): ShippingProviderPort | undefined {
    return this.providers.get("dhl");
  }

  listCodes(): string[] {
    return [...this.providers.keys()];
  }
}
