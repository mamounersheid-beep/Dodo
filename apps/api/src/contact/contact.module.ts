import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OptionalJwtAuthGuard } from "../common/guards/optional-jwt-auth.guard";
import { ContactController } from "./contact.controller";
import { ContactService } from "./contact.service";

@Module({
  imports: [AuthModule],
  controllers: [ContactController],
  providers: [ContactService, OptionalJwtAuthGuard],
})
export class ContactModule {}
