import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundStatus,
  ReturnRequestStatus,
  RoleCode,
  TaxMode,
} from "@dodo/database";
import {
  type CheckoutKeyIssueResponse,
  type ReleaseResponse,
  type ReserveResponse,
  type SupportedLocale,
} from "@dodo/shared-types";
import { PrismaService } from "../prisma/prisma.service";
import { InventoryService } from "../inventory/inventory.service";
import { InventoryError, UNPAID_ORDER_TTL_MS } from "../inventory/inventory.constants";
import { CartService } from "../cart/cart.service";
import { CartError } from "../cart/cart.types";
import type { AuthUser } from "../auth/auth.types";
import { hashToken, tokensEqual } from "../auth/crypto.util";
import { isLineSellable } from "../catalog/catalog.rules";
import { PaymentsService } from "../payments/payments.service";
import type { FirstAttemptClientPayload } from "../payments/first-intent.identity";
import {
  EMAIL_INTEGRATION,
  resolveOrderCommunicationLocale,
  type EmailIntegrationPort,
} from "../integrations/email/email-integration.port";
import {
  GUEST_ACCESS_REISSUE_AUDIT_ACTION,
  GUEST_ORDER_ACCESS_TTL_MS,
  ORDER_CONFIRMATION_RESEND_AUDIT_ACTION,
} from "./guest-access.constants";
import {
  PlaceOrderPreconditionError,
  REQUIRED_DE_LEGAL_SLUGS,
  type PlaceOrderPreconditionsInput,
  type PlaceOrderPreconditionsOk,
} from "./place-order-preconditions";
import type { PlaceOrderAddressDto, PlaceOrderDto } from "./dto/place-order.dto";
import {
  fingerprintFromDto,
  fingerprintsMatch,
  normalizeCouponCode,
} from "./place-order.fingerprint";

const STAFF: RoleCode[] = [RoleCode.SUPPORT, RoleCode.ADMIN, RoleCode.OWNER];

/** 10.10 §2a — Admin Resend eligible Order.status values. */
const RESEND_ELIGIBLE_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PLACED,
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
  OrderStatus.RETURN_REQUESTED,
  OrderStatus.RETURNED,
]);

/** G2-D — 32 CSPRNG bytes / 256 bits before unpadded base64url. */
const CHECKOUT_KEY_BYTES = 32;

const V1_SHIPPING_METHOD = "standard";
/** 10.2 / G3 label — en-dash, not ASCII hyphen. */
const WERKTAG_RANGE_DASH = "\u2013";
const G3_SOURCE_PROCESSING = "CompanySettings.orderProcessingDaysMin/Max";
const G3_SOURCE_TRANSIT = "ShippingRate.estimatedTransitDaysMin/Max";

type Tx = Parameters<Parameters<PrismaService["$transaction"]>[0]>[0];

const PlaceOrderError = {
  STORE_PAYMENT_METHOD_DISABLED: "STORE_PAYMENT_METHOD_DISABLED",
  IDEMPOTENCY_PAYLOAD_MISMATCH: "IDEMPOTENCY_PAYLOAD_MISMATCH",
  GUEST_EMAIL_REQUIRED: "VALIDATION_ERROR",
} as const;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    @Optional() private readonly payments?: PaymentsService,
    @Optional() private readonly cart?: CartService,
    @Optional() @Inject(EMAIL_INTEGRATION) private readonly email?: EmailIntegrationPort,
  ) {}

  skeleton() {
    return { module: "orders", ready: true, commerce: false };
  }

  /**
   * G2 issuance only — mint a new checkoutKey. No Reservation, no persist, no identity bind.
   */
  issueCheckoutKey(): CheckoutKeyIssueResponse {
    return {
      checkoutKey: randomBytes(CHECKOUT_KEY_BYTES).toString("base64url"),
    };
  }

  /**
   * Hybrid phase 1 consume — one line. checkoutKey already transport-validated.
   * locationId = V1 MAIN via InventoryService.resolveMainLocationId (not a request field).
   * Existing signature: reserve(checkoutKey, variantId, locationId, qty).
   */
  async reserveLine(
    checkoutKey: string,
    variantId: string,
    quantity: number,
  ): Promise<ReserveResponse> {
    const locationId = await this.inventory.resolveMainLocationId();
    const result = await this.inventory.reserve(checkoutKey, variantId, locationId, quantity);
    return {
      reservationId: result.reservationId,
      quantity: result.quantity,
      expiresAt: result.expiresAt.toISOString(),
      availableAfter: result.availableAfter,
    };
  }

  /**
   * Release all active reservations for checkoutKey. Zero active → releasedCount 0.
   */
  async releaseReservations(checkoutKey: string): Promise<ReleaseResponse> {
    return this.inventory.release(checkoutKey);
  }

  /**
   * Slice 1 — first barrier before any placeOrder DB transaction.
   * Read-only: no Order / Reservation / Payment / email side effects.
   */
  async assertPlaceOrderPreconditions(
    input: PlaceOrderPreconditionsInput,
  ): Promise<PlaceOrderPreconditionsOk> {
    const company = await this.prisma.companySettings.findUnique({
      where: { id: "default" },
      select: {
        checkoutEnabled: true,
        isKleinunternehmer: true,
      },
    });
    if (!company) {
      throw new ConflictException({
        error: PlaceOrderPreconditionError.STORE_SETTINGS_MISSING,
        message: "CompanySettings not configured",
      });
    }

    if (company.checkoutEnabled !== true) {
      throw new ConflictException({
        error: PlaceOrderPreconditionError.STORE_CHECKOUT_DISABLED,
        message: "Checkout is disabled",
      });
    }

    if (company.isKleinunternehmer !== true) {
      throw new ConflictException({
        error: PlaceOrderPreconditionError.L1_TAX_INCOMPLETE,
        message: "Tax incomplete (L1): Kleinunternehmer required for V1",
      });
    }

    const missing: string[] = [];
    for (const slug of REQUIRED_DE_LEGAL_SLUGS) {
      const page = await this.prisma.legalPage.findFirst({
        where: {
          slug,
          countryCode: "DE",
          publishedAt: { not: null },
          supersededAt: null,
        },
        select: { id: true },
      });
      if (!page) missing.push(slug);
    }
    if (missing.length > 0) {
      throw new ConflictException({
        error: PlaceOrderPreconditionError.REQUIRED_LEGAL_PAGES_MISSING,
        message: `Required published DE legal pages missing: ${missing.join(", ")}`,
        missing,
      });
    }

    if (input.shippingCountryCode !== "DE") {
      throw new ConflictException({
        error: PlaceOrderPreconditionError.SHIPPING_COUNTRY_NOT_DE,
        message: "Shipping country must be DE",
      });
    }

    return { ok: true };
  }

  /**
   * Production POST /v1/orders — G4 + §2a Tx. Payment Intent is not called here.
   */
  async placeOrder(input: {
    user?: AuthUser;
    guestKeyHeader?: string;
    checkoutKey: string;
    idempotencyKey: string;
    dto: PlaceOrderDto;
  }): Promise<{ id: string }> {
    if (!this.cart || !this.email) {
      throw new Error("OrdersService placeOrder requires CartService and EMAIL_INTEGRATION");
    }

    const userId = input.user?.id ?? null;
    const guestKey = userId ? null : (input.guestKeyHeader?.trim() || null);
    const isGuest = !userId;
    if (!userId && !guestKey) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "Registered session or x-guest-key required",
      });
    }
    if (isGuest && !input.dto.guestEmail) {
      throw new BadRequestException({
        error: PlaceOrderError.GUEST_EMAIL_REQUIRED,
        message: "guestEmail required for guest checkout",
      });
    }

    const existing = await this.findOrderByIdempotencyScope({
      userId,
      guestKey,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) {
      this.assertFingerprintOrConflict(existing, input.dto, isGuest);
      return { id: existing.id };
    }

    await this.assertPlaceOrderPreconditions({
      shippingCountryCode: input.dto.shippingAddressJson.countryCode,
    });
    this.assertPaymentMethodEnabled(await this.loadPaymentsEnabled(), input.dto.paymentMethodCode);

    const recalc = await this.cart.recalculate({
      user: input.user ?? null,
      guestKey: guestKey,
      shippingCountryCode: input.dto.shippingAddressJson.countryCode,
      couponCode: input.dto.couponCode,
      bonusPointsToRedeem: input.dto.bonusPointsToRedeem,
    });
    if (recalc.lines.length === 0) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "Cart has no items",
      });
    }
    const shippingTotal = recalc.shippingTotal;
    if (shippingTotal === undefined) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "Server recalculation omitted shippingTotal",
      });
    }

    const activeCount = await this.countActiveReservations(input.checkoutKey);
    if (activeCount === 0) {
      throw new ConflictException({
        error: InventoryError.RESERVATION_NOT_ACTIVE,
        message: "No active reservation for checkoutKey",
      });
    }

    const couponCode = normalizeCouponCode(input.dto.couponCode);
    const rawBonus =
      input.dto.bonusPointsToRedeem === undefined ? null : input.dto.bonusPointsToRedeem;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const raced = await this.findOrderByIdempotencyScope(
          { userId, guestKey, idempotencyKey: input.idempotencyKey },
          tx,
        );
        if (raced) {
          this.assertFingerprintOrConflict(raced, input.dto, isGuest);
          return { id: raced.id, locale: raced.locale, guestEmail: raced.guestEmail, replay: true as const };
        }

        const now = new Date();
        const company = await this.lockCompanySettings(tx);
        const orderNumber = this.formatOrderNumber(company.orderNextNumber, now);
        await tx.companySettings.update({
          where: { id: "default" },
          data: { orderNextNumber: company.orderNextNumber + 1 },
        });

        const legal = await this.loadLegalSnapshots(tx);
        const shippingSnap = await this.loadShippingSnapshots(tx);
        const locale = await this.resolveOrderLocale(userId, company.defaultLocale);
        const guestToken = isGuest ? randomBytes(32).toString("base64url") : null;
        const coupon = couponCode
          ? await tx.coupon.findUnique({ where: { code: couponCode } })
          : null;
        // G3 — live freeze at PLACED. Do not copy CartRecalcResponse.deliveryTime (3g preview).
        const deliveryTimeDisclosureSnapshot = this.buildDeliveryTimeDisclosureSnapshot({
          locale,
          processingMin: company.orderProcessingDaysMin,
          processingMax: company.orderProcessingDaysMax,
          transitMin: shippingSnap.estimatedTransitDaysMin,
          transitMax: shippingSnap.estimatedTransitDaysMax,
          shippingRateId: shippingSnap.rateId,
          shippingMethodCode: shippingSnap.methodCode,
        });

        const order = await tx.order.create({
          data: {
            orderNumber,
            idempotencyKey: input.idempotencyKey,
            userId,
            guestEmail: isGuest ? input.dto.guestEmail! : null,
            guestAccessTokenHash: guestToken ? hashToken(guestToken) : null,
            guestKey,
            status: OrderStatus.PLACED,
            paymentStatus: PaymentStatus.PENDING,
            currencyCode: "EUR",
            locale,
            shippingCountryCode: input.dto.shippingAddressJson.countryCode,
            taxMode: company.isKleinunternehmer ? TaxMode.KLEINUNTERNEHMER : TaxMode.VAT,
            companyIsKleinunternehmer: recalc.companyIsKleinunternehmer,
            invoiceExemptionTextSnapshot: recalc.exemptionText,
            sellerIdentitySnapshotJson: {
              legalName: company.legalName,
              line1: company.line1,
              postalCode: company.postalCode,
              city: company.city,
              countryCode: company.countryCode,
              supportEmail: company.supportEmail,
              supportPhone: company.supportPhone,
            },
            itemsSubtotal: new Prisma.Decimal(recalc.itemsSubtotal),
            shippingTotal: new Prisma.Decimal(shippingTotal),
            discountCoupon: new Prisma.Decimal(recalc.discountCoupon ?? "0.00"),
            discountBonus: new Prisma.Decimal(recalc.discountBonus ?? "0.00"),
            grandTotal: new Prisma.Decimal(recalc.grandTotal),
            shippingZoneId: shippingSnap.zoneId,
            shippingRateId: shippingSnap.rateId,
            shippingRateNameSnapshot: shippingSnap.rateName,
            shippingMethodCodeSnapshot: shippingSnap.methodCode,
            shippingStandardAmountSnapshot: shippingSnap.standardAmount,
            shippingAddressJson: this.toAddressJson(input.dto.shippingAddressJson),
            billingAddressJson: this.toAddressJson(input.dto.billingAddressJson),
            legalAgbVersionId: legal.agb.id,
            legalAgbHash: legal.agb.hash,
            legalWiderrufVersionId: legal.widerruf.id,
            legalWiderrufHash: legal.widerruf.hash,
            legalPrivacyVersionId: legal.privacy.id,
            legalPrivacyHash: legal.privacy.hash,
            acceptedAgbAt: now,
            acceptedWiderrufInfoAt: now,
            couponId: coupon?.id ?? null,
            couponCodeSnapshot: coupon?.code ?? null,
            couponTypeSnapshot: coupon?.type ?? null,
            couponValueSnapshot: coupon?.value ?? null,
            paymentMethodCodeSnapshot: input.dto.paymentMethodCode,
            bonusPointsToRedeem: rawBonus,
            bonusPointsRedeemed: recalc.bonusPointsToRedeem ?? 0,
            bonusDiscountAmount: new Prisma.Decimal(recalc.discountBonus ?? "0.00"),
            deliveryTimeDisclosureSnapshot:
              deliveryTimeDisclosureSnapshot === null
                ? Prisma.DbNull
                : deliveryTimeDisclosureSnapshot,
            placedAt: now,
            items: {
              create: await this.buildOrderItems(tx, recalc.lines),
            },
          },
          select: { id: true, locale: true, guestEmail: true },
        });

        if (coupon) {
          await this.insertCouponUsageC10(tx, {
            orderId: order.id,
            couponId: coupon.id,
            userId,
          });
        }

        try {
          await this.inventory.bind(input.checkoutKey, order.id, tx);
        } catch (e) {
          if (e instanceof NotFoundException) {
            throw new ConflictException({
              error: InventoryError.RESERVATION_NOT_ACTIVE,
              message: "No active reservation for checkoutKey",
            });
          }
          throw e;
        }

        return { ...order, replay: false as const, guestToken };
      });

      if (!created.replay) {
        await this.enqueueConfirmation(
          created.id,
          created.locale,
          created.guestEmail,
          userId,
          created.guestToken,
        );
      }
      return { id: created.id };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const again = await this.findOrderByIdempotencyScope({
          userId,
          guestKey,
          idempotencyKey: input.idempotencyKey,
        });
        if (again) {
          this.assertFingerprintOrConflict(again, input.dto, isGuest);
          return { id: again.id };
        }
      }
      throw e;
    }
  }

  /**
   * POST /v1/orders/:orderId/payment-intent
   * — First attempt (§7b/§7c/§7d/§7e Option B) when PLACED+PENDING+no FAILED
   * — §7 / §7a retry after FAILED (checkoutEnabled gated; order-bound reserve)
   */
  async createPaymentIntent(input: {
    orderId: string;
    user?: AuthUser;
    orderNumberHeader?: string;
    guestAccessTokenHeader?: string;
  }): Promise<FirstAttemptClientPayload> {
    const hasJwt = Boolean(input.user?.id);
    const orderNumber = input.orderNumberHeader?.trim() ?? "";
    const guestToken = input.guestAccessTokenHeader?.trim() ?? "";
    const hasGuestPair = orderNumber.length > 0 && guestToken.length > 0;
    if (!hasJwt && !hasGuestPair) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "Registered session or x-order-number and x-guest-access-token required",
      });
    }

    if (!this.payments) {
      throw new BadGatewayException({
        error: "INTERNAL_ERROR",
        message: "Payments module is not available",
      });
    }
    const payments = this.payments;

    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE
        `;
        if (locked.length === 0) {
          throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
        }

        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          include: { payments: true, items: true },
        });
        if (!order) {
          throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
        }

        if (hasJwt) {
          if (order.userId !== input.user!.id) {
            throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
          }
        } else {
          if (order.orderNumber !== orderNumber) {
            throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
          }
          if (!order.guestAccessTokenHash) {
            throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
          }
          if (!tokensEqual(order.guestAccessTokenHash, hashToken(guestToken))) {
            throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
          }
        }

        if (order.status === OrderStatus.CANCELLED) {
          throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
        }

        const hasFailedPayment = order.payments.some((p) => p.status === PaymentStatus.FAILED);
        const now = new Date();
        const withinUnpaidTtl =
          order.placedAt.getTime() + UNPAID_ORDER_TTL_MS > now.getTime();

        const isFirstAttempt =
          order.status === OrderStatus.PLACED &&
          order.paymentStatus === PaymentStatus.PENDING &&
          !hasFailedPayment;

        const isRetryAttempt =
          order.status === OrderStatus.PLACED &&
          withinUnpaidTtl &&
          (hasFailedPayment || order.paymentStatus === PaymentStatus.FAILED);

        if (isFirstAttempt) {
          return this.runFirstPaymentIntent(tx, payments, order);
        }
        if (isRetryAttempt) {
          return this.runRetryPaymentIntent(tx, payments, order);
        }

        throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
  }

  /** @deprecated Prefer createPaymentIntent — kept as explicit first-attempt alias for callers/tests. */
  async createFirstPaymentIntent(input: {
    orderId: string;
    user?: AuthUser;
    orderNumberHeader?: string;
    guestAccessTokenHeader?: string;
  }): Promise<FirstAttemptClientPayload> {
    return this.createPaymentIntent(input);
  }

  private async runFirstPaymentIntent(
    tx: Tx,
    payments: PaymentsService,
    order: {
      id: string;
      paymentMethodCodeSnapshot: string | null;
      grandTotal: Prisma.Decimal;
      currencyCode: string;
      payments: Array<{
        id: string;
        status: PaymentStatus;
        provider: string;
        providerIntentId: string | null;
      }>;
    },
  ): Promise<FirstAttemptClientPayload> {
    const snapshot = order.paymentMethodCodeSnapshot;
    if (snapshot !== "stripe" && snapshot !== "paypal") {
      throw new BadGatewayException({
        error: "INTERNAL_ERROR",
        message: "Order payment method snapshot is not a V1 provider",
      });
    }

    this.assertPaymentMethodEnabled(await this.loadPaymentsEnabledTx(tx), snapshot);

    const method = await this.resolvePaymentMethodRow(tx, snapshot);
    if (!method) {
      throw new BadGatewayException({
        error: "INTERNAL_ERROR",
        message: "PaymentMethod is not configured",
      });
    }

    const existing = order.payments.find((p) => p.status === PaymentStatus.PENDING);
    if (existing) {
      const provider = existing.provider === "paypal" ? "paypal" : "stripe";
      if (existing.providerIntentId) {
        return payments.payloadForExisting(provider, existing.providerIntentId);
      }
      return payments.recoverIntoExistingPayment({
        tx,
        paymentId: existing.id,
        orderId: order.id,
        provider,
        amount: order.grandTotal,
        currencyCode: order.currencyCode,
      });
    }

    return payments.createOrRecoverThenPersist({
      tx,
      orderId: order.id,
      paymentMethodId: method.id,
      amount: order.grandTotal,
      currencyCode: order.currencyCode,
      provider: snapshot,
    });
  }

  private async runRetryPaymentIntent(
    tx: Tx,
    payments: PaymentsService,
    order: {
      id: string;
      placedAt: Date;
      paymentStatus: PaymentStatus;
      paymentMethodCodeSnapshot: string | null;
      grandTotal: Prisma.Decimal;
      currencyCode: string;
      payments: Array<{
        id: string;
        status: PaymentStatus;
        provider: string;
        providerIntentId: string | null;
      }>;
      items: Array<{ variantId: string; quantity: number }>;
    },
  ): Promise<FirstAttemptClientPayload> {
    const company = await tx.companySettings.findUnique({
      where: { id: "default" },
      select: { checkoutEnabled: true },
    });
    if (company?.checkoutEnabled !== true) {
      throw new ConflictException({
        error: PlaceOrderPreconditionError.STORE_CHECKOUT_DISABLED,
        message: "Checkout is temporarily disabled",
      });
    }

    const snapshot = order.paymentMethodCodeSnapshot;
    if (snapshot !== "stripe" && snapshot !== "paypal") {
      throw new BadGatewayException({
        error: "INTERNAL_ERROR",
        message: "Order payment method snapshot is not a V1 provider",
      });
    }

    this.assertPaymentMethodEnabled(await this.loadPaymentsEnabledTx(tx), snapshot);

    const method = await this.resolvePaymentMethodRow(tx, snapshot);
    if (!method) {
      throw new BadGatewayException({
        error: "INTERNAL_ERROR",
        message: "PaymentMethod is not configured",
      });
    }

    await this.assertOrderLinesSellable(tx, order.items);

    const windowEnd = new Date(order.placedAt.getTime() + UNPAID_ORDER_TTL_MS);
    await this.inventory.reserveForOrder(
      order.id,
      order.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
      windowEnd,
      tx,
    );

    const existing = order.payments.find((p) => p.status === PaymentStatus.PENDING);
    if (existing) {
      const provider = existing.provider === "paypal" ? "paypal" : "stripe";
      if (existing.providerIntentId) {
        if (order.paymentStatus !== PaymentStatus.PENDING) {
          await tx.order.update({
            where: { id: order.id },
            data: { paymentStatus: PaymentStatus.PENDING },
          });
        }
        return payments.payloadForExisting(provider, existing.providerIntentId);
      }
      const payload = await payments.recoverRetryIntoExistingPayment({
        tx,
        paymentId: existing.id,
        orderId: order.id,
        provider,
        amount: order.grandTotal,
        currencyCode: order.currencyCode,
      });
      if (order.paymentStatus !== PaymentStatus.PENDING) {
        await tx.order.update({
          where: { id: order.id },
          data: { paymentStatus: PaymentStatus.PENDING },
        });
      }
      return payload;
    }

    const payload = await payments.createRetryOrRecoverThenPersist({
      tx,
      orderId: order.id,
      paymentMethodId: method.id,
      amount: order.grandTotal,
      currencyCode: order.currencyCode,
      provider: snapshot,
      attemptKey: String(order.payments.length + 1),
    });

    if (order.paymentStatus !== PaymentStatus.PENDING) {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentStatus: PaymentStatus.PENDING },
      });
    }

    return payload;
  }

  private async assertOrderLinesSellable(
    tx: Tx,
    items: Array<{ variantId: string; quantity: number }>,
  ): Promise<void> {
    for (const item of items) {
      const variant = await tx.productVariant.findUnique({
        where: { id: item.variantId },
        select: { isActive: true, product: { select: { isActive: true } } },
      });
      if (!variant || !isLineSellable(variant.product.isActive, variant.isActive)) {
        throw new ConflictException({
          message: "Order line is not sellable (product or variant inactive)",
        });
      }
    }
  }

  async getForUser(orderId: string, user: AuthUser) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        userId: true,
        status: true,
        paymentStatus: true,
        grandTotal: true,
        currencyCode: true,
        createdAt: true,
      },
    });
    if (!order) throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });

    const isStaff = user.roles.some((r) => STAFF.includes(r));
    if (!isStaff && order.userId !== user.id) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
    }
    return order;
  }

  assertOwnerOrStaff(orderUserId: string | null, user: AuthUser) {
    const isStaff = user.roles.some((r) => STAFF.includes(r));
    if (isStaff) return;
    if (orderUserId !== user.id) {
      throw new ForbiddenException({ error: "FORBIDDEN", message: "Not your order" });
    }
  }

  private async findOrderByIdempotencyScope(
    scope: { userId: string | null; guestKey: string | null; idempotencyKey: string },
    db: Tx | PrismaService = this.prisma,
  ) {
    if (scope.userId) {
      return db.order.findFirst({
        where: { userId: scope.userId, idempotencyKey: scope.idempotencyKey },
      });
    }
    return db.order.findFirst({
      where: { guestKey: scope.guestKey!, idempotencyKey: scope.idempotencyKey },
    });
  }

  private assertFingerprintOrConflict(
    stored: {
      shippingAddressJson: unknown;
      billingAddressJson: unknown;
      paymentMethodCodeSnapshot: string | null;
      couponCodeSnapshot: string | null;
      bonusPointsToRedeem: number | null;
      guestEmail: string | null;
    },
    dto: PlaceOrderDto,
    isGuest: boolean,
  ): void {
    if (!fingerprintsMatch(stored, fingerprintFromDto(dto, isGuest))) {
      throw new ConflictException({
        error: PlaceOrderError.IDEMPOTENCY_PAYLOAD_MISMATCH,
        message: "Idempotency-Key reused with a different order payload",
      });
    }
  }

  private async countActiveReservations(checkoutKey: string): Promise<number> {
    const now = new Date();
    return this.prisma.reservation.count({
      where: {
        checkoutKey,
        releasedAt: null,
        convertedAt: null,
        expiresAt: { gt: now },
      },
    });
  }

  private async loadPaymentsEnabled(): Promise<unknown> {
    return this.loadPaymentsEnabledTx(this.prisma);
  }

  private async loadPaymentsEnabledTx(db: Tx | PrismaService): Promise<unknown> {
    const row = await db.companySettings.findUnique({
      where: { id: "default" },
      select: { paymentsEnabled: true },
    });
    return row?.paymentsEnabled;
  }

  private async resolvePaymentMethodRow(
    db: Tx | PrismaService,
    snapshot: "stripe" | "paypal",
  ) {
    const byCode = await db.paymentMethod.findUnique({ where: { code: snapshot } });
    if (byCode) return byCode;
    return db.paymentMethod.findFirst({
      where: { provider: snapshot, isEnabled: true },
      orderBy: { sortOrder: "asc" },
    });
  }

  private assertPaymentMethodEnabled(raw: unknown, code: "stripe" | "paypal"): void {
    const enabled =
      raw !== null &&
      typeof raw === "object" &&
      (raw as Record<string, unknown>)[code] === true;
    if (!enabled) {
      throw new ConflictException({
        error: PlaceOrderError.STORE_PAYMENT_METHOD_DISABLED,
        message: `Payment method ${code} is disabled`,
      });
    }
  }

  private async lockCompanySettings(tx: Tx) {
    await tx.$queryRaw`SELECT "id" FROM "CompanySettings" WHERE "id" = 'default' FOR UPDATE`;
    const company = await tx.companySettings.findUnique({
      where: { id: "default" },
      select: {
        orderNextNumber: true,
        legalName: true,
        line1: true,
        postalCode: true,
        city: true,
        countryCode: true,
        supportEmail: true,
        supportPhone: true,
        isKleinunternehmer: true,
        defaultLocale: true,
        orderProcessingDaysMin: true,
        orderProcessingDaysMax: true,
      },
    });
    if (!company) {
      throw new ConflictException({
        error: PlaceOrderPreconditionError.STORE_SETTINGS_MISSING,
        message: "CompanySettings not configured",
      });
    }
    return company;
  }

  private formatOrderNumber(next: number, at: Date): string {
    const year = at.getUTCFullYear();
    return `D-${year}-${String(next).padStart(6, "0")}`;
  }

  private async resolveOrderLocale(userId: string | null, defaultLocale: string): Promise<string> {
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { locale: true },
      });
      if (user && (user.locale === "de" || user.locale === "en" || user.locale === "ar")) {
        return user.locale;
      }
    }
    if (defaultLocale === "de" || defaultLocale === "en" || defaultLocale === "ar") {
      return defaultLocale;
    }
    return "de";
  }

  private async loadLegalSnapshots(tx: Tx) {
    const load = async (slug: "agb" | "widerruf" | "datenschutz") => {
      const page = await tx.legalPage.findFirst({
        where: {
          slug,
          countryCode: "DE",
          publishedAt: { not: null },
          supersededAt: null,
        },
        select: { id: true, version: true, body: true, contentHash: true },
      });
      if (!page) {
        throw new ConflictException({
          error: PlaceOrderPreconditionError.REQUIRED_LEGAL_PAGES_MISSING,
          message: `Required published DE legal page missing: ${slug}`,
        });
      }
      return {
        id: page.id,
        hash: page.contentHash ?? createHash("sha256").update(page.body).digest("hex"),
      };
    };
    return {
      agb: await load("agb"),
      widerruf: await load("widerruf"),
      privacy: await load("datenschutz"),
    };
  }

  private async loadShippingSnapshots(tx: Tx) {
    const method = await tx.shippingMethod.findFirst({
      where: { code: V1_SHIPPING_METHOD, isActive: true },
    });
    const zone = await tx.shippingZone.findFirst({ where: { countryCode: "DE" } });
    if (!method || !zone) {
      throw new BadRequestException({
        error: CartError.SHIPPING_RATE_UNAVAILABLE,
        message: "Exactly one matching DE standard ShippingRate is required",
      });
    }
    const now = new Date();
    const rates = await tx.shippingRate.findMany({
      where: {
        zoneId: zone.id,
        methodId: method.id,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gte: now } }],
      },
    });
    if (rates.length !== 1) {
      throw new BadRequestException({
        error: CartError.SHIPPING_RATE_UNAVAILABLE,
        message: "Exactly one matching DE standard ShippingRate is required",
      });
    }
    const rate = rates[0];
    return {
      zoneId: zone.id,
      rateId: rate.id,
      rateName: method.name,
      methodCode: method.code,
      standardAmount: rate.price,
      estimatedTransitDaysMin: rate.estimatedTransitDaysMin,
      estimatedTransitDaysMax: rate.estimatedTransitDaysMax,
    };
  }

  /**
   * G3 — freeze Checkout Lieferzeit onto Order at PLACED.
   * Composite object when both pairs are valid integers min≤max (0 allowed).
   * Otherwise SQL NULL. Never partial / transit_only / isPreview. Never fails placeOrder.
   */
  private buildDeliveryTimeDisclosureSnapshot(input: {
    locale: string;
    processingMin: number | null;
    processingMax: number | null;
    transitMin: number;
    transitMax: number;
    shippingRateId: string;
    shippingMethodCode: string;
  }): {
    disclosureLevel: "composite";
    labelShown: string;
    locale: SupportedLocale;
    processingDaysMin: number;
    processingDaysMax: number;
    transitDaysMin: number;
    transitDaysMax: number;
    lieferzeitDaysMin: number;
    lieferzeitDaysMax: number;
    shippingRateId: string;
    shippingMethodCode: string;
    sources: {
      processing: typeof G3_SOURCE_PROCESSING;
      transit: typeof G3_SOURCE_TRANSIT;
    };
  } | null {
    const processing = this.asValidDaysPair(input.processingMin, input.processingMax);
    const transit = this.asValidDaysPair(input.transitMin, input.transitMax);
    if (!processing || !transit) return null;
    const lieferzeitDaysMin = processing.min + transit.min;
    const lieferzeitDaysMax = processing.max + transit.max;
    const locale: SupportedLocale =
      input.locale === "en" || input.locale === "ar" ? input.locale : "de";
    return {
      disclosureLevel: "composite",
      labelShown: `Lieferzeit: ${lieferzeitDaysMin}${WERKTAG_RANGE_DASH}${lieferzeitDaysMax} Werktage`,
      locale,
      processingDaysMin: processing.min,
      processingDaysMax: processing.max,
      transitDaysMin: transit.min,
      transitDaysMax: transit.max,
      lieferzeitDaysMin,
      lieferzeitDaysMax,
      shippingRateId: input.shippingRateId,
      shippingMethodCode: input.shippingMethodCode,
      sources: {
        processing: G3_SOURCE_PROCESSING,
        transit: G3_SOURCE_TRANSIT,
      },
    };
  }

  private asValidDaysPair(
    min: number | null,
    max: number | null,
  ): { min: number; max: number } | null {
    if (min == null || max == null) return null;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) return null;
    return { min, max };
  }

  private async buildOrderItems(
    tx: Tx,
    lines: Array<{
      variantId: string;
      sku: string;
      name: string;
      quantity: number;
      unitPrice: string;
      lineTotal: string;
    }>,
  ) {
    const items = [];
    for (const line of lines) {
      const variant = await tx.productVariant.findUnique({
        where: { id: line.variantId },
        select: { weightGrams: true },
      });
      items.push({
        variantId: line.variantId,
        skuSnapshot: line.sku,
        nameSnapshot: line.name,
        quantity: line.quantity,
        unitPriceSnapshot: new Prisma.Decimal(line.unitPrice),
        lineTotalSnapshot: new Prisma.Decimal(line.lineTotal),
        weightGramsSnapshot: variant?.weightGrams ?? 0,
      });
    }
    return items;
  }

  private async insertCouponUsageC10(
    tx: Tx,
    input: { orderId: string; couponId: string; userId: string | null },
  ): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "Coupon" WHERE "id" = ${input.couponId} FOR UPDATE`;
    const coupon = await tx.coupon.findUnique({ where: { id: input.couponId } });
    if (!coupon) {
      throw new BadRequestException({
        error: CartError.INVALID_COUPON,
        message: "Coupon is not applicable",
      });
    }
    if (coupon.usageLimitGlobal != null) {
      const activeGlobal = await tx.couponUsage.count({
        where: { couponId: coupon.id, releasedAt: null },
      });
      if (activeGlobal >= coupon.usageLimitGlobal) {
        throw new BadRequestException({
          error: CartError.INVALID_COUPON,
          message: "Coupon is not applicable",
        });
      }
    }
    if (coupon.usageLimitPerUser != null && input.userId) {
      const activePerUser = await tx.couponUsage.count({
        where: { couponId: coupon.id, userId: input.userId, releasedAt: null },
      });
      if (activePerUser >= coupon.usageLimitPerUser) {
        throw new BadRequestException({
          error: CartError.INVALID_COUPON,
          message: "Coupon is not applicable",
        });
      }
    }
    await tx.couponUsage.create({
      data: {
        couponId: coupon.id,
        orderId: input.orderId,
        userId: input.userId,
      },
    });
  }

  /**
   * R2.2-C — release CouponUsage on Order → CANCELLED (C10).
   * Caller already holds Order FOR UPDATE. Lock: Coupon → update usage once-only.
   * Durable marker: CouponUsage.releasedAt NULL → timestamp. No DELETE.
   */
  private async releaseCouponUsageOnCancel(
    tx: Tx,
    orderId: string,
    now: Date = new Date(),
  ): Promise<{ released: boolean }> {
    const usage = await tx.couponUsage.findFirst({
      where: { orderId },
      select: { id: true, couponId: true, releasedAt: true },
    });
    if (!usage) return { released: false };
    if (usage.releasedAt != null) return { released: false };

    await tx.$queryRaw`
      SELECT id FROM "Coupon" WHERE id = ${usage.couponId} FOR UPDATE
    `;

    const updated = await tx.couponUsage.updateMany({
      where: { id: usage.id, releasedAt: null },
      data: { releasedAt: now },
    });
    return { released: updated.count === 1 };
  }

  /**
   * #4 / 10.8 §1b — system auto-cancel unpaid PLACED past UNPAID_ORDER_TTL.
   * Orders owns CANCELLED; Inventory callee releaseByOrderId. Idempotent per order.
   * Guest = Registered. No sale / no refund / no StockMovement.
   */
  async expireUnpaidPlacedOrders(opts?: {
    now?: Date;
    limit?: number;
  }): Promise<{ expiredCount: number; orderIds: string[] }> {
    const now = opts?.now ?? new Date();
    const cutoff = new Date(now.getTime() - UNPAID_ORDER_TTL_MS);
    const candidates = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PLACED,
        paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
        placedAt: { lte: cutoff },
      },
      select: { id: true },
      take: opts?.limit ?? 100,
      orderBy: { placedAt: "asc" },
    });

    const orderIds: string[] = [];
    for (const c of candidates) {
      const did = await this.expireOneUnpaidOrder(c.id, now);
      if (did) {
        orderIds.push(c.id);
        // 10.10 §4a: enqueue order-cancelled AFTER cancel Tx commit only (#4 path).
        // Failure must not undo CANCELLED / payment / reservation / coupon / stock.
        try {
          await this.enqueueOrderCancelledAfterUnpaidExpiry(c.id);
        } catch {
          // Non-blocking: CANCELLED already committed (§3 / §4a).
        }
        // R2.2-F: provider cancel ONLY after Cancel Tx committed (expireOneUnpaidOrder returns).
        if (this.payments) {
          try {
            await this.payments.attemptProviderCancelAfterUnpaidOrderCancel(c.id);
          } catch {
            // Non-blocking: CANCELLED already committed; audit may be missing on throw — swallow.
          }
        }
      }
    }
    return { expiredCount: orderIds.length, orderIds };
  }

  /**
   * R2.2-B — Admin Cancel post-sale (before SHIPPED): CANCELLED + cancel_restock same Tx.
   * Refund is separate (not this method). Idempotent if already CANCELLED.
   */
  async adminCancelPostSale(
    orderId: string,
    actorId: string,
  ): Promise<{
    orderId: string;
    status: OrderStatus;
    restockedQuantity: number;
    idempotent: boolean;
  }> {
    if (!orderId?.trim()) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "orderId required",
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      if (!locked.length) {
        throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
      }

      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });

      if (order.status === OrderStatus.CANCELLED) {
        await this.releaseCouponUsageOnCancel(tx, orderId);
        const restock = await this.inventory.cancelRestock(orderId, tx, { actorId });
        return {
          orderId,
          status: OrderStatus.CANCELLED,
          restockedQuantity: restock.restockedQuantity,
          idempotent: true,
        };
      }

      if (
        order.status === OrderStatus.SHIPPED ||
        order.status === OrderStatus.DELIVERED ||
        order.status === OrderStatus.COMPLETED ||
        order.status === OrderStatus.RETURN_REQUESTED ||
        order.status === OrderStatus.RETURNED ||
        order.status === OrderStatus.REFUNDED
      ) {
        throw new ConflictException({
          error: "ORDER_NOT_CANCELLABLE",
          message: "Post-sale Admin Cancel not allowed after SHIPPED (use Return)",
        });
      }

      if (order.paymentStatus !== PaymentStatus.PAID) {
        throw new ConflictException({
          error: "ORDER_NOT_CANCELLABLE",
          message: "R2.2-B cancel_restock requires PAID order; unpaid use release path",
        });
      }

      if (
        order.status !== OrderStatus.CONFIRMED &&
        order.status !== OrderStatus.PROCESSING
      ) {
        throw new ConflictException({
          error: "ORDER_NOT_CANCELLABLE",
          message: "Admin Cancel post-sale allowed only for CONFIRMED or PROCESSING",
        });
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELLED },
      });
      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: OrderStatus.CANCELLED,
          actorType: "ADMIN",
          actorId,
        },
      });

      await this.releaseCouponUsageOnCancel(tx, orderId);
      const restock = await this.inventory.cancelRestock(orderId, tx, { actorId });
      return {
        orderId,
        status: OrderStatus.CANCELLED,
        restockedQuantity: restock.restockedQuantity,
        idempotent: restock.idempotent,
      };
    });
  }

  private async expireOneUnpaidOrder(orderId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      if (!locked.length) return false;

      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) return false;
      if (order.status === OrderStatus.CANCELLED) {
        await this.releaseCouponUsageOnCancel(tx, orderId, now);
        await this.inventory.releaseByOrderId(orderId, tx);
        return false;
      }
      if (order.status !== OrderStatus.PLACED) {
        return false;
      }
      if (
        order.paymentStatus !== PaymentStatus.PENDING &&
        order.paymentStatus !== PaymentStatus.FAILED
      ) {
        return false;
      }
      const cutoff = new Date(now.getTime() - UNPAID_ORDER_TTL_MS);
      if (order.placedAt > cutoff) return false;

      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELLED },
      });
      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: OrderStatus.PLACED,
          toStatus: OrderStatus.CANCELLED,
          actorType: "SYSTEM",
          actorId: null,
        },
      });
      await this.releaseCouponUsageOnCancel(tx, orderId, now);
      await this.inventory.releaseByOrderId(orderId, tx);
      return true;
    });
  }

  private toAddressJson(addr: PlaceOrderAddressDto): Prisma.InputJsonValue {
    const json: Record<string, string> = {
      name: addr.name,
      line1: addr.line1,
      postalCode: addr.postalCode,
      city: addr.city,
      countryCode: addr.countryCode,
    };
    if (addr.line2 !== undefined) json.line2 = addr.line2;
    if (addr.phone !== undefined) json.phone = addr.phone;
    return json;
  }

  /**
   * 10.10 §2a/§2b — Admin Resend order confirmation.
   * Sequence: eligibility → guest #16 Reissue → commit → resendId → enqueue → Audit → 202 body.
   */
  async adminResendOrderConfirmation(
    orderId: string,
    actorId: string,
  ): Promise<{ orderId: string; resendId: string; queued: true }> {
    if (!isValidOrderIdParam(orderId)) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "orderId invalid",
      });
    }

    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
    }

    assertResendEligibleStatus(order.status);

    const isGuest = order.userId == null;
    if (isGuest) {
      if (!order.guestEmail?.trim()) {
        throw new ConflictException({
          error: "ORDER_CONFIRMATION_RESEND_NOT_ALLOWED",
          message: "Guest order missing guestEmail",
        });
      }
      if (!(await this.isGuestAccessEffectiveAfterReissue(order))) {
        throw new ConflictException({
          error: "ORDER_CONFIRMATION_RESEND_NOT_ALLOWED",
          message: "Guest access not effective under #16",
        });
      }
    }

    let guestRawToken: string | undefined;
    let guestReissued = false;

    if (isGuest) {
      try {
        guestRawToken = await this.prisma.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
          `;
          if (!locked.length) {
            throw new NotFoundException({ error: "NOT_FOUND", message: "Order not found" });
          }
          const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
          assertResendEligibleStatus(fresh.status);
          if (fresh.userId != null) {
            throw new ConflictException({
              error: "ORDER_CONFIRMATION_RESEND_NOT_ALLOWED",
              message: "Order is no longer guest",
            });
          }
          if (!(await this.isGuestAccessEffectiveAfterReissue(fresh, tx))) {
            throw new ConflictException({
              error: "ORDER_CONFIRMATION_RESEND_NOT_ALLOWED",
              message: "Guest access not effective under #16",
            });
          }

          const raw = randomBytes(32).toString("base64url");
          await tx.order.update({
            where: { id: orderId },
            data: { guestAccessTokenHash: hashToken(raw) },
          });
          await tx.auditLog.create({
            data: {
              actorType: "ADMIN",
              actorId,
              action: GUEST_ACCESS_REISSUE_AUDIT_ACTION,
              entityType: "Order",
              entityId: orderId,
              afterJson: { reissued: true },
            },
          });
          return raw;
        });
        guestReissued = true;
      } catch (e) {
        if (
          e instanceof ConflictException ||
          e instanceof NotFoundException ||
          e instanceof BadRequestException
        ) {
          throw e;
        }
        throw new InternalServerErrorException({
          error: "INTERNAL_ERROR",
          message: "Guest access reissue failed",
        });
      }
    }

    const resendId = randomUUID();

    let to = order.guestEmail?.trim() ?? "";
    if (order.userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: order.userId },
        select: { email: true },
      });
      to = user?.email?.trim() ?? to;
    }
    if (!to) {
      throw new ConflictException({
        error: "ORDER_CONFIRMATION_RESEND_NOT_ALLOWED",
        message: "No recipient email for order confirmation resend",
      });
    }

    if (!this.email) {
      throw new ServiceUnavailableException({
        error: "INTERNAL_ERROR",
        message: "Email queue unavailable",
      });
    }

    try {
      await this.email.enqueueOrderConfirmationResend({
        orderId,
        resendId,
        to,
        communicationLocale: resolveOrderCommunicationLocale(order.locale),
        ...(guestRawToken ? { guestAccessToken: guestRawToken } : {}),
      });
    } catch {
      throw new ServiceUnavailableException({
        error: "INTERNAL_ERROR",
        message: "Failed to enqueue order confirmation resend",
      });
    }

    await this.prisma.auditLog.create({
      data: {
        actorType: "ADMIN",
        actorId,
        action: ORDER_CONFIRMATION_RESEND_AUDIT_ACTION,
        entityType: "Order",
        entityId: orderId,
        afterJson: { resendId, guestReissued },
      },
    });

    return { orderId, resendId, queued: true };
  }

  /** #16 — access effective after Reissue: within TTL from placedAt, or open Return/Refund. */
  private async isGuestAccessEffectiveAfterReissue(
    order: { id: string; placedAt: Date; status: OrderStatus },
    tx?: Tx,
  ): Promise<boolean> {
    const db = tx ?? this.prisma;
    if (order.status === OrderStatus.CANCELLED) return false;
    const withinTtl =
      order.placedAt.getTime() + GUEST_ORDER_ACCESS_TTL_MS > Date.now();
    if (withinTtl) return true;

    const openReturn = await db.returnRequest.findFirst({
      where: {
        orderId: order.id,
        status: {
          in: [
            ReturnRequestStatus.REQUESTED,
            ReturnRequestStatus.APPROVED,
            ReturnRequestStatus.RECEIVED,
          ],
        },
      },
      select: { id: true },
    });
    if (openReturn) return true;

    const openRefund = await db.refund.findFirst({
      where: {
        orderId: order.id,
        status: { in: [RefundStatus.PENDING, RefundStatus.FAILED] },
      },
      select: { id: true },
    });
    return openRefund != null;
  }

  private async enqueueConfirmation(
    orderId: string,
    locale: string,
    guestEmail: string | null,
    userId: string | null,
    guestAccessToken: string | null,
  ): Promise<void> {
    if (!this.email) return;
    let to = guestEmail ?? "";
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      to = user?.email ?? to;
    }
    if (!to) return;
    await this.email.enqueueOrderConfirmation({
      orderId,
      to,
      communicationLocale: resolveOrderCommunicationLocale(locale),
      ...(guestAccessToken ? { guestAccessToken } : {}),
    });
  }

  /**
   * 10.10 §4a — after #4 unpaid auto-cancel commit only.
   * No Audit on enqueue · no guest token · no #16 Reissue.
   */
  private async enqueueOrderCancelledAfterUnpaidExpiry(orderId: string): Promise<void> {
    if (!this.email) return;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        locale: true,
        guestEmail: true,
        userId: true,
        paymentStatus: true,
      },
    });
    if (!order || order.status !== OrderStatus.CANCELLED) return;
    if (
      order.paymentStatus !== PaymentStatus.PENDING &&
      order.paymentStatus !== PaymentStatus.FAILED
    ) {
      return;
    }

    let to = order.guestEmail?.trim() ?? "";
    if (order.userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: order.userId },
        select: { email: true },
      });
      to = user?.email?.trim() ?? to;
    }
    if (!to) return;

    await this.email.enqueueOrderCancelled({
      orderId: order.id,
      to,
      communicationLocale: resolveOrderCommunicationLocale(order.locale),
    });
  }
}

function isValidOrderIdParam(orderId: string): boolean {
  const id = orderId?.trim() ?? "";
  if (!id || id !== orderId) return false;
  if (/\s|[/?#]/.test(id)) return false;
  if (id.length < 8 || id.length > 64) return false;
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function assertResendEligibleStatus(status: OrderStatus): void {
  if (!RESEND_ELIGIBLE_STATUSES.has(status)) {
    throw new ConflictException({
      error: "ORDER_CONFIRMATION_RESEND_NOT_ALLOWED",
      message: `Order status ${status} is not eligible for confirmation resend`,
    });
  }
}
