import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminHttpIdempotencyCleanupRunner } from "./admin-http-idempotency.cleanup.runner";
import { AdminHttpIdempotencyService } from "./admin-http-idempotency.service";

@Module({
  imports: [PrismaModule],
  providers: [AdminHttpIdempotencyService, AdminHttpIdempotencyCleanupRunner],
  exports: [AdminHttpIdempotencyService],
})
export class AdminHttpIdempotencyModule {}
