import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { CatalogModule } from "./catalog/catalog.module";
import { InventoryModule } from "./inventory/inventory.module";
import { CartModule } from "./cart/cart.module";
import { AuditModule } from "./audit/audit.module";
import { EMAIL_INTEGRATION } from "./integrations/email/email-integration.port";
import { createEmailIntegrationStub } from "./integrations/email/email-integration.stub";

/** Mutable counters for Slice 3b side-effect assertions. */
export const cart3bEmailCalls = {
  auth: 0,
  orderConfirmation: 0,
  reset() {
    this.auth = 0;
    this.orderConfirmation = 0;
  },
};

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_INTEGRATION,
      useValue: createEmailIntegrationStub({
        enqueueAuthEmail: async () => {
          cart3bEmailCalls.auth += 1;
        },
        enqueueOrderConfirmation: async () => {
          cart3bEmailCalls.orderConfirmation += 1;
        },
      }),
    },
  ],
  exports: [EMAIL_INTEGRATION],
})
class Cart3bEmailStubModule {}

/**
 * Narrow Nest app for Cart Slice 3b HTTP acceptance (no Redis/email worker).
 */
@Module({
  imports: [
    Cart3bEmailStubModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 500 }]),
    PrismaModule,
    AuditModule,
    AuthModule,
    CatalogModule,
    InventoryModule,
    CartModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class Cart3bTestAppModule {}
