import { Module } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { PrismaModule } from "./prisma/prisma.module";
import { CommonModule } from "./common/common.module";
import { HealthModule } from "./health/health.module";
import { QueuesModule } from "./queues/queues.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { CatalogModule } from "./catalog/catalog.module";
import { InventoryModule } from "./inventory/inventory.module";
import { CartModule } from "./cart/cart.module";
import { PricingModule } from "./pricing/pricing.module";
import { ShippingModule } from "./shipping/shipping.module";
import { OrdersModule } from "./orders/orders.module";
import { PaymentsModule } from "./payments/payments.module";
import { AdminRefundModule } from "./payments/admin-refund.module";
import { InvoicesModule } from "./invoices/invoices.module";
import { ReturnsModule } from "./returns/returns.module";
import { BonusPlusModule } from "./bonus-plus/bonus-plus.module";
import { CmsLegalModule } from "./cms-legal/cms-legal.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { AuditModule } from "./audit/audit.module";
import { IntegrationModule } from "./integrations/integration.module";
import { CompanySettingsModule } from "./company-settings/company-settings.module";
import { ContactModule } from "./contact/contact.module";
import { AdminHttpIdempotencyModule } from "./admin-http-idempotency/admin-http-idempotency.module";
import { HomeModule } from "./home/home.module";

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    IntegrationModule,
    PrismaModule,
    CommonModule,
    QueuesModule,
    HealthModule,
    AuthModule,
    UsersModule,
    CatalogModule,
    InventoryModule,
    CartModule,
    PricingModule,
    ShippingModule,
    OrdersModule,
    PaymentsModule,
    AdminRefundModule,
    InvoicesModule,
    ReturnsModule,
    BonusPlusModule,
    CmsLegalModule,
    NotificationsModule,
    AuditModule,
    CompanySettingsModule,
    ContactModule,
    AdminHttpIdempotencyModule,
    HomeModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
