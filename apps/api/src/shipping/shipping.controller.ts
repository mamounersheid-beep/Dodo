import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ShippingService } from "./shipping.service";

@ApiTags("shipping")
@Controller("shipping")
export class ShippingController {
  constructor(private readonly svc: ShippingService) {}
  @Get("_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }
}
