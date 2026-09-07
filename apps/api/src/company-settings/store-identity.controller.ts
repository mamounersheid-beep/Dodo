import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CompanySettingsService } from "./company-settings.service";

@ApiTags("store-identity")
@Controller("store")
export class StoreIdentityController {
  constructor(private readonly svc: CompanySettingsService) {}

  @Get("identity")
  getIdentity() {
    return this.svc.getPublicIdentity();
  }
}
