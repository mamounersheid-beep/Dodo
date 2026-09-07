import { Controller, Get, Inject, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CmsLegalService } from "./cms-legal.service";

@ApiTags("cms-legal")
@Controller("legal")
export class CmsLegalController {
  constructor(@Inject(CmsLegalService) private readonly svc: CmsLegalService) {}

  @Get("_skeleton")
  skeleton() {
    return this.svc.skeleton();
  }

  /** Public FAQ index — current PUBLISHED `faq-*` DE only. No JWT. Always 200. */
  @Get("faq")
  listPublishedFaq() {
    return this.svc.listPublishedFaq();
  }

  /** Public — current PUBLISHED LegalPage only. No JWT. */
  @Get("pages/:slug")
  getPublished(@Param("slug") slug: string) {
    return this.svc.getPublishedBySlug(slug);
  }
}
