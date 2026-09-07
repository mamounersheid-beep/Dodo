import { Body, Controller, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { OptionalJwtAuthGuard } from "../common/guards/optional-jwt-auth.guard";
import type { AuthUser } from "../auth/auth.types";
import { CONTACT_THROTTLE_LIMIT, CONTACT_THROTTLE_TTL_MS } from "./contact.constants";
import { ContactService } from "./contact.service";
import { CreateContactDto } from "./dto/create-contact.dto";

@ApiTags("contact")
@Controller("contact")
export class ContactController {
  constructor(@Inject(ContactService) private readonly svc: ContactService) {}

  @Post()
  @HttpCode(202)
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: CONTACT_THROTTLE_LIMIT, ttl: CONTACT_THROTTLE_TTL_MS } })
  submit(@Body() dto: CreateContactDto, @CurrentUser() user: AuthUser | undefined) {
    return this.svc.submit(
      {
        name: dto.name,
        email: dto.email,
        subject: dto.subject,
        message: dto.message,
        orderNumber: dto.orderNumber,
      },
      user,
    );
  }
}
