import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { BonusPlusService } from "./bonus-plus.service";

@ApiTags("bonus-plus")
@Controller("bonus")
export class BonusPlusController {
  constructor(private readonly svc: BonusPlusService) {}
  @Get("_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }
}
