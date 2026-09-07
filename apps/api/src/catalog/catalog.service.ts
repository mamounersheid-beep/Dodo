import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { OrderStatus, PaymentStatus, Prisma } from "@dodo/database";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { InventoryService } from "../inventory/inventory.service";
import {
  assertAspectRatio,
  attributeFingerprint,
  attributeKeys,
  deriveOptionAxes,
  grundpreisEffectiveRequired,
  isAllowedGrundpreisUnit,
  isProductSellable,
  localeFromAcceptLanguage,
  MAX_CATEGORY_DEPTH,
  MAX_IMAGES_PER_PRODUCT,
  resolveLocale,
  sameKeySet,
  slugify,
} from "./catalog.rules";
import { toPublicObjectUrl } from "./public-object-url";
import type {
  CreateBrandDto,
  CreateBundleDto,
  CreateCategoryDto,
  CreateImageDto,
  CreateProductDto,
  CreateVariantDto,
  LinkRelatedProductDto,
  UpdateCategoryDto,
  UpdateProductDto,
  UpdateVariantDto,
  UpsertProductTranslationDto,
} from "./dto/catalog.dto";

const V1_SHIPPING_METHOD = "standard";
const WERKTAG_RANGE_DASH = "\u2013";
const REVIEW_STATUS_PUBLISHED = "published";

type CategoryRow = {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  description: string | null;
  path: string;
  depth: number;
  sortOrder: number;
  sizeGuideMarkdown: string | null;
  isActive: boolean;
  requiresGrundpreis: boolean;
  gpsrCatalogTier: string;
};

type ImageRow = {
  id: string;
  objectKey: string;
  alt: string | null;
  sortOrder: number;
  aspectRatio: string;
  variantId: string | null;
};

function money(d: Prisma.Decimal | string): string {
  return typeof d === "string" ? d : d.toFixed(2);
}

function minDecimal(values: Prisma.Decimal[]): Prisma.Decimal | null {
  if (!values.length) return null;
  return values.reduce((a, b) => (a.lt(b) ? a : b));
}

function maxDecimal(values: Prisma.Decimal[]): Prisma.Decimal | null {
  if (!values.length) return null;
  return values.reduce((a, b) => (a.gt(b) ? a : b));
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
  ) {}

  skeleton() {
    return { module: "catalog", ready: true, step: "10.2" };
  }

  // ——— Public ———

  async listCategories() {
    const { byId } = await this.loadCategoryMaps();
    const rows = [...byId.values()].filter((c) => this.effectiveActive(c, byId));
    rows.sort((a, b) => a.depth - b.depth || a.sortOrder - b.sortOrder);
    return rows.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      path: c.path,
      depth: c.depth,
      sortOrder: c.sortOrder,
      effectiveActive: true,
    }));
  }

  async getCategoryBySlug(slug: string) {
    const { byId, bySlug } = await this.loadCategoryMaps();
    const cat = bySlug.get(slug);
    if (!cat || !this.effectiveActive(cat, byId)) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Category not found" });
    }
    return { ...cat, effectiveActive: true };
  }

  async listProducts(opts: {
    categorySlug?: string;
    brandSlug?: string;
    q?: string;
    size?: string;
    color?: string;
    priceMin?: string;
    priceMax?: string;
    sort?: string;
    page?: number;
    pageSize?: number;
    locale?: string;
    acceptLanguage?: string;
  }) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, opts.pageSize ?? 20));
    const sort = this.parseListSort(opts.sort);
    const locale = resolveLocale(opts.locale ?? localeFromAcceptLanguage(opts.acceptLanguage));

    const where: Prisma.ProductWhereInput = {
      isActive: true,
      variants: { some: { isActive: true } },
    };

    if (opts.categorySlug) {
      const { byId, bySlug } = await this.loadCategoryMaps();
      const cat = bySlug.get(opts.categorySlug);
      if (!cat || !this.effectiveActive(cat, byId)) {
        throw new NotFoundException({ error: "NOT_FOUND", message: "Category not found" });
      }
      where.categoryId = cat.id;
    }

    if (opts.brandSlug?.trim()) {
      const brand = await this.prisma.brand.findUnique({
        where: { slug: opts.brandSlug.trim() },
        select: { id: true },
      });
      if (!brand) {
        throw new NotFoundException({ error: "NOT_FOUND", message: "Brand not found" });
      }
      where.brandId = brand.id;
    }

    const variantSome: Prisma.ProductVariantWhereInput = { isActive: true };
    const attrAnd: Prisma.ProductVariantWhereInput[] = [];
    if (opts.size?.trim()) {
      attrAnd.push({
        attributesJson: { path: ["size"], equals: opts.size.trim() },
      });
    }
    if (opts.color?.trim()) {
      attrAnd.push({
        attributesJson: { path: ["color"], equals: opts.color.trim() },
      });
    }
    const priceMin = this.parseOptionalMoney(opts.priceMin, "priceMin");
    const priceMax = this.parseOptionalMoney(opts.priceMax, "priceMax");
    if (priceMin !== undefined || priceMax !== undefined) {
      if (priceMin !== undefined && priceMax !== undefined && priceMin.gt(priceMax)) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: "priceMin must be ≤ priceMax",
        });
      }
      variantSome.price = {
        ...(priceMin !== undefined ? { gte: priceMin } : {}),
        ...(priceMax !== undefined ? { lte: priceMax } : {}),
      };
    }
    if (attrAnd.length) {
      variantSome.AND = attrAnd;
    }
    if (attrAnd.length || priceMin !== undefined || priceMax !== undefined) {
      where.variants = { some: variantSome };
    }

    const q = opts.q?.trim();
    if (q) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
            {
              translations: {
                some: {
                  locale,
                  OR: [
                    { name: { contains: q, mode: "insensitive" } },
                    { description: { contains: q, mode: "insensitive" } },
                  ],
                },
              },
            },
            ...(locale !== "de"
              ? [
                  {
                    translations: {
                      some: {
                        locale: "de",
                        OR: [
                          { name: { contains: q, mode: "insensitive" } },
                          { description: { contains: q, mode: "insensitive" } },
                        ],
                      },
                    },
                  } satisfies Prisma.ProductWhereInput,
                ]
              : []),
          ],
        },
      ];
    }

    const include = {
      brand: true,
      category: true,
      translations: true,
      images: { orderBy: { sortOrder: "asc" as const } },
      variants: {
        where: { isActive: true },
        select: { id: true, price: true, sku: true, attributesJson: true },
      },
    };

    let total: number;
    let rows: Array<{
      id: string;
      slug: string;
      name: string;
      description: string;
      seoTitle: string | null;
      seoDescription: string | null;
      brand: { name: string; slug: string } | null;
      category: { slug: string; name: string; sortOrder: number };
      translations: Array<{
        locale: string;
        name: string;
        description: string;
        seoTitle: string | null;
        seoDescription: string | null;
      }>;
      images: ImageRow[];
      variants: { id: string; price: Prisma.Decimal; sku: string; attributesJson: Prisma.JsonValue }[];
    }>;

    if (sort === "price_asc" || sort === "price_desc") {
      const matched = await this.prisma.product.findMany({
        where,
        select: {
          id: true,
          variants: { where: { isActive: true }, select: { price: true } },
        },
      });
      matched.sort((a, b) => {
        const pa = minDecimal(a.variants.map((v) => v.price));
        const pb = minDecimal(b.variants.map((v) => v.price));
        if (!pa && !pb) return a.id.localeCompare(b.id);
        if (!pa) return 1;
        if (!pb) return -1;
        const cmp = pa.comparedTo(pb);
        if (cmp !== 0) return sort === "price_asc" ? cmp : -cmp;
        return a.id.localeCompare(b.id);
      });
      total = matched.length;
      const pageIds = matched.slice((page - 1) * pageSize, page * pageSize).map((m) => m.id);
      if (pageIds.length === 0) {
        rows = [];
      } else {
        const fetched = await this.prisma.product.findMany({
          where: { id: { in: pageIds } },
          include,
        });
        const byId = new Map(fetched.map((p) => [p.id, p]));
        rows = pageIds.map((id) => byId.get(id)!).filter(Boolean);
      }
    } else {
      const orderBy: Prisma.ProductOrderByWithRelationInput[] =
        sort === "newest"
          ? [{ createdAt: "desc" }, { id: "desc" }]
          : [{ category: { sortOrder: "asc" } }, { createdAt: "asc" }, { id: "asc" }];

      [total, rows] = await Promise.all([
        this.prisma.product.count({ where }),
        this.prisma.product.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy,
          include,
        }),
      ]);
    }

    return {
      page,
      pageSize,
      total,
      sort,
      locale,
      items: rows.map((p) => {
        const tr = this.resolveTranslation(p, locale);
        return this.toPublicProductCard({
          ...p,
          name: tr.name,
        });
      }),
    };
  }

  /**
   * Homepage Sections — `new_arrivals` resolver.
   * Delegates to listProducts(sort=newest) so 10.4 semantics stay singular.
   */
  async listNewestProductCards(opts: {
    limit: number;
    locale?: string;
    acceptLanguage?: string;
  }) {
    const pageSize = Math.min(24, Math.max(1, opts.limit));
    const result = await this.listProducts({
      sort: "newest",
      page: 1,
      pageSize,
      locale: opts.locale,
      acceptLanguage: opts.acceptLanguage,
    });
    return { locale: result.locale, items: result.items };
  }

  /**
   * Homepage Sections — `store_picks` resolver.
   * Preserves Admin order; skips missing / !sellable; no Catalog backfill.
   */
  async listProductCardsByIdsOrdered(opts: {
    productIds: string[];
    limit: number;
    locale?: string;
    acceptLanguage?: string;
  }) {
    const locale = resolveLocale(opts.locale ?? localeFromAcceptLanguage(opts.acceptLanguage));
    const limit = Math.min(24, Math.max(0, opts.limit));
    if (limit === 0 || opts.productIds.length === 0) {
      return { locale, items: [] as ReturnType<CatalogService["toPublicProductCard"]>[] };
    }

    const include = {
      brand: true,
      category: true,
      translations: true,
      images: { orderBy: { sortOrder: "asc" as const } },
      variants: {
        where: { isActive: true },
        select: { id: true, price: true, sku: true, attributesJson: true },
      },
    };

    const rows = await this.prisma.product.findMany({
      where: {
        id: { in: opts.productIds },
        isActive: true,
        variants: { some: { isActive: true } },
      },
      include,
    });
    const byId = new Map(rows.map((p) => [p.id, p]));
    const items: ReturnType<CatalogService["toPublicProductCard"]>[] = [];
    for (const id of opts.productIds) {
      if (items.length >= limit) break;
      const p = byId.get(id);
      if (!p) continue;
      const tr = this.resolveTranslation(p, locale);
      items.push(
        this.toPublicProductCard({
          ...p,
          name: tr.name,
        }),
      );
    }
    return { locale, items };
  }

  private parseListSort(raw?: string): "default" | "price_asc" | "price_desc" | "newest" {
    const v = (raw ?? "default").trim();
    if (v === "default" || v === "price_asc" || v === "price_desc" || v === "newest") return v;
    throw new BadRequestException({
      error: "VALIDATION_ERROR",
      message: "sort must be one of: default, price_asc, price_desc, newest",
    });
  }

  private parseOptionalMoney(raw: string | undefined, field: string): Prisma.Decimal | undefined {
    if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
    try {
      const d = new Prisma.Decimal(String(raw).trim());
      if (d.isNeg()) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: `${field} must be ≥ 0`,
        });
      }
      return d;
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: `${field} must be a valid decimal`,
      });
    }
  }

  async getProductBySlug(
    slug: string,
    opts?: {
      locale?: string;
      acceptLanguage?: string;
      variantId?: string;
      userId?: string;
    },
  ) {
    const locale = resolveLocale(opts?.locale ?? localeFromAcceptLanguage(opts?.acceptLanguage));

    const p = await this.prisma.product.findUnique({
      where: { slug },
      include: {
        brand: true,
        category: true,
        translations: true,
        images: { orderBy: { sortOrder: "asc" } },
        variants: { orderBy: { id: "asc" } },
        relatedFrom: {
          where: { type: "related" },
          include: {
            related: {
              include: {
                images: { orderBy: { sortOrder: "asc" } },
                variants: { where: { isActive: true }, select: { price: true } },
              },
            },
          },
        },
      },
    });
    if (!p) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Product not found" });
    }

    const activeVariants = p.variants.filter((v) => v.isActive);
    if (!isProductSellable(p.isActive, activeVariants.length)) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Product not found" });
    }

    const company = await this.prisma.companySettings.findUnique({ where: { id: "default" } });
    const productSafety = this.buildProductSafety(p, p.images, company);
    if (p.isActive && productSafety.completeness === "incomplete") {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Product not found" });
    }

    const { byId } = await this.loadCategoryMaps();
    const categoryPath = this.resolveCategoryPath(p.categoryId, byId);
    const tr = this.resolveTranslation(p, locale);
    const { axes, optionMode } = deriveOptionAxes(p.variants);

    const defaultVariantId = activeVariants[0]?.id ?? null;
    let selectedVariantId: string | null = null;
    if (opts?.variantId) {
      const match = activeVariants.find((v) => v.id === opts.variantId);
      if (match) selectedVariantId = match.id;
    }

    const locationId = await this.inventory.resolveMainLocationId();
    const availability = new Map<string, number>();
    for (const v of p.variants) {
      availability.set(v.id, await this.getAvailableQty(v.id, locationId));
    }

    const variants = p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      ean: v.ean,
      attributes: v.attributesJson ?? {},
      price: money(v.price),
      compareAtPrice: null,
      available: availability.get(v.id) ?? 0,
      weightGrams: v.weightGrams,
      lengthMm: v.lengthMm,
      widthMm: v.widthMm,
      heightMm: v.heightMm,
      grundpreis:
        v.grundpreisAmount && v.grundpreisUnit
          ? { amount: v.grundpreisAmount.toString(), unit: v.grundpreisUnit }
          : null,
      isActive: v.isActive,
    }));

    const images = this.resolvePdpImages(
      p.images,
      optionMode,
      selectedVariantId,
      defaultVariantId,
    ).map((img) => ({
      id: img.id,
      url: toPublicObjectUrl(img.objectKey),
      alt: img.alt,
      sortOrder: img.sortOrder,
      aspectRatio: img.aspectRatio,
      variantId: img.variantId,
    }));

    const priceContextVariantId = selectedVariantId ?? (optionMode === "simple" ? defaultVariantId : null);
    const priceDisplay = this.buildPriceDisplay({
      optionMode,
      variants: p.variants,
      availability,
      selectedVariantId: priceContextVariantId,
      isKleinunternehmer: company?.isKleinunternehmer ?? true,
      categoryRequiresGrundpreis: p.category.requiresGrundpreis,
      grundpreisRequirement: p.grundpreisRequirement,
    });

    const sizeGuide = this.resolveSizeGuide(p.categoryId, byId, optionMode, axes);

    const reviewAgg = await this.prisma.review.aggregate({
      where: { productId: p.id, status: REVIEW_STATUS_PUBLISHED },
      _avg: { rating: true },
      _count: { id: true },
    });
    const verifiedPurchaseCount = await this.prisma.review.count({
      where: { productId: p.id, status: REVIEW_STATUS_PUBLISHED, verifiedPurchase: true },
    });

    const relatedProducts = await this.buildRelatedProducts(p.relatedFrom);

    const shippingVariantId =
      selectedVariantId ?? (optionMode === "simple" ? defaultVariantId : null);
    const shipping = await this.previewShipping(shippingVariantId, p.variants, company);

    const legal = {
      widerrufUrl: "/widerruf",
      returnsUrl: "/widerruf",
      versandUrl: "/versand",
    };

    const seo = {
      title: tr.seoTitle ?? tr.name,
      description: tr.seoDescription ?? tr.description.slice(0, 160),
      canonicalPath: `/products/${p.slug}`,
    };

    let reviewable: boolean | undefined;
    let inWishlist: boolean | undefined;
    if (opts?.userId) {
      reviewable = await this.isReviewable(opts.userId, p.id);
      inWishlist = await this.isInWishlist(opts.userId, p.id);
    }

    return {
      product: {
        id: p.id,
        slug: p.slug,
        name: tr.name,
        description: tr.description,
        category: {
          id: p.category.id,
          slug: p.category.slug,
          name: p.category.name,
        },
        brand: p.brand
          ? { id: p.brand.id, name: p.brand.name, slug: p.brand.slug }
          : null,
        optionMode,
      },
      categoryPath,
      options: { axes, optionMode },
      variants,
      images,
      priceDisplay,
      sizeGuide,
      reviews: {
        summary: {
          averageRating: reviewAgg._avg.rating ?? 0,
          count: reviewAgg._count.id,
          verifiedPurchaseCount,
        },
      },
      relatedProducts,
      shipping,
      legal,
      productSafety,
      seo,
      ...(opts?.userId ? { reviewable, inWishlist } : {}),
      defaultVariantId,
      sellable: true,
    };
  }

  async listProductReviews(
    slug: string,
    opts: { page?: number; pageSize?: number },
  ) {
    const p = await this.prisma.product.findFirst({ where: { slug }, select: { id: true, isActive: true } });
    if (!p) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Product not found" });
    }
    const activeCount = await this.prisma.productVariant.count({
      where: { productId: p.id, isActive: true },
    });
    if (!isProductSellable(p.isActive, activeCount)) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Product not found" });
    }

    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, opts.pageSize ?? 10));
    const where = { productId: p.id, status: REVIEW_STATUS_PUBLISHED };

    const [total, rows] = await Promise.all([
      this.prisma.review.count({ where }),
      this.prisma.review.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: { reply: true },
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      items: rows.map((r) => ({
        rating: r.rating,
        body: r.body ?? undefined,
        verifiedPurchase: r.verifiedPurchase,
        createdAt: r.createdAt.toISOString(),
        reply: r.reply
          ? { body: r.reply.body, createdAt: r.reply.createdAt.toISOString() }
          : undefined,
      })),
    };
  }

  /** For cart/checkout — refuses inactive / missing variant. */
  async getActiveVariantForSale(variantId: string) {
    const v = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      include: { product: true },
    });
    if (!v || !v.isActive || !v.product.isActive) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Variant not available for sale" });
    }
    return {
      id: v.id,
      sku: v.sku,
      name: v.name,
      price: money(v.price),
      weightGrams: v.weightGrams,
      productId: v.productId,
      productName: v.product.name,
    };
  }

  // ——— Admin: Category ———

  async createCategory(dto: CreateCategoryDto, actorId: string) {
    const slug = slugify(dto.slug || dto.name);
    if (!slug) throw new BadRequestException({ error: "VALIDATION_ERROR", message: "Invalid slug" });

    let depth = 0;
    let path = `/${slug}`;
    if (dto.parentId) {
      const parent = await this.prisma.category.findUnique({ where: { id: dto.parentId } });
      if (!parent) throw new NotFoundException({ error: "NOT_FOUND", message: "Parent category not found" });
      depth = parent.depth + 1;
      if (depth > MAX_CATEGORY_DEPTH) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: `Category depth max ${MAX_CATEGORY_DEPTH + 1} levels`,
        });
      }
      path = `${parent.path}/${slug}`;
    }

    try {
      const created = await this.prisma.category.create({
        data: {
          name: dto.name.trim(),
          slug,
          description: dto.description,
          parentId: dto.parentId,
          path,
          depth,
          sortOrder: dto.sortOrder ?? 0,
          sizeGuideMarkdown: dto.sizeGuideMarkdown,
          isActive: dto.isActive ?? true,
          requiresGrundpreis: dto.requiresGrundpreis ?? false,
          gpsrCatalogTier: dto.gpsrCatalogTier ?? "standard",
        },
      });
      await this.audit.write({
        actorType: "ADMIN",
        actorId,
        action: "catalog.category.create",
        entityType: "Category",
        entityId: created.id,
      });
      return created;
    } catch (e) {
      this.rethrowUnique(e, "Category slug");
    }
  }

  async updateCategory(id: string, dto: UpdateCategoryDto, actorId: string) {
    const before = await this.requireCategory(id);
    const updated = await this.prisma.category.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        description: dto.description === undefined ? undefined : dto.description,
        sortOrder: dto.sortOrder,
        sizeGuideMarkdown: dto.sizeGuideMarkdown === undefined ? undefined : dto.sizeGuideMarkdown,
        isActive: dto.isActive,
        requiresGrundpreis: dto.requiresGrundpreis,
        gpsrCatalogTier: dto.gpsrCatalogTier,
      },
    });

    if (dto.isActive !== undefined && dto.isActive !== before.isActive) {
      await this.audit.write({
        actorType: "ADMIN",
        actorId,
        action: dto.isActive ? "catalog.category.activate" : "catalog.category.deactivate",
        entityType: "Category",
        entityId: id,
        beforeJson: { isActive: before.isActive },
        afterJson: { isActive: dto.isActive },
      });
    } else {
      await this.audit.write({
        actorType: "ADMIN",
        actorId,
        action: "catalog.category.update",
        entityType: "Category",
        entityId: id,
      });
    }
    return updated;
  }

  // ——— Admin: Brand ———

  async createBrand(dto: CreateBrandDto, actorId: string) {
    const slug = slugify(dto.slug || dto.name);
    try {
      const created = await this.prisma.brand.create({
        data: { name: dto.name.trim(), slug },
      });
      await this.audit.write({
        actorType: "ADMIN",
        actorId,
        action: "catalog.brand.create",
        entityType: "Brand",
        entityId: created.id,
      });
      return created;
    } catch (e) {
      this.rethrowUnique(e, "Brand slug");
    }
  }

  listBrands() {
    return this.prisma.brand.findMany({ orderBy: { name: "asc" } });
  }

  // ——— Admin: Product ———

  async createProduct(dto: CreateProductDto, actorId: string) {
    await this.requireCategory(dto.categoryId);
    if (dto.brandId) await this.requireBrand(dto.brandId);

    if (dto.mode === "simple" && !dto.baseVariant) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "baseVariant required when mode=simple",
      });
    }

    const slug = slugify(dto.slug || dto.name);
    const isActive = dto.isActive ?? false;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const product = await tx.product.create({
          data: {
            categoryId: dto.categoryId,
            brandId: dto.brandId,
            name: dto.name.trim(),
            slug,
            description: dto.description,
            seoTitle: dto.seoTitle,
            seoDescription: dto.seoDescription,
            isActive: false,
            grundpreisRequirement: dto.grundpreisRequirement ?? "inherit",
            safetyInformationRequired: dto.safetyInformationRequired ?? false,
          },
        });

        if (dto.mode === "simple" && dto.baseVariant) {
          await tx.productVariant.create({
            data: {
              productId: product.id,
              sku: dto.baseVariant.sku.trim().toUpperCase(),
              ean: dto.baseVariant.ean,
              name: dto.baseVariant.name,
              attributesJson: {},
              price: new Prisma.Decimal(dto.baseVariant.price),
              weightGrams: dto.baseVariant.weightGrams,
              isActive: true,
            },
          });
        }

        if (isActive) {
          await this.assertPublishable(product.id, tx);
          await tx.product.update({ where: { id: product.id }, data: { isActive: true } });
        }

        return tx.product.findUniqueOrThrow({
          where: { id: product.id },
          include: { variants: true },
        });
      });

      await this.audit.write({
        actorType: "ADMIN",
        actorId,
        action: "catalog.product.create",
        entityType: "Product",
        entityId: created.id,
      });

      const active = created.variants.filter((v) => v.isActive).length;
      return {
        ...created,
        sellable: isProductSellable(created.isActive, active),
        note: active ? undefined : "Add at least one active variant before sale",
      };
    } catch (e) {
      this.rethrowUnique(e, "Product slug");
    }
  }

  async updateProduct(id: string, dto: UpdateProductDto, actorId: string) {
    await this.requireProduct(id);
    if (dto.categoryId) await this.requireCategory(dto.categoryId);
    if (dto.brandId) await this.requireBrand(dto.brandId);

    if (dto.isActive === true) {
      await this.assertPublishable(id);
    }

    const updated = await this.prisma.product.update({
      where: { id },
      data: {
        categoryId: dto.categoryId,
        brandId: dto.brandId === undefined ? undefined : dto.brandId,
        name: dto.name?.trim(),
        description: dto.description,
        seoTitle: dto.seoTitle === undefined ? undefined : dto.seoTitle,
        seoDescription: dto.seoDescription === undefined ? undefined : dto.seoDescription,
        isActive: dto.isActive,
        grundpreisRequirement: dto.grundpreisRequirement,
        manufacturerSource: dto.manufacturerSource,
        manufacturerDisplayName: dto.manufacturerDisplayName === undefined ? undefined : dto.manufacturerDisplayName,
        manufacturerAddressLine1: dto.manufacturerAddressLine1 === undefined ? undefined : dto.manufacturerAddressLine1,
        manufacturerPostalCode: dto.manufacturerPostalCode === undefined ? undefined : dto.manufacturerPostalCode,
        manufacturerCity: dto.manufacturerCity === undefined ? undefined : dto.manufacturerCity,
        manufacturerCountryCode: dto.manufacturerCountryCode === undefined ? undefined : dto.manufacturerCountryCode,
        manufacturerEstablishedInUnion: dto.manufacturerEstablishedInUnion === undefined ? undefined : dto.manufacturerEstablishedInUnion,
        manufacturerEmail: dto.manufacturerEmail === undefined ? undefined : dto.manufacturerEmail,
        euResponsiblePersonDisplayName: dto.euResponsiblePersonDisplayName === undefined ? undefined : dto.euResponsiblePersonDisplayName,
        euResponsiblePersonAddressLine1: dto.euResponsiblePersonAddressLine1 === undefined ? undefined : dto.euResponsiblePersonAddressLine1,
        euResponsiblePersonPostalCode: dto.euResponsiblePersonPostalCode === undefined ? undefined : dto.euResponsiblePersonPostalCode,
        euResponsiblePersonCity: dto.euResponsiblePersonCity === undefined ? undefined : dto.euResponsiblePersonCity,
        euResponsiblePersonCountryCode: dto.euResponsiblePersonCountryCode === undefined ? undefined : dto.euResponsiblePersonCountryCode,
        euResponsiblePersonEmail: dto.euResponsiblePersonEmail === undefined ? undefined : dto.euResponsiblePersonEmail,
        safetyInformationRequired: dto.safetyInformationRequired,
      },
      include: { variants: { where: { isActive: true }, select: { id: true } } },
    });

    await this.audit.write({
      actorType: "ADMIN",
      actorId,
      action: "catalog.product.update",
      entityType: "Product",
      entityId: id,
    });

    return {
      ...updated,
      sellable: isProductSellable(updated.isActive, updated.variants.length),
      variants: undefined,
    };
  }

  async adminGetProduct(id: string) {
    const p = await this.prisma.product.findUnique({
      where: { id },
      include: {
        brand: true,
        category: true,
        images: { orderBy: { sortOrder: "asc" } },
        variants: true,
        translations: true,
        relatedFrom: {
          where: { type: "related" },
          include: {
            related: {
              select: { id: true, slug: true, name: true, isActive: true },
            },
          },
        },
      },
    });
    if (!p) throw new NotFoundException({ error: "NOT_FOUND", message: "Product not found" });
    const active = p.variants.filter((v) => v.isActive).length;
    return {
      ...p,
      variants: p.variants.map((v) => ({ ...v, price: money(v.price) })),
      sellable: isProductSellable(p.isActive, active),
      related: p.relatedFrom.map((r) => ({
        id: r.id,
        relatedProductId: r.relatedProductId,
        type: r.type,
        related: r.related,
      })),
      relatedFrom: undefined,
    };
  }

  async upsertProductTranslation(
    productId: string,
    dto: UpsertProductTranslationDto,
    actorId: string,
  ) {
    await this.requireProduct(productId);
    const row = await this.prisma.productTranslation.upsert({
      where: { productId_locale: { productId, locale: dto.locale } },
      create: {
        productId,
        locale: dto.locale,
        name: dto.name.trim(),
        description: dto.description,
        seoTitle: dto.seoTitle,
        seoDescription: dto.seoDescription,
        safetyInformationMarkdown: dto.safetyInformationMarkdown,
      },
      update: {
        name: dto.name.trim(),
        description: dto.description,
        seoTitle: dto.seoTitle === undefined ? undefined : dto.seoTitle,
        seoDescription: dto.seoDescription === undefined ? undefined : dto.seoDescription,
        safetyInformationMarkdown:
          dto.safetyInformationMarkdown === undefined ? undefined : dto.safetyInformationMarkdown,
      },
    });
    await this.audit.write({
      actorType: "ADMIN",
      actorId,
      action: "catalog.product.translation.upsert",
      entityType: "ProductTranslation",
      entityId: row.id,
      afterJson: { productId, locale: dto.locale },
    });
    return row;
  }

  async linkRelatedProduct(productId: string, dto: LinkRelatedProductDto, actorId: string) {
    await this.requireProduct(productId);
    if (dto.relatedProductId === productId) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "Cannot relate product to itself",
      });
    }
    await this.requireProduct(dto.relatedProductId);
    try {
      const created = await this.prisma.relatedProduct.create({
        data: {
          productId,
          relatedProductId: dto.relatedProductId,
          type: dto.type ?? "related",
        },
      });
      await this.audit.write({
        actorType: "ADMIN",
        actorId,
        action: "catalog.product.related.link",
        entityType: "RelatedProduct",
        entityId: created.id,
      });
      return created;
    } catch (e) {
      this.rethrowUnique(e, "Related product link");
    }
  }

  async unlinkRelatedProduct(productId: string, relatedProductId: string, actorId: string) {
    const row = await this.prisma.relatedProduct.findFirst({
      where: { productId, relatedProductId, type: "related" },
    });
    if (!row) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Related product link not found" });
    }
    await this.prisma.relatedProduct.delete({ where: { id: row.id } });
    await this.audit.write({
      actorType: "ADMIN",
      actorId,
      action: "catalog.product.related.unlink",
      entityType: "RelatedProduct",
      entityId: row.id,
    });
    return { ok: true };
  }

  // ——— Admin: Variant ———

  async createVariant(productId: string, dto: CreateVariantDto, actorId: string) {
    await this.requireProduct(productId);
    this.validateGrundpreisFields(dto.grundpreisAmount, dto.grundpreisUnit);
    await this.validateVariantAttributes(productId, undefined, dto.attributesJson ?? {});

    try {
      const created = await this.prisma.productVariant.create({
        data: {
          productId,
          sku: dto.sku.trim().toUpperCase(),
          ean: dto.ean,
          name: dto.name,
          attributesJson: dto.attributesJson ?? undefined,
          price: new Prisma.Decimal(dto.price),
          weightGrams: dto.weightGrams,
          lengthMm: dto.lengthMm,
          widthMm: dto.widthMm,
          heightMm: dto.heightMm,
          grundpreisAmount: dto.grundpreisAmount
            ? new Prisma.Decimal(dto.grundpreisAmount)
            : undefined,
          grundpreisUnit: dto.grundpreisUnit,
          isActive: dto.isActive ?? true,
        },
      });

      const product = await this.prisma.product.findUniqueOrThrow({ where: { id: productId } });
      if (product.isActive) {
        await this.assertPublishable(productId);
      }

      await this.audit.write({
        actorType: "ADMIN",
        actorId,
        action: "catalog.variant.create",
        entityType: "ProductVariant",
        entityId: created.id,
      });
      return { ...created, price: money(created.price) };
    } catch (e) {
      this.rethrowUnique(e, "SKU");
    }
  }

  async updateVariant(id: string, dto: UpdateVariantDto, actorId: string) {
    const existing = await this.requireVariant(id);
    this.validateGrundpreisFields(dto.grundpreisAmount, dto.grundpreisUnit);

    const nextAttrs =
      dto.attributesJson === undefined
        ? undefined
        : dto.attributesJson === null
          ? {}
          : dto.attributesJson;
    if (nextAttrs !== undefined) {
      await this.validateVariantAttributes(existing.productId, id, nextAttrs);
    }

    const updated = await this.prisma.productVariant.update({
      where: { id },
      data: {
        ean: dto.ean === undefined ? undefined : dto.ean,
        name: dto.name === undefined ? undefined : dto.name,
        attributesJson:
          dto.attributesJson === undefined
            ? undefined
            : dto.attributesJson === null
              ? Prisma.JsonNull
              : dto.attributesJson,
        price: dto.price !== undefined ? new Prisma.Decimal(dto.price) : undefined,
        weightGrams: dto.weightGrams,
        lengthMm: dto.lengthMm === undefined ? undefined : dto.lengthMm,
        widthMm: dto.widthMm === undefined ? undefined : dto.widthMm,
        heightMm: dto.heightMm === undefined ? undefined : dto.heightMm,
        grundpreisAmount:
          dto.grundpreisAmount === undefined
            ? undefined
            : dto.grundpreisAmount === null
              ? null
              : new Prisma.Decimal(dto.grundpreisAmount),
        grundpreisUnit: dto.grundpreisUnit === undefined ? undefined : dto.grundpreisUnit,
        isActive: dto.isActive,
      },
    });

    const product = await this.prisma.product.findUniqueOrThrow({ where: { id: existing.productId } });
    if (product.isActive) {
      await this.assertPublishable(existing.productId);
    }

    await this.audit.write({
      actorType: "ADMIN",
      actorId,
      action: "catalog.variant.update",
      entityType: "ProductVariant",
      entityId: id,
    });
    return { ...updated, price: money(updated.price) };
  }

  async deleteVariant(id: string, actorId: string) {
    const v = await this.requireVariant(id);
    const used = await this.prisma.orderItem.count({ where: { variantId: id } });
    if (used > 0) {
      const deactivated = await this.prisma.productVariant.update({
        where: { id },
        data: { isActive: false },
      });
      await this.audit.write({
        actorType: "ADMIN",
        actorId,
        action: "catalog.variant.deactivate_historic",
        entityType: "ProductVariant",
        entityId: id,
        afterJson: { reason: "linked_to_order_item", orderItemCount: used },
      });
      return {
        ok: true,
        deleted: false,
        deactivated: true,
        reason: "linked_to_order_item",
        variant: { id: deactivated.id, isActive: false },
      };
    }
    await this.prisma.productVariant.delete({ where: { id } });
    await this.audit.write({
      actorType: "ADMIN",
      actorId,
      action: "catalog.variant.delete",
      entityType: "ProductVariant",
      entityId: id,
      beforeJson: { sku: v.sku },
    });
    return { ok: true, deleted: true };
  }

  // ——— Admin: Images ———

  async addImage(productId: string, dto: CreateImageDto, actorId: string) {
    await this.requireProduct(productId);
    try {
      assertAspectRatio(dto.aspectRatio);
    } catch {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "Only aspect ratio 4:5 allowed; no 360",
      });
    }
    if (dto.variantId) {
      const v = await this.requireVariant(dto.variantId);
      if (v.productId !== productId) {
        throw new BadRequestException({ error: "VALIDATION_ERROR", message: "Variant not on product" });
      }
    }

    const imageCount = await this.prisma.productImage.count({ where: { productId } });
    if (imageCount >= MAX_IMAGES_PER_PRODUCT) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: `Maximum ${MAX_IMAGES_PER_PRODUCT} images per product`,
      });
    }

    const img = await this.prisma.productImage.create({
      data: {
        productId,
        variantId: dto.variantId,
        objectKey: dto.objectKey,
        sortOrder: dto.sortOrder ?? 0,
        alt: dto.alt,
        aspectRatio: "4:5",
      },
    });
    await this.audit.write({
      actorType: "ADMIN",
      actorId,
      action: "catalog.image.create",
      entityType: "ProductImage",
      entityId: img.id,
    });
    return { ...img, url: toPublicObjectUrl(img.objectKey) };
  }

  async deleteImage(id: string, actorId: string) {
    const img = await this.prisma.productImage.findUnique({ where: { id } });
    if (!img) throw new NotFoundException({ error: "NOT_FOUND", message: "Image not found" });
    await this.prisma.productImage.delete({ where: { id } });
    await this.audit.write({
      actorType: "ADMIN",
      actorId,
      action: "catalog.image.delete",
      entityType: "ProductImage",
      entityId: id,
    });
    return { ok: true };
  }

  // ——— Admin: Bundle ———

  async createBundle(dto: CreateBundleDto, actorId: string) {
    for (const item of dto.items) {
      await this.requireVariant(item.variantId);
    }
    const slug = slugify(dto.slug || dto.name);
    try {
      const created = await this.prisma.bundle.create({
        data: {
          name: dto.name.trim(),
          slug,
          discountPercent: dto.discountPercent
            ? new Prisma.Decimal(dto.discountPercent)
            : undefined,
          isActive: dto.isActive ?? true,
          items: {
            create: dto.items.map((i) => ({
              variantId: i.variantId,
              quantity: i.quantity,
            })),
          },
        },
        include: { items: { include: { variant: true } } },
      });
      await this.audit.write({
        actorType: "ADMIN",
        actorId,
        action: "catalog.bundle.create",
        entityType: "Bundle",
        entityId: created.id,
      });
      return this.toBundle(created);
    } catch (e) {
      this.rethrowUnique(e, "Bundle slug");
    }
  }

  async getBundle(id: string, opts?: { requireActive?: boolean }) {
    const b = await this.prisma.bundle.findUnique({
      where: { id },
      include: { items: { include: { variant: true } } },
    });
    if (!b || (opts?.requireActive && !b.isActive)) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Bundle not found" });
    }
    return this.toBundle(b);
  }

  async listBundles(activeOnly = false) {
    const rows = await this.prisma.bundle.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      include: { items: { include: { variant: true } } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((b) => this.toBundle(b));
  }

  // ——— Publish guards ———

  private async assertPublishable(
    productId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const p = await tx.product.findUnique({
      where: { id: productId },
      include: {
        category: true,
        translations: true,
        variants: { where: { isActive: true } },
        images: true,
      },
    });
    if (!p) throw new NotFoundException({ error: "NOT_FOUND", message: "Product not found" });

    const company = await tx.companySettings.findUnique({ where: { id: "default" } });

    if (p.category.gpsrCatalogTier === "restricted") {
      throw new ConflictException({
        error: "PUBLISH_BLOCKED",
        message: "P1: Category GPSR tier is restricted",
      });
    }

    const manufacturer = this.resolveManufacturer(p, company);
    if (!this.isManufacturerComplete(manufacturer)) {
      throw new ConflictException({
        error: "PUBLISH_BLOCKED",
        message: "P2: Manufacturer information incomplete",
      });
    }

    if (manufacturer.establishedInUnion === false && !this.isEuRpComplete(this.resolveEuRp(p, company))) {
      throw new ConflictException({
        error: "PUBLISH_BLOCKED",
        message: "P3: EU responsible person required and incomplete",
      });
    }

    if (p.safetyInformationRequired) {
      const de = p.translations.find((t) => t.locale === "de");
      if (!de?.safetyInformationMarkdown?.trim()) {
        throw new ConflictException({
          error: "PUBLISH_BLOCKED",
          message: "P4: German safety information required",
        });
      }
    }

    const activeVariants = p.variants.filter((v) => v.isActive);
    if (!activeVariants.length) {
      throw new ConflictException({
        error: "PUBLISH_BLOCKED",
        message: "P5: At least one active variant required",
      });
    }

    const primaryUrl = this.resolvePrimaryImageUrl(p.images);
    if (!primaryUrl) {
      throw new ConflictException({
        error: "PUBLISH_BLOCKED",
        message: "P6: At least one image required",
      });
    }

    for (const v of activeVariants) {
      if (!v.sku?.trim()) {
        throw new ConflictException({
          error: "PUBLISH_BLOCKED",
          message: "P5: Active variant missing SKU",
        });
      }
    }

    const grundRequired = grundpreisEffectiveRequired(
      p.category.requiresGrundpreis,
      p.grundpreisRequirement,
    );
    if (grundRequired) {
      for (const v of activeVariants) {
        if (!v.grundpreisAmount || !isAllowedGrundpreisUnit(v.grundpreisUnit)) {
          throw new ConflictException({
            error: "PUBLISH_BLOCKED",
            message: "L5: Grundpreis amount and allowed unit required on active variants",
          });
        }
      }
    }
  }

  // ——— helpers ———

  private effectiveActive(cat: CategoryRow, byId: Map<string, CategoryRow>): boolean {
    if (!cat.isActive) return false;
    let current: CategoryRow | undefined = cat;
    while (current?.parentId) {
      const parent = byId.get(current.parentId);
      if (!parent?.isActive) return false;
      current = parent;
    }
    return true;
  }

  private async loadCategoryMaps() {
    const rows = await this.prisma.category.findMany();
    const byId = new Map<string, CategoryRow>();
    const bySlug = new Map<string, CategoryRow>();
    for (const c of rows) {
      byId.set(c.id, c);
      bySlug.set(c.slug, c);
    }
    return { byId, bySlug };
  }

  private resolveCategoryPath(categoryId: string, byId: Map<string, CategoryRow>) {
    const chain: CategoryRow[] = [];
    let current = byId.get(categoryId);
    while (current) {
      chain.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return chain.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      effectiveActive: this.effectiveActive(c, byId),
    }));
  }

  private resolveTranslation(
    product: {
      name: string;
      description: string;
      seoTitle: string | null;
      seoDescription: string | null;
      translations: Array<{
        locale: string;
        name: string;
        description: string;
        seoTitle: string | null;
        seoDescription: string | null;
      }>;
    },
    locale: "de" | "en" | "ar",
  ) {
    const pick = (loc: string) => product.translations.find((t) => t.locale === loc);
    const chosen = pick(locale) ?? pick("de");
    if (chosen) {
      return {
        name: chosen.name,
        description: chosen.description,
        seoTitle: chosen.seoTitle,
        seoDescription: chosen.seoDescription,
      };
    }
    return {
      name: product.name,
      description: product.description,
      seoTitle: product.seoTitle,
      seoDescription: product.seoDescription,
    };
  }

  private resolvePrimaryImageUrl(images: ImageRow[]): string | null {
    const sorted = [...images].sort((a, b) => a.sortOrder - b.sortOrder);
    const productLevel = sorted.find((i) => i.variantId == null);
    const chosen = productLevel ?? sorted[0];
    return chosen ? toPublicObjectUrl(chosen.objectKey) : null;
  }

  private resolvePdpImages(
    images: ImageRow[],
    optionMode: "simple" | "variable",
    selectedVariantId: string | null,
    defaultVariantId: string | null,
  ): ImageRow[] {
    const sorted = [...images].sort((a, b) => a.sortOrder - b.sortOrder);
    if (optionMode === "simple") return sorted;

    if (selectedVariantId) {
      const variantImgs = sorted.filter((i) => i.variantId === selectedVariantId);
      const general = sorted.filter(
        (i) => i.variantId == null && !variantImgs.some((v) => v.objectKey === i.objectKey),
      );
      return [...variantImgs, ...general];
    }

    const productLevel = sorted.filter((i) => i.variantId == null);
    if (productLevel.length) return productLevel;
    if (defaultVariantId) {
      return sorted.filter((i) => i.variantId === defaultVariantId);
    }
    return [];
  }

  private async getAvailableQty(variantId: string, locationId: string): Promise<number> {
    try {
      return await this.inventory.available(variantId, locationId);
    } catch (e) {
      if (e instanceof NotFoundException) return 0;
      throw e;
    }
  }

  private buildPriceDisplay(input: {
    optionMode: "simple" | "variable";
    variants: Array<{
      id: string;
      price: Prisma.Decimal;
      isActive: boolean;
      grundpreisAmount: Prisma.Decimal | null;
      grundpreisUnit: string | null;
    }>;
    availability: Map<string, number>;
    selectedVariantId: string | null;
    isKleinunternehmer: boolean;
    categoryRequiresGrundpreis: boolean;
    grundpreisRequirement: "inherit" | "require" | "exempt";
  }) {
    const taxMode = input.isKleinunternehmer ? "KLEINUNTERNEHMER" : "VAT";
    const taxNote = input.isKleinunternehmer ? "§19 UStG" : undefined;
    const grundRequired = grundpreisEffectiveRequired(
      input.categoryRequiresGrundpreis,
      input.grundpreisRequirement,
    );

    const activeWithStock = input.variants.filter(
      (v) => v.isActive && (input.availability.get(v.id) ?? 0) >= 1,
    );

    const resolveGrundpreis = (v: (typeof input.variants)[0]) => {
      if (!grundRequired && !(v.grundpreisAmount && v.grundpreisUnit)) return undefined;
      if (v.grundpreisAmount && v.grundpreisUnit) {
        return { amount: v.grundpreisAmount.toString(), unit: v.grundpreisUnit };
      }
      return undefined;
    };

    if (input.selectedVariantId) {
      const v = input.variants.find((x) => x.id === input.selectedVariantId);
      if (v) {
        return {
          mode: "single" as const,
          amount: money(v.price),
          currency: "EUR" as const,
          taxMode,
          taxNote,
          grundpreis: resolveGrundpreis(v),
        };
      }
    }

    if (input.optionMode === "simple") {
      const v = input.variants.find((x) => x.isActive);
      return {
        mode: "single" as const,
        amount: v ? money(v.price) : null,
        currency: "EUR" as const,
        taxMode,
        taxNote,
        grundpreis: v ? resolveGrundpreis(v) : undefined,
      };
    }

    const prices = activeWithStock.map((v) => v.price);
    const min = minDecimal(prices);
    const max = maxDecimal(prices);
    if (!min) {
      const fallback = input.variants.filter((v) => v.isActive).map((v) => v.price);
      const fbMin = minDecimal(fallback);
      const fbMax = maxDecimal(fallback);
      return {
        mode: fbMin && fbMax && !fbMin.eq(fbMax) ? ("range" as const) : ("single" as const),
        amount: fbMin && fbMax && fbMin.eq(fbMax) ? money(fbMin) : undefined,
        amountMin: fbMin ? money(fbMin) : undefined,
        amountMax: fbMax && fbMin && !fbMin.eq(fbMax) ? money(fbMax) : undefined,
        currency: "EUR" as const,
        taxMode,
        taxNote,
      };
    }

    if (max && !min.eq(max)) {
      return {
        mode: "range" as const,
        amountMin: money(min),
        amountMax: money(max),
        currency: "EUR" as const,
        taxMode,
        taxNote,
      };
    }

    const v = activeWithStock[0] ?? input.variants.find((x) => x.isActive);
    return {
      mode: "single" as const,
      amount: min ? money(min) : null,
      currency: "EUR" as const,
      taxMode,
      taxNote,
      grundpreis: v ? resolveGrundpreis(v) : undefined,
    };
  }

  private resolveSizeGuide(
    categoryId: string,
    byId: Map<string, CategoryRow>,
    optionMode: "simple" | "variable",
    axes: Array<{ key: string }>,
  ) {
    if (optionMode !== "variable") return null;
    if (!axes.some((a) => a.key === "size")) return null;

    let current = byId.get(categoryId);
    while (current) {
      if (current.sizeGuideMarkdown?.trim()) {
        return { format: "markdown" as const, content: current.sizeGuideMarkdown };
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return null;
  }

  private async buildRelatedProducts(
    links: Array<{
      related: {
        id: string;
        slug: string;
        name: string;
        isActive: boolean;
        images: ImageRow[];
        variants: Array<{ price: Prisma.Decimal }>;
      };
    }>,
  ) {
    const out: Array<{
      id: string;
      slug: string;
      name: string;
      primaryImageUrl: string | null;
      priceFrom: string | null;
    }> = [];

    for (const link of links) {
      const rp = link.related;
      const activeCount = rp.variants.length;
      if (!isProductSellable(rp.isActive, activeCount)) continue;

      const prices = rp.variants.map((v) => v.price);
      const min = minDecimal(prices);
      out.push({
        id: rp.id,
        slug: rp.slug,
        name: rp.name,
        primaryImageUrl: this.resolvePrimaryImageUrl(rp.images),
        priceFrom: min ? money(min) : null,
      });
    }
    return out;
  }

  private async previewShipping(
    variantId: string | null,
    variants: Array<{ id: string; weightGrams: number }>,
    company: {
      orderProcessingDaysMin: number | null;
      orderProcessingDaysMax: number | null;
    } | null,
  ) {
    try {
      if (!variantId) {
        return {
          isPreview: true,
          note: "Voraussichtlich · endgültige Lieferzeit im Checkout",
        };
      }
      const variant = variants.find((v) => v.id === variantId);
      if (!variant) return undefined;

      const method = await this.prisma.shippingMethod.findFirst({
        where: { code: V1_SHIPPING_METHOD, isActive: true },
      });
      const zone = await this.prisma.shippingZone.findFirst({ where: { countryCode: "DE" } });
      if (!method || !zone) return undefined;

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
        if (rate.minWeight != null && variant.weightGrams < rate.minWeight) return false;
        if (rate.maxWeight != null && variant.weightGrams > rate.maxWeight) return false;
        return true;
      });
      if (matching.length !== 1) return undefined;

      const rate = matching[0];
      const deliveryTime = this.previewDeliveryTime(company, rate);
      return {
        countryCode: "DE",
        methodCode: V1_SHIPPING_METHOD,
        amount: money(rate.price),
        currency: "EUR",
        isPreview: true,
        note: "Voraussichtlich · endgültige Lieferzeit im Checkout",
        ...(deliveryTime ? { deliveryTime } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private previewDeliveryTime(
    company: {
      orderProcessingDaysMin: number | null;
      orderProcessingDaysMax: number | null;
    } | null,
    rate: { estimatedTransitDaysMin: number; estimatedTransitDaysMax: number },
  ) {
    const processing = this.asValidDaysPair(
      company?.orderProcessingDaysMin ?? null,
      company?.orderProcessingDaysMax ?? null,
    );
    const transit = this.asValidDaysPair(
      rate.estimatedTransitDaysMin,
      rate.estimatedTransitDaysMax,
    );
    if (!processing || !transit) return undefined;
    const deliveryTimeDaysMin = processing.min + transit.min;
    const deliveryTimeDaysMax = processing.max + transit.max;
    return {
      disclosureLevel: "composite" as const,
      labelShown: `Lieferzeit: ${deliveryTimeDaysMin}${WERKTAG_RANGE_DASH}${deliveryTimeDaysMax} Werktage`,
      processingDaysMin: processing.min,
      processingDaysMax: processing.max,
      transitDaysMin: transit.min,
      transitDaysMax: transit.max,
      deliveryTimeDaysMin,
      deliveryTimeDaysMax,
      lieferzeitDaysMin: deliveryTimeDaysMin,
      lieferzeitDaysMax: deliveryTimeDaysMax,
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

  private buildProductSafety(
    product: {
      name: string;
      manufacturerSource: string;
      manufacturerDisplayName: string | null;
      manufacturerAddressLine1: string | null;
      manufacturerPostalCode: string | null;
      manufacturerCity: string | null;
      manufacturerCountryCode: string | null;
      manufacturerEstablishedInUnion: boolean | null;
      manufacturerEmail: string | null;
      euResponsiblePersonDisplayName: string | null;
      euResponsiblePersonAddressLine1: string | null;
      euResponsiblePersonPostalCode: string | null;
      euResponsiblePersonCity: string | null;
      euResponsiblePersonCountryCode: string | null;
      euResponsiblePersonEmail: string | null;
      safetyInformationRequired: boolean;
      translations: Array<{ locale: string; safetyInformationMarkdown: string | null }>;
      variants: Array<{ sku: string; ean: string | null; name: string | null; isActive: boolean }>;
    },
    images: ImageRow[],
    company: {
      defaultManufacturerDisplayName: string | null;
      defaultManufacturerAddressLine1: string | null;
      defaultManufacturerPostalCode: string | null;
      defaultManufacturerCity: string | null;
      defaultManufacturerCountryCode: string | null;
      defaultManufacturerEstablishedInUnion: boolean | null;
      defaultManufacturerEmail: string | null;
      defaultEuResponsiblePersonDisplayName: string | null;
      defaultEuResponsiblePersonAddressLine1: string | null;
      defaultEuResponsiblePersonPostalCode: string | null;
      defaultEuResponsiblePersonCity: string | null;
      defaultEuResponsiblePersonCountryCode: string | null;
      defaultEuResponsiblePersonEmail: string | null;
    } | null,
  ) {
    const manufacturer = this.resolveManufacturer(product, company);
    const euRp = this.resolveEuRp(product, company);
    const primaryImageUrl = this.resolvePrimaryImageUrl(images);
    const activeVariant = product.variants.find((v) => v.isActive);
    const deSafety = product.translations.find((t) => t.locale === "de")?.safetyInformationMarkdown;

    const manufacturerComplete = this.isManufacturerComplete(manufacturer);
    const euRpComplete =
      manufacturer.establishedInUnion !== false || this.isEuRpComplete(euRp);
    const identifiersComplete = Boolean(activeVariant?.sku && product.name && primaryImageUrl);
    const safetyComplete =
      !product.safetyInformationRequired || Boolean(deSafety?.trim());

    const completeness =
      manufacturerComplete && euRpComplete && identifiersComplete && safetyComplete
        ? ("complete" as const)
        : ("incomplete" as const);

    return {
      manufacturer: {
        displayName: manufacturer.displayName,
        addressLine1: manufacturer.addressLine1,
        postalCode: manufacturer.postalCode,
        city: manufacturer.city,
        countryCode: manufacturer.countryCode,
        email: manufacturer.email,
        establishedInUnion: manufacturer.establishedInUnion,
        source: product.manufacturerSource,
      },
      ...(manufacturer.establishedInUnion === false && euRp.displayName
        ? {
            euResponsiblePerson: {
              displayName: euRp.displayName,
              addressLine1: euRp.addressLine1,
              postalCode: euRp.postalCode,
              city: euRp.city,
              countryCode: euRp.countryCode,
              email: euRp.email,
            },
          }
        : {}),
      identifiers: {
        sku: activeVariant?.sku ?? "",
        ean: activeVariant?.ean ?? undefined,
        productName: product.name,
        variantLabel: activeVariant?.name ?? undefined,
        displayLabel: activeVariant?.sku ?? product.name,
        primaryImageUrl: primaryImageUrl ?? undefined,
      },
      ...(deSafety?.trim()
        ? {
            safetyInformation: {
              locale: "de" as const,
              format: "markdown" as const,
              content: deSafety,
            },
          }
        : {}),
      safetyInformationRequired: product.safetyInformationRequired,
      completeness,
    };
  }

  private resolveManufacturer(
    product: {
      manufacturerSource: string;
      manufacturerDisplayName: string | null;
      manufacturerAddressLine1: string | null;
      manufacturerPostalCode: string | null;
      manufacturerCity: string | null;
      manufacturerCountryCode: string | null;
      manufacturerEstablishedInUnion: boolean | null;
      manufacturerEmail: string | null;
    },
    company: {
      defaultManufacturerDisplayName: string | null;
      defaultManufacturerAddressLine1: string | null;
      defaultManufacturerPostalCode: string | null;
      defaultManufacturerCity: string | null;
      defaultManufacturerCountryCode: string | null;
      defaultManufacturerEstablishedInUnion: boolean | null;
      defaultManufacturerEmail: string | null;
    } | null,
  ) {
    if (product.manufacturerSource === "product_specific") {
      return {
        displayName: product.manufacturerDisplayName,
        addressLine1: product.manufacturerAddressLine1,
        postalCode: product.manufacturerPostalCode,
        city: product.manufacturerCity,
        countryCode: product.manufacturerCountryCode,
        email: product.manufacturerEmail,
        establishedInUnion: product.manufacturerEstablishedInUnion,
      };
    }
    return {
      displayName: company?.defaultManufacturerDisplayName ?? null,
      addressLine1: company?.defaultManufacturerAddressLine1 ?? null,
      postalCode: company?.defaultManufacturerPostalCode ?? null,
      city: company?.defaultManufacturerCity ?? null,
      countryCode: company?.defaultManufacturerCountryCode ?? null,
      email: company?.defaultManufacturerEmail ?? null,
      establishedInUnion: company?.defaultManufacturerEstablishedInUnion ?? null,
    };
  }

  private resolveEuRp(
    product: {
      manufacturerSource: string;
      euResponsiblePersonDisplayName: string | null;
      euResponsiblePersonAddressLine1: string | null;
      euResponsiblePersonPostalCode: string | null;
      euResponsiblePersonCity: string | null;
      euResponsiblePersonCountryCode: string | null;
      euResponsiblePersonEmail: string | null;
    },
    company: {
      defaultEuResponsiblePersonDisplayName: string | null;
      defaultEuResponsiblePersonAddressLine1: string | null;
      defaultEuResponsiblePersonPostalCode: string | null;
      defaultEuResponsiblePersonCity: string | null;
      defaultEuResponsiblePersonCountryCode: string | null;
      defaultEuResponsiblePersonEmail: string | null;
    } | null,
  ) {
    if (product.manufacturerSource === "product_specific") {
      return {
        displayName: product.euResponsiblePersonDisplayName,
        addressLine1: product.euResponsiblePersonAddressLine1,
        postalCode: product.euResponsiblePersonPostalCode,
        city: product.euResponsiblePersonCity,
        countryCode: product.euResponsiblePersonCountryCode,
        email: product.euResponsiblePersonEmail,
      };
    }
    return {
      displayName: company?.defaultEuResponsiblePersonDisplayName ?? null,
      addressLine1: company?.defaultEuResponsiblePersonAddressLine1 ?? null,
      postalCode: company?.defaultEuResponsiblePersonPostalCode ?? null,
      city: company?.defaultEuResponsiblePersonCity ?? null,
      countryCode: company?.defaultEuResponsiblePersonCountryCode ?? null,
      email: company?.defaultEuResponsiblePersonEmail ?? null,
    };
  }

  private isManufacturerComplete(m: {
    displayName: string | null;
    addressLine1: string | null;
    postalCode: string | null;
    city: string | null;
    countryCode: string | null;
    establishedInUnion: boolean | null;
  }) {
    return Boolean(
      m.displayName?.trim() &&
        m.addressLine1?.trim() &&
        m.postalCode?.trim() &&
        m.city?.trim() &&
        m.countryCode?.trim() &&
        m.establishedInUnion !== null &&
        m.establishedInUnion !== undefined,
    );
  }

  private isEuRpComplete(rp: {
    displayName: string | null;
    addressLine1: string | null;
    postalCode: string | null;
    city: string | null;
    countryCode: string | null;
  }) {
    return Boolean(
      rp.displayName?.trim() &&
        rp.addressLine1?.trim() &&
        rp.postalCode?.trim() &&
        rp.city?.trim() &&
        rp.countryCode?.trim(),
    );
  }

  private async isReviewable(userId: string, productId: string): Promise<boolean> {
    const item = await this.prisma.orderItem.findFirst({
      where: {
        variant: { productId },
        order: {
          userId,
          status: { not: OrderStatus.CANCELLED },
          paymentStatus: PaymentStatus.PAID,
        },
      },
      select: { id: true },
    });
    return Boolean(item);
  }

  private async isInWishlist(userId: string, productId: string): Promise<boolean> {
    const item = await this.prisma.wishlistItem.findFirst({
      where: { userId, variant: { productId } },
      select: { id: true },
    });
    return Boolean(item);
  }

  private validateGrundpreisFields(amount?: string | null, unit?: string | null) {
    if (amount && !isAllowedGrundpreisUnit(unit)) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "grundpreisUnit must be from allowed list",
      });
    }
    if (unit && !amount) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "grundpreisAmount required when unit is set",
      });
    }
  }

  private async validateVariantAttributes(
    productId: string,
    excludeVariantId: string | undefined,
    attrs: Record<string, string | number | boolean>,
  ) {
    const fingerprint = attributeFingerprint(attrs);
    const siblings = await this.prisma.productVariant.findMany({
      where: {
        productId,
        ...(excludeVariantId ? { id: { not: excludeVariantId } } : {}),
      },
    });

    for (const s of siblings) {
      if (attributeFingerprint(s.attributesJson) === fingerprint) {
        throw new ConflictException({
          error: "CONFLICT",
          message: "Duplicate variant attribute combination",
        });
      }
    }

    const active = siblings.filter((s) => s.isActive && s.id !== excludeVariantId);
    const newKeys = attributeKeys(attrs);
    if (active.length) {
      const refKeys = attributeKeys(active[0].attributesJson);
      if (!sameKeySet(refKeys, newKeys)) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: "Active variants must share the same attribute keys",
        });
      }
    }
  }

  private toBundle(b: {
    id: string;
    name: string;
    slug: string;
    discountPercent: Prisma.Decimal | null;
    isActive: boolean;
    items: {
      id: string;
      quantity: number;
      variantId: string;
      variant: { sku: string; price: Prisma.Decimal; isActive: boolean };
    }[];
  }) {
    return {
      id: b.id,
      name: b.name,
      slug: b.slug,
      discountPercent: b.discountPercent?.toString() ?? null,
      isActive: b.isActive,
      items: b.items.map((i) => ({
        id: i.id,
        variantId: i.variantId,
        quantity: i.quantity,
        sku: i.variant.sku,
        unitPrice: money(i.variant.price),
        variantActive: i.variant.isActive,
      })),
      note: "On sale, inventory deducts each component × quantity (step 10.3/10.8)",
    };
  }

  private toPublicProductCard(p: {
    id: string;
    slug: string;
    name: string;
    brand: { name: string } | null;
    category: { slug: string; name: string };
    images: ImageRow[];
    variants: { id: string; price: Prisma.Decimal; sku: string }[];
  }) {
    const prices = p.variants.map((v) => v.price);
    const min = minDecimal(prices);
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      brand: p.brand?.name ?? null,
      category: p.category,
      primaryImageUrl: this.resolvePrimaryImageUrl(p.images),
      sellable: true,
      priceFrom: min ? money(min) : null,
    };
  }

  private async requireCategory(id: string) {
    const c = await this.prisma.category.findUnique({ where: { id } });
    if (!c) throw new NotFoundException({ error: "NOT_FOUND", message: "Category not found" });
    return c;
  }

  private async requireBrand(id: string) {
    const b = await this.prisma.brand.findUnique({ where: { id } });
    if (!b) throw new NotFoundException({ error: "NOT_FOUND", message: "Brand not found" });
    return b;
  }

  private async requireProduct(id: string) {
    const p = await this.prisma.product.findUnique({ where: { id } });
    if (!p) throw new NotFoundException({ error: "NOT_FOUND", message: "Product not found" });
    return p;
  }

  private async requireVariant(id: string) {
    const v = await this.prisma.productVariant.findUnique({ where: { id } });
    if (!v) throw new NotFoundException({ error: "NOT_FOUND", message: "Variant not found" });
    return v;
  }

  private rethrowUnique(e: unknown, label: string): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictException({ error: "CONFLICT", message: `${label} already exists` });
    }
    throw e;
  }
}
