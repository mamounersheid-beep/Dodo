import { Controller, Get, Headers, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OptionalJwtAuthGuard } from "../common/guards/optional-jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { AuthUser } from "../auth/auth.types";
import { CatalogService } from "./catalog.service";

@ApiTags("catalog")
@Controller("catalog")
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get("_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }

  @Get("categories")
  listCategories() {
    return this.svc.listCategories();
  }

  @Get("categories/:slug")
  getCategory(@Param("slug") slug: string) {
    return this.svc.getCategoryBySlug(slug);
  }

  @Get("products")
  listProducts(
    @Query("category") categorySlug?: string,
    @Query("brand") brandSlug?: string,
    @Query("q") q?: string,
    @Query("size") size?: string,
    @Query("color") color?: string,
    @Query("priceMin") priceMin?: string,
    @Query("priceMax") priceMax?: string,
    @Query("sort") sort?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("locale") locale?: string,
    @Headers("accept-language") acceptLanguage?: string,
  ) {
    return this.svc.listProducts({
      categorySlug,
      brandSlug,
      q,
      size,
      color,
      priceMin,
      priceMax,
      sort,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      locale,
      acceptLanguage,
    });
  }

  @Get("products/:slug/reviews")
  listProductReviews(
    @Param("slug") slug: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.svc.listProductReviews(slug, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get("products/:slug")
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  getProduct(
    @Param("slug") slug: string,
    @Query("locale") locale?: string,
    @Query("variantId") variantId?: string,
    @Headers("accept-language") acceptLanguage?: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.svc.getProductBySlug(slug, {
      locale,
      acceptLanguage,
      variantId,
      userId: user?.id,
    });
  }

  @Get("variants/:id")
  getVariantForSale(@Param("id") id: string) {
    return this.svc.getActiveVariantForSale(id);
  }

  @Get("bundles")
  listBundles() {
    return this.svc.listBundles(true);
  }

  @Get("bundles/:id")
  getBundle(@Param("id") id: string) {
    return this.svc.getBundle(id, { requireActive: true });
  }
}
