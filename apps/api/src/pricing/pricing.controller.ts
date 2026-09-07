import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { PricingService } from "./pricing.service";

@ApiTags("pricing")
@Controller("pricing")
export class PricingController {
  constructor(private readonly svc: PricingService) {}
  @Get("_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }
}
