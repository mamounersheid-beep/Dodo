import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { InventoryService } from "./inventory.service";

@ApiTags("inventory")
@Controller("inventory")
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}
  @Get("_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }
}
