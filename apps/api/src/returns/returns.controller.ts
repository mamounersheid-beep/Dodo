import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ReturnsService } from "./returns.service";

@ApiTags("returns")
@Controller("returns")
export class ReturnsController {
  constructor(private readonly svc: ReturnsService) {}
  @Get("_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }
}
