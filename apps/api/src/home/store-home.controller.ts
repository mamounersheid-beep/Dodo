import { Controller, Get, Headers, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { HomeService } from "./home.service";

@ApiTags("store-home")
@Controller("store")
export class StoreHomeController {
  constructor(private readonly home: HomeService) {}

  @Get("home")
  getHome(
    @Query("locale") locale?: string,
    @Headers("accept-language") acceptLanguage?: string,
  ) {
    return this.home.getPublicHome({ locale, acceptLanguage });
  }
}
