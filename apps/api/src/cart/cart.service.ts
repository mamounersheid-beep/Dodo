import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CouponType, Prisma } from "@dodo/database";
import { randomBytes } from "node:crypto";
import type {
  CartDeliveryTimePreview,
  CartRecalcLine,
  CartRecalcResponse,
} from "@dodo/shared-types";
import { CatalogService } from "../catalog/catalog.service";
import { InventoryService } from "../inventory/inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthUser } from "../auth/auth.types";
import {
  CartError,
  type CartMergeResponse,
  type CartStateItem,
  type CartStateResponse,
} from "./cart.types";

/** EUR V1 — Currency.decimals = 2; Decimal money, no float. */
const EUR_DECIMALS = 2;
const V1_SHIPPING_METHOD = "standard";
/** 10.2 / 3g label — en-dash, not ASCII hyphen. */
const WERKTAG_RANGE_DASH = "\u2013";

type SelectedShippingRate = {
  id: string;
  price: Prisma.Decimal;
  estimatedTransitDaysMin: number;
  estimatedTransitDaysMax: number;
};

type CartTx = Parameters<Parameters<PrismaService["$transaction"]>[0]>[0];

type CartRow = {
  id: string;
  userId: string | null;
  guestKey: string | null;
  currencyCode: string;
  items: Array<{
    variantId: string;
    quantity: number;
    variant: { sku: string; name: string | null; price: { toString(): string } };
  }>;
};

type CouponPreviewResult =
  | { kind: "none" }
  | { kind: "free_shipping" }
  | { kind: "goods"; discountCoupon: Prisma.Decimal };

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly inventory: InventoryService,
  ) {}

  skeleton() {
    return { module: "cart", ready: true, commerce: false };
  }

  async getOrCreateCart(opts: {
    user?: AuthUser | null;
    guestKey?: string | null;
  }): Promise<CartStateResponse> {
    const cart = await this.resolveCart({ ...opts, createIfMissing: true });
    return this.toState(cart);
  }

  /**
   * Slice 3b merchandise + 3c shipping + 3d coupon + 3e bonus preview + G1 grandTotal/KU + 3g deliveryTime.
   * Does not mutate cart / CouponUsage / BonusLedger / Order. Preview only — not placeOrder / G3.
   */
  async recalculate(opts: {
    user?: AuthUser | null;
    guestKey?: string | null;
    shippingCountryCode: string;
    couponCode?: string | null;
    bonusPointsToRedeem?: number | null;
  }): Promise<CartRecalcResponse> {
    const shippingCountryCode = opts.shippingCountryCode?.trim() ?? "";
    if (!shippingCountryCode) {
      throw new BadRequestException({
        error: CartError.SHIPPING_COUNTRY_REQUIRED,
        message: "shippingCountryCode is required",
      });
    }
    if (shippingCountryCode !== "DE") {
      throw new BadRequestException({
        error: CartError.SHIPPING_COUNTRY_NOT_SUPPORTED,
        message: "V1 shipping preview supports DE only",
      });
    }

    const cart = await this.resolveCart({ ...opts, createIfMissing: false });
    if (cart.currencyCode !== "EUR") {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "V1 carts must use EUR",
      });
    }

    const lines: CartRecalcLine[] = [];
    let itemsSubtotal = new Prisma.Decimal(0);
    let totalWeightGrams = 0;

    for (const item of cart.items) {
      const active = await this.catalog.getActiveVariantForSale(item.variantId);
      await this.assertStockOk(item.variantId, item.quantity);

      const unitPrice = new Prisma.Decimal(active.price);
      const lineTotal = this.roundEur(unitPrice.mul(item.quantity));
      itemsSubtotal = itemsSubtotal.plus(lineTotal);
      totalWeightGrams += active.weightGrams * item.quantity;

      lines.push({
        variantId: active.id,
        sku: active.sku,
        name: active.name ?? active.sku,
        quantity: item.quantity,
        unitPrice: this.formatEur(unitPrice),
        lineTotal: this.formatEur(lineTotal),
      });
    }

    const roundedSubtotal = this.roundEur(itemsSubtotal);
    const coupon = await this.resolveCouponPreview({
      couponCode: opts.couponCode,
      itemsSubtotal: roundedSubtotal,
      userId: opts.user?.id ?? cart.userId,
    });

    const selectedRate = await this.loadDeStandardShippingRate(totalWeightGrams);

    let shippingTotal: Prisma.Decimal;
    if (coupon.kind === "free_shipping") {
      shippingTotal = new Prisma.Decimal(0);
    } else {
      const goodsAfterCoupon =
        coupon.kind === "goods"
          ? roundedSubtotal.minus(coupon.discountCoupon)
          : roundedSubtotal;
      shippingTotal = await this.priceSelectedShippingRate(selectedRate, goodsAfterCoupon);
    }

    const discountCouponDec =
      coupon.kind === "goods" ? coupon.discountCoupon : new Prisma.Decimal(0);
    let discountBonusDec = new Prisma.Decimal(0);

    const response: Omit<
      CartRecalcResponse,
      "grandTotal" | "companyIsKleinunternehmer" | "exemptionText"
    > = {
      currencyCode: "EUR",
      lines,
      itemsSubtotal: this.formatEur(roundedSubtotal),
      shippingTotal: this.formatEur(shippingTotal),
    };
    if (coupon.kind === "goods") {
      response.discountCoupon = this.formatEur(coupon.discountCoupon);
    }

    // ── Slice 3e — Bonus+ preview (D1–D9) ────────────────────────────────
    const bonusIntent = opts.bonusPointsToRedeem;
    if (bonusIntent !== undefined && bonusIntent !== null) {
      // D2-R1/R2: Guest + intent → 403 FORBIDDEN (before store gate D6)
      const isGuest = !opts.user?.id && !cart.userId;
      if (isGuest) {
        throw new ForbiddenException({
          error: "FORBIDDEN",
          message: "Bonus+ preview requires a registered account",
        });
      }

      // D6-R3/R4: Registered + bonusPlusEnabled=false → 409 STORE_BONUS_DISABLED
      const settings = await this.prisma.companySettings.findUnique({
        where: { id: "default" },
        select: { bonusPlusEnabled: true },
      });
      if (!settings || settings.bonusPlusEnabled === false) {
        throw new ConflictException({
          error: CartError.STORE_BONUS_DISABLED,
          message: "Bonus+ is temporarily disabled",
        });
      }

      // D3/D4: Soft-cap — read live balance (BonusAccount.balanceCached)
      const userId = opts.user!.id;
      const bonusAccount = await this.prisma.bonusAccount.findUnique({
        where: { userId },
        select: { balanceCached: true },
      });
      const availableBalance = bonusAccount?.balanceCached ?? 0;

      // D4-R1/R2: maxPointsByCap = FLOOR(goodsAfterGutschein × 50)
      const goodsAfterGutschein =
        coupon.kind === "goods"
          ? roundedSubtotal.minus(coupon.discountCoupon)
          : roundedSubtotal;
      const maxPointsByCap = Math.floor(
        goodsAfterGutschein.mul(50).toNumber(),
      );

      // D3-R2: effectivePoints = min(requested, balance, cap)
      const effectivePoints = Math.min(bonusIntent, availableBalance, maxPointsByCap);

      // D5-R4: bonusPointsAvailable always emitted on registered+intent success path
      response.bonusPointsAvailable = availableBalance;

      if (effectivePoints > 0) {
        // D4-R3/R4: discountBonusEur = effectivePoints ÷ 100 (exact — integer points)
        const discountBonusEur = new Prisma.Decimal(effectivePoints).div(100);
        discountBonusDec = discountBonusEur;
        // D5-R2/R3: emit discountBonus + bonusPointsToRedeem (= effectivePoints)
        response.discountBonus = this.formatEur(discountBonusEur);
        response.bonusPointsToRedeem = effectivePoints;
      }
      // D5-R5: effectivePoints=0 → omit discountBonus + bonusPointsToRedeem; bonusPointsAvailable already set
    }
    // D5-R1: no intent → Bonus fields absent (3d contract intact)

    // ── G1 — grandTotal / KU (always present on success) ───────────────
    const company = await this.prisma.companySettings.findUnique({
      where: { id: "default" },
      select: {
        isKleinunternehmer: true,
        invoiceExemptionText: true,
        orderProcessingDaysMin: true,
        orderProcessingDaysMax: true,
      },
    });
    if (!company) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "CompanySettings not configured",
      });
    }
    const companyIsKleinunternehmer = company.isKleinunternehmer === true;
    const deliveryTime = this.previewDeliveryTime(company, selectedRate);
    return {
      ...response,
      grandTotal: this.formatEur(
        roundedSubtotal.minus(discountCouponDec).minus(discountBonusDec).plus(shippingTotal),
      ),
      companyIsKleinunternehmer,
      exemptionText: companyIsKleinunternehmer ? company.invoiceExemptionText : null,
      ...(deliveryTime ? { deliveryTime } : {}),
    };
  }

  async addItem(
    opts: { user?: AuthUser | null; guestKey?: string | null },
    variantId: string,
    quantity: number = 1,
  ): Promise<CartStateResponse> {
    this.assertPositiveInt(quantity);
    await this.catalog.getActiveVariantForSale(variantId);

    const cart = await this.resolveCart({ ...opts, createIfMissing: true });
    const existing = cart.items.find((i) => i.variantId === variantId);
    const newQty = (existing?.quantity ?? 0) + quantity;

    await this.assertStockOk(variantId, newQty);

    if (existing) {
      await this.prisma.cartItem.update({
        where: { cartId_variantId: { cartId: cart.id, variantId } },
        data: { quantity: newQty },
      });
    } else {
      await this.prisma.cartItem.create({
        data: { cartId: cart.id, variantId, quantity: newQty },
      });
    }

    return this.getOrCreateCart(opts);
  }

  async updateItem(
    opts: { user?: AuthUser | null; guestKey?: string | null },
    variantId: string,
    quantity: number,
  ): Promise<CartStateResponse> {
    this.assertPositiveInt(quantity);
    await this.catalog.getActiveVariantForSale(variantId);

    const cart = await this.resolveCart({ ...opts, createIfMissing: false });
    const existing = cart.items.find((i) => i.variantId === variantId);
    if (!existing) {
      throw new NotFoundException({
        error: CartError.ITEM_NOT_FOUND,
        message: "Cart item not found",
      });
    }

    await this.assertStockOk(variantId, quantity);

    await this.prisma.cartItem.update({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
      data: { quantity },
    });

    return this.getOrCreateCart(opts);
  }

  async removeItem(
    opts: { user?: AuthUser | null; guestKey?: string | null },
    variantId: string,
  ): Promise<CartStateResponse> {
    const cart = await this.resolveCart({ ...opts, createIfMissing: false });
    await this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id, variantId },
    });
    return this.getOrCreateCart(opts);
  }

  /**
   * Slice 3f — merge the guest cart into the authenticated user cart (F1–F4).
   *
   * One transaction, lock order guest cart → user cart. Same variant:
   * min(qty_guest + qty_user, available); different variants: union;
   * !lineSellable and available=0 are excluded from the merged cart.
   * Guest cart is hard-deleted (items first). Never prices: no
   * shippingCountryCode, no coupon/bonus evaluation, no totals.
   */
  async mergeGuestCart(opts: {
    user: AuthUser;
    guestKey?: string | null;
  }): Promise<CartMergeResponse> {
    const userId = opts.user.id;
    const guestKey = opts.guestKey?.trim() || null;

    return this.prisma.$transaction(async (tx) => {
      // Lock the guest cart row first; absent/stale/unknown key yields no rows.
      const guestLocked = guestKey
        ? await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Cart" WHERE "guestKey" = ${guestKey} FOR UPDATE
          `
        : [];
      const guestCartId = guestLocked[0]?.id ?? null;

      let userCart = await tx.cart.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (!userCart) {
        userCart = await tx.cart.create({
          data: { userId, currencyCode: "EUR" },
          select: { id: true },
        });
      }
      await tx.$queryRaw`SELECT "id" FROM "Cart" WHERE "userId" = ${userId} FOR UPDATE`;
      const userCartId = userCart.id;

      let quantitiesReducedByAvailability = false;

      if (guestCartId) {
        const guestItems = await tx.cartItem.findMany({
          where: { cartId: guestCartId },
          select: { variantId: true, quantity: true },
        });
        const userItems = await tx.cartItem.findMany({
          where: { cartId: userCartId },
          select: { variantId: true, quantity: true },
        });
        const userQty = new Map(userItems.map((i) => [i.variantId, i.quantity]));
        const locationId = await this.inventory.resolveMainLocationId(tx);

        // Gates + quantities are resolved for every candidate before any write.
        const plan: Array<{ variantId: string; effectiveQty: number }> = [];
        for (const guestItem of guestItems) {
          const variantId = guestItem.variantId;
          if (!(await this.isLineSellable(tx, variantId))) {
            // Eligibility exclusion — outside the availability comparison.
            plan.push({ variantId, effectiveQty: 0 });
            continue;
          }
          const intendedQty = guestItem.quantity + (userQty.get(variantId) ?? 0);
          const available = await this.inventory.available(variantId, locationId, tx);
          const effectiveQty = Math.max(0, Math.min(intendedQty, available));
          if (effectiveQty < intendedQty) {
            quantitiesReducedByAvailability = true;
          }
          plan.push({ variantId, effectiveQty });
        }

        for (const line of plan) {
          if (line.effectiveQty >= 1) {
            await tx.cartItem.upsert({
              where: {
                cartId_variantId: { cartId: userCartId, variantId: line.variantId },
              },
              create: {
                cartId: userCartId,
                variantId: line.variantId,
                quantity: line.effectiveQty,
              },
              update: { quantity: line.effectiveQty },
            });
          } else {
            // quantity >= 1 — an excluded line must not persist.
            await tx.cartItem.deleteMany({
              where: { cartId: userCartId, variantId: line.variantId },
            });
          }
        }

        // CartItem.cart has no cascade — children before the parent row.
        await tx.cartItem.deleteMany({ where: { cartId: guestCartId } });
        await tx.cart.delete({ where: { id: guestCartId } });
      }

      const merged = await tx.cart.findUniqueOrThrow({
        where: { id: userCartId },
        include: this.itemInclude(),
      });
      return { ...this.toState(merged), quantitiesReducedByAvailability };
    });
  }

  /** lineSellable = Product.isActive ∧ Variant.isActive (non-throwing). */
  private async isLineSellable(tx: CartTx, variantId: string): Promise<boolean> {
    const variant = await tx.productVariant.findUnique({
      where: { id: variantId },
      select: { isActive: true, product: { select: { isActive: true } } },
    });
    return Boolean(variant?.isActive && variant.product.isActive);
  }

  /** Mint opaque guest key for first guest cart access. */
  mintGuestKey(): string {
    return `gk_${randomBytes(24).toString("base64url")}`;
  }

  /**
   * Slice 3d B1–B4 — request-scoped coupon preview. No CouponUsage writes.
   */
  private async resolveCouponPreview(opts: {
    couponCode?: string | null;
    itemsSubtotal: Prisma.Decimal;
    userId?: string | null;
  }): Promise<CouponPreviewResult> {
    // B1 — trim only; empty after trim = absent (3c path)
    const code = opts.couponCode?.trim() ?? "";
    if (!code) return { kind: "none" };

    const settings = await this.prisma.companySettings.findUnique({
      where: { id: "default" },
      select: { couponsEnabled: true },
    });
    if (!settings || settings.couponsEnabled === false) {
      throw new ConflictException({
        error: CartError.STORE_COUPONS_DISABLED,
        message: "Coupons are temporarily disabled",
      });
    }

    // B1 — case-sensitive match vs Coupon.code
    const coupon = await this.prisma.coupon.findUnique({ where: { code } });
    const now = new Date();

    const invalid = () =>
      new BadRequestException({
        error: CartError.INVALID_COUPON,
        message: "Coupon is not applicable",
      });

    if (!coupon) throw invalid();
    if (!coupon.isActive) throw invalid();
    if (coupon.validFrom > now) throw invalid();
    if (coupon.validTo != null && coupon.validTo < now) throw invalid();

    // B4-D3/D4 — minOrder vs pre-discount itemsSubtotal, before discount calc
    if (coupon.minOrderAmount != null && opts.itemsSubtotal.lt(coupon.minOrderAmount)) {
      throw invalid();
    }

    if (coupon.usageLimitGlobal != null) {
      const activeGlobal = await this.prisma.couponUsage.count({
        where: { couponId: coupon.id, releasedAt: null },
      });
      if (activeGlobal >= coupon.usageLimitGlobal) throw invalid();
    }

    if (coupon.usageLimitPerUser != null && opts.userId) {
      const activePerUser = await this.prisma.couponUsage.count({
        where: { couponId: coupon.id, userId: opts.userId, releasedAt: null },
      });
      if (activePerUser >= coupon.usageLimitPerUser) throw invalid();
    }

    // B3 — FREE_SHIPPING: shipping override only; value ignored; no discountCoupon
    if (coupon.type === CouponType.FREE_SHIPPING) {
      return { kind: "free_shipping" };
    }

    // B4 — FIXED / PERCENT goods discount
    let discount: Prisma.Decimal;
    if (coupon.type === CouponType.FIXED) {
      const value = new Prisma.Decimal(coupon.value);
      // B4-D5/D6 — cap at itemsSubtotal when oversize
      discount = value.gt(opts.itemsSubtotal) ? opts.itemsSubtotal : value;
    } else if (coupon.type === CouponType.PERCENT) {
      // B4-D1/D2 — itemsSubtotal × (value/100), HALF_UP to 2dp before subtract
      const raw = opts.itemsSubtotal.mul(new Prisma.Decimal(coupon.value)).div(100);
      discount = this.roundEurHalfUp(raw);
    } else {
      throw invalid();
    }

    return { kind: "goods", discountCoupon: this.roundEur(discount) };
  }

  /**
   * Slice 3c — DE standard rate identity (exactly one matching rate).
   * 3g reads transit from this same row; does not re-select.
   */
  private async loadDeStandardShippingRate(
    totalWeightGrams: number,
  ): Promise<SelectedShippingRate> {
    const method = await this.prisma.shippingMethod.findFirst({
      where: { code: V1_SHIPPING_METHOD, isActive: true },
    });
    if (!method) {
      throw new BadRequestException({
        error: CartError.SHIPPING_RATE_UNAVAILABLE,
        message: "Active standard shipping method not found",
      });
    }

    const zone = await this.prisma.shippingZone.findFirst({
      where: { countryCode: "DE" },
    });
    if (!zone) {
      throw new BadRequestException({
        error: CartError.SHIPPING_RATE_UNAVAILABLE,
        message: "Shipping zone DE not found",
      });
    }

    const now = new Date();
    const candidates = await this.prisma.shippingRate.findMany({
      where: {
        zoneId: zone.id,
        methodId: method.id,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gte: now } }],
      },
    });

    const matching = candidates.filter((rate) => {
      if (rate.minWeight != null && totalWeightGrams < rate.minWeight) return false;
      if (rate.maxWeight != null && totalWeightGrams > rate.maxWeight) return false;
      return true;
    });

    if (matching.length !== 1) {
      throw new BadRequestException({
        error: CartError.SHIPPING_RATE_UNAVAILABLE,
        message: "Exactly one matching DE standard ShippingRate is required",
      });
    }

    return matching[0];
  }

  /** Slice 3c — price from the already-selected rate + FreeShippingThreshold. */
  private async priceSelectedShippingRate(
    rate: SelectedShippingRate,
    goodsAfterCoupon: Prisma.Decimal,
  ): Promise<Prisma.Decimal> {
    const threshold = await this.prisma.freeShippingThreshold.findFirst({
      where: { countryCode: "DE", currencyCode: "EUR" },
    });
    if (!threshold) {
      throw new BadRequestException({
        error: CartError.FREE_SHIPPING_THRESHOLD_MISSING,
        message: "FreeShippingThreshold for DE/EUR not configured",
      });
    }

    if (goodsAfterCoupon.gte(threshold.minOrderAmount)) {
      return new Prisma.Decimal(0);
    }

    return new Prisma.Decimal(rate.price);
  }

  /** Slice 3g — omit unless both processing and selected-rate transit are valid integers min≤max. */
  private previewDeliveryTime(
    company: { orderProcessingDaysMin: number | null; orderProcessingDaysMax: number | null },
    rate: SelectedShippingRate,
  ): CartDeliveryTimePreview | undefined {
    const processing = this.asValidDaysPair(
      company.orderProcessingDaysMin,
      company.orderProcessingDaysMax,
    );
    const transit = this.asValidDaysPair(
      rate.estimatedTransitDaysMin,
      rate.estimatedTransitDaysMax,
    );
    if (!processing || !transit) return undefined;
    const deliveryTimeDaysMin = processing.min + transit.min;
    const deliveryTimeDaysMax = processing.max + transit.max;
    return {
      disclosureLevel: "composite",
      labelShown: `Lieferzeit: ${deliveryTimeDaysMin}${WERKTAG_RANGE_DASH}${deliveryTimeDaysMax} Werktage`,
      processingDaysMin: processing.min,
      processingDaysMax: processing.max,
      transitDaysMin: transit.min,
      transitDaysMax: transit.max,
      deliveryTimeDaysMin,
      deliveryTimeDaysMax,
      isPreview: true,
    };
  }

  private asValidDaysPair(
    min: number | null,
    max: number | null,
  ): { min: number; max: number } | undefined {
    if (min == null || max == null) return undefined;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) return undefined;
    return { min, max };
  }

  private roundEur(value: Prisma.Decimal): Prisma.Decimal {
    return this.roundEurHalfUp(value);
  }

  /** B4-D2 — EUR 2dp HALF_UP (explicit). */
  private roundEurHalfUp(value: Prisma.Decimal): Prisma.Decimal {
    return value.toDecimalPlaces(EUR_DECIMALS, Prisma.Decimal.ROUND_HALF_UP);
  }

  private formatEur(value: Prisma.Decimal): string {
    return this.roundEur(value).toFixed(EUR_DECIMALS);
  }

  private assertPositiveInt(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new BadRequestException({
        error: CartError.INVALID_QUANTITY,
        message: "quantity must be an integer >= 1",
      });
    }
  }

  private async assertStockOk(variantId: string, qty: number): Promise<void> {
    const locationId = await this.inventory.resolveMainLocationId();
    const ok = await this.inventory.stockOK(variantId, locationId, qty);
    if (ok) return;
    const available = await this.inventory.available(variantId, locationId);
    throw new ConflictException({
      error: CartError.STOCK_LIMIT_EXCEEDED,
      message: "Insufficient available stock for cart quantity",
      available,
    });
  }

  private async resolveCart(opts: {
    user?: AuthUser | null;
    guestKey?: string | null;
    createIfMissing: boolean;
  }): Promise<CartRow> {
    if (opts.user?.id) {
      const existing = await this.prisma.cart.findUnique({
        where: { userId: opts.user.id },
        include: this.itemInclude(),
      });
      if (existing) return existing;
      if (!opts.createIfMissing) {
        throw new NotFoundException({ error: "NOT_FOUND", message: "Cart not found" });
      }
      return this.prisma.cart.create({
        data: { userId: opts.user.id, currencyCode: "EUR" },
        include: this.itemInclude(),
      });
    }

    let guestKey = opts.guestKey?.trim() || null;
    if (!guestKey) {
      if (!opts.createIfMissing) {
        throw new BadRequestException({
          error: CartError.GUEST_KEY_REQUIRED,
          message: "x-guest-key required for guest cart",
        });
      }
      guestKey = this.mintGuestKey();
    }

    const existing = await this.prisma.cart.findUnique({
      where: { guestKey },
      include: this.itemInclude(),
    });
    if (existing) return existing;
    if (!opts.createIfMissing) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Cart not found" });
    }
    return this.prisma.cart.create({
      data: { guestKey, currencyCode: "EUR" },
      include: this.itemInclude(),
    });
  }

  private itemInclude() {
    return {
      items: {
        include: {
          variant: { select: { sku: true, name: true, price: true } },
        },
      },
    } as const;
  }

  private toState(cart: CartRow): CartStateResponse {
    if (cart.currencyCode !== "EUR") {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "V1 carts must use EUR",
      });
    }
    const items: CartStateItem[] = cart.items.map((i) => ({
      variantId: i.variantId,
      quantity: i.quantity,
      sku: i.variant.sku,
      name: i.variant.name ?? i.variant.sku,
      unitPrice: i.variant.price.toString(),
    }));

    if (cart.userId) {
      return {
        id: cart.id,
        currencyCode: "EUR",
        identity: { type: "user", userId: cart.userId },
        items,
      };
    }
    if (!cart.guestKey) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "Cart missing identity",
      });
    }
    return {
      id: cart.id,
      currencyCode: "EUR",
      identity: { type: "guest", guestKey: cart.guestKey },
      items,
    };
  }
}
