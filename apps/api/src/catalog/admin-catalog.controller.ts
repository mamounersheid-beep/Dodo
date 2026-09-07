import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RoleCode } from "@dodo/shared-types";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { AuthUser } from "../auth/auth.types";
import { CatalogService } from "./catalog.service";
import {
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

@ApiTags("admin-catalog")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleCode.ADMIN, RoleCode.OWNER)
@Controller("admin/catalog")
export class AdminCatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Post("categories")
  createCategory(@Body() dto: CreateCategoryDto, @CurrentUser() user: AuthUser) {
    return this.svc.createCategory(dto, user.id);
  }

  @Patch("categories/:id")
  updateCategory(
    @Param("id") id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.updateCategory(id, dto, user.id);
  }

  @Post("brands")
  createBrand(@Body() dto: CreateBrandDto, @CurrentUser() user: AuthUser) {
    return this.svc.createBrand(dto, user.id);
  }

  @Get("brands")
  listBrands() {
    return this.svc.listBrands();
  }

  @Post("products")
  createProduct(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser) {
    return this.svc.createProduct(dto, user.id);
  }

  @Get("products/:id")
  getProduct(@Param("id") id: string) {
    return this.svc.adminGetProduct(id);
  }

  @Patch("products/:id")
  updateProduct(
    @Param("id") id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.updateProduct(id, dto, user.id);
  }

  @Put("products/:id/translations")
  upsertProductTranslation(
    @Param("id") id: string,
    @Body() dto: UpsertProductTranslationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.upsertProductTranslation(id, dto, user.id);
  }

  @Post("products/:productId/related")
  linkRelatedProduct(
    @Param("productId") productId: string,
    @Body() dto: LinkRelatedProductDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.linkRelatedProduct(productId, dto, user.id);
  }

  @Delete("products/:productId/related/:relatedProductId")
  unlinkRelatedProduct(
    @Param("productId") productId: string,
    @Param("relatedProductId") relatedProductId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.unlinkRelatedProduct(productId, relatedProductId, user.id);
  }

  @Post("products/:productId/variants")
  createVariant(
    @Param("productId") productId: string,
    @Body() dto: CreateVariantDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.createVariant(productId, dto, user.id);
  }

  @Patch("variants/:id")
  updateVariant(
    @Param("id") id: string,
    @Body() dto: UpdateVariantDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.updateVariant(id, dto, user.id);
  }

  @Delete("variants/:id")
  deleteVariant(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.svc.deleteVariant(id, user.id);
  }

  @Post("products/:productId/images")
  addImage(
    @Param("productId") productId: string,
    @Body() dto: CreateImageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.addImage(productId, dto, user.id);
  }

  @Delete("images/:id")
  deleteImage(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.svc.deleteImage(id, user.id);
  }

  @Post("bundles")
  createBundle(@Body() dto: CreateBundleDto, @CurrentUser() user: AuthUser) {
    return this.svc.createBundle(dto, user.id);
  }

  @Get("bundles")
  listBundles() {
    return this.svc.listBundles(false);
  }

  @Get("bundles/:id")
  getBundle(@Param("id") id: string) {
    return this.svc.getBundle(id);
  }
}
