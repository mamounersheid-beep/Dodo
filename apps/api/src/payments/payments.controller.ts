import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { PaymentsService } from "./payments.service";

@ApiTags("payments")
@Controller("payments")
export class PaymentsController {
  constructor(private readonly svc: PaymentsService) {}

  @Get("_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }

  /** Provider webhook — signature only. No JWT / guest / checkout-key auth. */
  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: IncomingHttpHeaders,
  ) {
    const raw = req.rawBody;
    if (!raw || raw.length === 0) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "Empty webhook body",
      });
    }
    await this.svc.handleWebhook(headers, raw);
    return {};
  }
}
