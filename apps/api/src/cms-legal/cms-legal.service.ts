import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** V1 legal CMS — public read is Market DE only (G-LC11). */
export const PUBLIC_LEGAL_COUNTRY_CODE = "DE";

export const PUBLIC_LEGAL_PAGE_FIELDS = [
  "slug",
  "title",
  "body",
  "version",
  "publishedAt",
] as const;

export type PublicLegalPage = {
  slug: string;
  title: string;
  body: string;
  version: string;
  publishedAt: string;
};

@Injectable()
export class CmsLegalService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  skeleton() {
    return { module: "cms-legal", ready: true, commerce: false };
  }

  /**
   * Public current PUBLISHED LegalPage for `slug`.
   * DRAFT / SUPERSEDED-only / unknown → 404, no draft leak (G-LC1).
   */
  async getPublishedBySlug(slug: string): Promise<PublicLegalPage> {
    const trimmed = slug.trim();
    if (trimmed.length === 0) {
      throw new NotFoundException({
        error: "NOT_FOUND",
        message: "Legal page not found",
      });
    }

    const page = await this.prisma.legalPage.findFirst({
      where: {
        slug: trimmed,
        countryCode: PUBLIC_LEGAL_COUNTRY_CODE,
        publishedAt: { not: null },
        supersededAt: null,
      },
    });

    if (!page || page.publishedAt == null) {
      throw new NotFoundException({
        error: "NOT_FOUND",
        message: "Legal page not found",
      });
    }

    return {
      slug: page.slug,
      title: page.title,
      body: page.body,
      version: page.version,
      publishedAt: page.publishedAt.toISOString(),
    };
  }

  /**
   * Public FAQ index — current PUBLISHED `faq-*` DE only.
   * Empty set → `[]` (never 404). Not a general LegalPage list.
   */
  async listPublishedFaq(): Promise<PublicLegalPage[]> {
    const pages = await this.prisma.legalPage.findMany({
      where: {
        slug: { startsWith: "faq-" },
        countryCode: PUBLIC_LEGAL_COUNTRY_CODE,
        publishedAt: { not: null },
        supersededAt: null,
      },
      orderBy: { slug: "asc" },
      select: {
        slug: true,
        title: true,
        body: true,
        version: true,
        publishedAt: true,
      },
    });

    const items: PublicLegalPage[] = [];
    for (const page of pages) {
      if (page.publishedAt == null) continue;
      items.push({
        slug: page.slug,
        title: page.title,
        body: page.body,
        version: page.version,
        publishedAt: page.publishedAt.toISOString(),
      });
    }
    return items;
  }
}
