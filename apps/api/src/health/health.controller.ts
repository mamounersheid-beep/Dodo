import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { HealthService } from "./health.service";
import { SkipThrottle } from "@nestjs/throttler";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @SkipThrottle()
  @ApiOkResponse({ description: "Liveness" })
  live() {
    return { status: "ok", service: "dodo-api", step: 9 };
  }

  @Get("ready")
  @SkipThrottle()
  @ApiOkResponse({ description: "Readiness: Postgres + Redis + Meilisearch" })
  async ready() {
    const result = await this.health.checkReady();
    if (!result.ready) {
      throw new ServiceUnavailableException({
        error: "NOT_READY",
        message: "Dependency check failed",
        details: result,
      });
    }
    return result;
  }
}
