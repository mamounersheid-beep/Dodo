import { Injectable } from "@nestjs/common";

@Injectable()
export class PricingService {
  skeleton() {
    return { module: "pricing", ready: true, commerce: false };
  }
}
