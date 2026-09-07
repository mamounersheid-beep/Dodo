import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { AuditService } from "./audit.service";

@ApiTags("audit")
@Controller("audit")
export class AuditController {
  constructor(private readonly svc: AuditService) {}
  @Get("_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }
}
