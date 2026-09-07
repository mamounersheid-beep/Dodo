import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@dodo/database";
import { PrismaService } from "../prisma/prisma.service";
import { CatalogService } from "../catalog/catalog.service";
import {
  localeFromAcceptLanguage,
  resolveLocale,
} from "../catalog/catalog.rules";
import type { PatchHomeSectionDto, ReplaceStorePicksDto } from "./dto/home-section.dto";

export const HOME_SECTION_KEYS = ["new_arrivals", "store_picks"] as const;
export type HomeSectionKey = (typeof HOME_SECTION_KEYS)[number];

export const HOME_SECTION_UPDATE_AUDIT = "home.section.update";
export const HOME_SECTION_PRODUCTS_AUDIT = "home.section.products.replace";

const LOCALES = ["de", "en", "ar"] as const;
type Locale = (typeof LOCALES)[number];

function jsonStable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  });
}

function isLocale(v: string): v is Locale {
  return v === "de" || v === "en" || v === "ar";
}

function assertKnownKey(key: string): asserts key is HomeSectionKey {
  if (key !== "new_arrivals" && key !== "store_picks") {
    throw new NotFoundException({ error: "NOT_FOUND", message: "Home section not found" });
  }
}

@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  async getPublicHome(opts: { locale?: string; acceptLanguage?: string }) {
    const locale = resolveLocale(opts.locale ?? localeFromAcceptLanguage(opts.acceptLanguage));
    const sections = await this.prisma.homeSection.findMany({
      where: { enabled: true },
      include: {
        translations: true,
        products: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    });

    const out = [];
    for (const section of sections) {
      const name = this.resolveSectionName(section.translations, locale);
      let products: Awaited<ReturnType<CatalogService["listNewestProductCards"]>>["items"] = [];

      if (section.key === "new_arrivals") {
        const res = await this.catalog.listNewestProductCards({
          limit: section.itemLimit,
          locale,
        });
        products = res.items;
      } else if (section.key === "store_picks") {
        const res = await this.catalog.listProductCardsByIdsOrdered({
          productIds: section.products.map((p) => p.productId),
          limit: section.itemLimit,
          locale,
        });
        products = res.items;
      }

      out.push({
        key: section.key,
        type: section.type,
        name,
        products,
      });
    }

    return { sections: out };
  }

  async listAdminSections() {
    const rows = await this.prisma.homeSection.findMany({
      include: {
        translations: true,
        products: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    });
    return rows.map((r) => this.serializeAdmin(r));
  }

  async getAdminSection(key: string) {
    assertKnownKey(key);
    const row = await this.requireSection(key);
    return this.serializeAdmin(row);
  }

  async patchSection(key: string, dto: PatchHomeSectionDto, actorId: string) {
    assertKnownKey(key);
    const hasEnabled = dto.enabled !== undefined;
    const hasSort = dto.sortOrder !== undefined;
    const hasLimit = dto.itemLimit !== undefined;
    const hasNames = dto.names !== undefined;

    if (!hasEnabled && !hasSort && !hasLimit && !hasNames) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "At least one of enabled, sortOrder, itemLimit, names is required",
      });
    }

    if (hasLimit) {
      const n = dto.itemLimit!;
      if (!Number.isInteger(n) || n < 1 || n > 24) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: "itemLimit must be an integer from 1 to 24",
        });
      }
    }

    if (hasSort && !Number.isInteger(dto.sortOrder!)) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "sortOrder must be an integer",
      });
    }

    const namePatch = hasNames ? this.parseNamesPatch(dto.names!) : null;

    return this.prisma.$transaction(async (tx) => {
      const before = await tx.homeSection.findUnique({
        where: { key },
        include: {
          translations: true,
          products: { orderBy: { sortOrder: "asc" } },
        },
      });
      if (!before) {
        throw new NotFoundException({ error: "NOT_FOUND", message: "Home section not found" });
      }

      const beforeView = this.serializeAdmin(before);

      let namesChanged = false;
      if (namePatch) {
        for (const [locale, name] of Object.entries(namePatch) as [Locale, string][]) {
          const current = before.translations.find((t) => t.locale === locale)?.name;
          if (current !== name) namesChanged = true;
        }
      }

      const configChanged =
        (hasEnabled && before.enabled !== dto.enabled) ||
        (hasSort && before.sortOrder !== dto.sortOrder) ||
        (hasLimit && before.itemLimit !== dto.itemLimit) ||
        namesChanged;

      if (hasEnabled || hasSort || hasLimit) {
        await tx.homeSection.update({
          where: { id: before.id },
          data: {
            ...(hasEnabled ? { enabled: dto.enabled! } : {}),
            ...(hasSort ? { sortOrder: dto.sortOrder! } : {}),
            ...(hasLimit ? { itemLimit: dto.itemLimit! } : {}),
          },
        });
      }

      if (namePatch) {
        for (const [locale, name] of Object.entries(namePatch) as [Locale, string][]) {
          await tx.homeSectionTranslation.update({
            where: { sectionId_locale: { sectionId: before.id, locale } },
            data: { name },
          });
        }
      }

      const after = await tx.homeSection.findUniqueOrThrow({
        where: { id: before.id },
        include: {
          translations: true,
          products: { orderBy: { sortOrder: "asc" } },
        },
      });
      const afterView = this.serializeAdmin(after);

      if (configChanged) {
        await tx.auditLog.create({
          data: {
            actorType: "ADMIN",
            actorId,
            action: HOME_SECTION_UPDATE_AUDIT,
            entityType: "HomeSection",
            entityId: before.id,
            beforeJson: beforeView as Prisma.InputJsonValue,
            afterJson: afterView as Prisma.InputJsonValue,
          },
        });
      }

      return afterView;
    });
  }

  async replaceStorePicks(dto: ReplaceStorePicksDto, actorId: string) {
    if (!Array.isArray(dto.productIds)) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "productIds must be an array",
      });
    }
    if (dto.productIds.length > 24) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "productIds max length is 24",
      });
    }

    const seen = new Set<string>();
    for (const id of dto.productIds) {
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: "productIds must contain non-empty strings",
        });
      }
      if (seen.has(id)) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: "duplicate productIds are not allowed",
        });
      }
      seen.add(id);
    }

    if (dto.productIds.length > 0) {
      const found = await this.prisma.product.findMany({
        where: { id: { in: dto.productIds } },
        select: { id: true },
      });
      if (found.length !== dto.productIds.length) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: "one or more productIds do not exist",
        });
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const section = await tx.homeSection.findUnique({
        where: { key: "store_picks" },
        include: {
          products: { orderBy: { sortOrder: "asc" } },
        },
      });
      if (!section) {
        throw new NotFoundException({ error: "NOT_FOUND", message: "Home section not found" });
      }

      const beforeIds = section.products.map((p) => p.productId);

      await tx.homeSectionProduct.deleteMany({ where: { sectionId: section.id } });
      if (dto.productIds.length > 0) {
        await tx.homeSectionProduct.createMany({
          data: dto.productIds.map((productId, sortOrder) => ({
            sectionId: section.id,
            productId,
            sortOrder,
          })),
        });
      }

      const afterIds = dto.productIds;
      if (jsonStable(beforeIds) !== jsonStable(afterIds)) {
        await tx.auditLog.create({
          data: {
            actorType: "ADMIN",
            actorId,
            action: HOME_SECTION_PRODUCTS_AUDIT,
            entityType: "HomeSection",
            entityId: section.id,
            beforeJson: { productIds: beforeIds } as Prisma.InputJsonValue,
            afterJson: { productIds: afterIds } as Prisma.InputJsonValue,
          },
        });
      }

      return { key: "store_picks" as const, productIds: afterIds };
    });
  }

  private parseNamesPatch(names: NonNullable<PatchHomeSectionDto["names"]>): Partial<Record<Locale, string>> {
    const patch: Partial<Record<Locale, string>> = {};
    for (const key of Object.keys(names) as Array<keyof typeof names>) {
      const raw = names[key];
      if (raw === undefined) continue;
      if (!isLocale(String(key))) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: "names locales must be de, en, or ar",
        });
      }
      if (typeof raw !== "string") {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: `names.${key} must be a string`,
        });
      }
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        throw new BadRequestException({
          error: "VALIDATION_ERROR",
          message: `names.${key} must not be empty`,
        });
      }
      patch[key] = trimmed;
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({
        error: "VALIDATION_ERROR",
        message: "names must include at least one locale",
      });
    }
    return patch;
  }

  private resolveSectionName(
    translations: Array<{ locale: string; name: string }>,
    locale: Locale,
  ): string {
    const hit =
      translations.find((t) => t.locale === locale) ??
      translations.find((t) => t.locale === "de") ??
      translations[0];
    return hit?.name ?? "";
  }

  private async requireSection(key: HomeSectionKey) {
    const row = await this.prisma.homeSection.findUnique({
      where: { key },
      include: {
        translations: true,
        products: { orderBy: { sortOrder: "asc" } },
      },
    });
    if (!row) {
      throw new NotFoundException({ error: "NOT_FOUND", message: "Home section not found" });
    }
    return row;
  }

  private serializeAdmin(row: {
    key: string;
    type: string;
    enabled: boolean;
    sortOrder: number;
    itemLimit: number;
    translations: Array<{ locale: string; name: string }>;
    products: Array<{ productId: string; sortOrder: number }>;
  }) {
    const names: Record<Locale, string> = { de: "", en: "", ar: "" };
    for (const t of row.translations) {
      if (isLocale(t.locale)) names[t.locale] = t.name;
    }
    const base = {
      key: row.key,
      type: row.type,
      enabled: row.enabled,
      sortOrder: row.sortOrder,
      itemLimit: row.itemLimit,
      names,
    };
    if (row.key === "store_picks") {
      return {
        ...base,
        productIds: [...row.products]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((p) => p.productId),
      };
    }
    return base;
  }
}
