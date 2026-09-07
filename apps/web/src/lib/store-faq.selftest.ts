/**
 * Storefront /help/faq — published FAQ index from GET /v1/legal/faq only.
 * Run: pnpm --filter @dodo/web test:store-faq
 *
 *   FQ1 — /help/faq consumes the FAQ list endpoint
 *   FQ2 — 200 [] renders empty state (not notFound)
 *   FQ3 — no /help/faq/:slug route
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FAQ_LIST_PATH,
  faqViewFromListResponse,
  parsePublicFaqList,
  publicFaqListUrl,
} from "./store-faq";
import { PUBLIC_LEGAL_PAGE_FIELDS } from "./store-legal-page";

type Result = { id: string; status: "PASS" | "FAIL"; note?: string };

function printSummary(results: Result[]): void {
  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`${r.status}  ${r.id}${r.note ? ` — ${r.note}` : ""}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const publishedFaq = {
  slug: "faq-versand",
  title: "Versand",
  body: "FAQ Versand — veröffentlichter Text.",
  version: "v1",
  publishedAt: "2026-09-05T00:00:00.000Z",
  publishNote: "MUST-NOT-CONSUME",
  id: "secret-id",
  consentMigrationPolicy: { kind: "NO_ACTION" },
};

async function main(): Promise<void> {
  const results: Result[] = [];
  const ids = ["FQ1", "FQ2", "FQ3"] as const;

  const run = async (id: (typeof ids)[number], fn: () => void) => {
    try {
      fn();
      results.push({ id, status: "PASS" });
    } catch (e) {
      results.push({
        id,
        status: "FAIL",
        note: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const libSrc = readFileSync(join(process.cwd(), "src/lib/store-faq.ts"), "utf8");
  const pageSrc = readFileSync(join(process.cwd(), "src/app/help/faq/page.tsx"), "utf8");
  const legalClientSrc = readFileSync(join(process.cwd(), "src/lib/store-legal-page.ts"), "utf8");
  const impressumPage = readFileSync(join(process.cwd(), "src/app/impressum/page.tsx"), "utf8");
  const agbPage = readFileSync(join(process.cwd(), "src/app/agb/page.tsx"), "utf8");
  const datenschutzPage = readFileSync(join(process.cwd(), "src/app/datenschutz/page.tsx"), "utf8");
  const widerrufPage = readFileSync(join(process.cwd(), "src/app/widerruf/page.tsx"), "utf8");
  const footerSrc = readFileSync(join(process.cwd(), "src/components/store-footer.tsx"), "utf8");
  const headerSrc = readFileSync(join(process.cwd(), "src/components/store-header.tsx"), "utf8");
  const layoutSrc = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
  const titleSrc = readFileSync(join(process.cwd(), "src/lib/store-document-title.ts"), "utf8");
  const helpFaqDir = join(process.cwd(), "src/app/help/faq");
  const helpDir = join(process.cwd(), "src/app/help");

  await run("FQ1", () => {
    assert(FAQ_LIST_PATH === "/legal/faq", "path");
    assert(
      publicFaqListUrl("http://localhost:3001/v1") === "http://localhost:3001/v1/legal/faq",
      "url",
    );
    assert(libSrc.includes("fetchPublishedFaqList"), "uses FAQ list fetch");
    assert(libSrc.includes(FAQ_LIST_PATH) || libSrc.includes("/legal/faq"), "FAQ list path");
    assert(!libSrc.includes("/legal/pages"), "must not use single-slug GET");
    assert(!libSrc.includes("fetchPublishedLegalPage"), "must not call single-slug helper");
    assert(pageSrc.includes("loadFaq"), "page loads FAQ lib");
    assert(pageSrc.includes("view.articles"), "renders list");
    assert(pageSrc.includes("article.title"), "renders article title as heading");
    assert(pageSrc.includes("article.body"), "renders article body");
    assert(pageSrc.includes('export const dynamic = "force-dynamic"'), "live content");
    assert(!pageSrc.includes("notFound"), "index must not 404");
    assert(!pageSrc.includes("generateMetadata"), "no page seoTitle");
    assert(!pageSrc.includes("prisma"), "no Prisma");
    assert(!libSrc.includes("prisma"), "lib no Prisma");
    assert(!pageSrc.includes("/v1/admin"), "no Admin");
    assert(!libSrc.includes("/store/identity"), "no identity");
    assert(!libSrc.includes("/store/status"), "no store/status");
    assert(!libSrc.includes("legalFaq"), "no legalFaq snapshot");
    assert(!pageSrc.includes("category"), "no FAQ categories");
    assert(!pageSrc.includes("store-help"), "FAQ page is not the Help Hub");

    const view = faqViewFromListResponse({
      faqStatus: 200,
      faqBody: [publishedFaq],
    });
    assert(view.kind === "list", `kind=${view.kind}`);
    assert(view.articles.length === 1, "one article");
    assert(view.articles[0]?.slug === "faq-versand", "slug");
    assert(view.articles[0]?.title === "Versand", "title is article heading");
    assert(view.articles[0]?.body === publishedFaq.body, "body");
    assert(!("publishNote" in view.articles[0]!), "publishNote dropped");
    assert(!("id" in view.articles[0]!), "id dropped");

    const parsed = parsePublicFaqList([
      { ...publishedFaq, slug: "impressum" },
      publishedFaq,
    ]);
    assert(parsed !== null, "list parses");
    assert(parsed?.length === 1, "non-faq slug dropped");
    if (parsed?.[0]) {
      for (const key of Object.keys(parsed[0])) {
        assert(
          (PUBLIC_LEGAL_PAGE_FIELDS as readonly string[]).includes(key),
          `unexpected consumed field ${key}`,
        );
      }
    }

    assert(!impressumPage.includes("store-faq"), "impressum unchanged");
    assert(!agbPage.includes("store-faq"), "agb unchanged");
    assert(!datenschutzPage.includes("store-faq"), "datenschutz unchanged");
    assert(!widerrufPage.includes("store-faq"), "widerruf unchanged");
    assert(!legalClientSrc.includes("/legal/faq"), "single-slug client unchanged");
    assert(!footerSrc.includes("/help/faq"), "Footer inventory unchanged");
    assert(!headerSrc.includes("/help/faq"), "Header unchanged");
    assert(!layoutSrc.includes("help/faq"), "layout unchanged");
    assert(!titleSrc.includes("faq"), "document-title unchanged");
  });

  await run("FQ2", () => {
    const empty = faqViewFromListResponse({ faqStatus: 200, faqBody: [] });
    assert(empty.kind === "list", "empty is still a list");
    assert(empty.articles.length === 0, "[] → no articles");
    assert(pageSrc.includes("view.articles.length === 0"), "page branches on empty");
    assert(pageSrc.includes("data-faq-empty"), "empty state marker");
    assert(!pageSrc.includes("notFound()"), "empty must not Next 404");
    assert(!pageSrc.includes("notFound"), "no notFound import");

    const failed = faqViewFromListResponse({
      faqStatus: 404,
      faqBody: { code: "NOT_FOUND" },
    });
    assert(failed.kind === "list" && failed.articles.length === 0, "non-200 is not a page 404");

    const identityAsList = faqViewFromListResponse({
      faqStatus: 200,
      faqBody: { legalName: "Beispiel Firma UG" },
    });
    assert(identityAsList.articles.length === 0, "identity JSON is not a FAQ list");
  });

  await run("FQ3", () => {
    assert(existsSync(join(helpFaqDir, "page.tsx")), "/help/faq page exists");
    const names = readdirSync(helpFaqDir);
    assert(!names.some((n) => n.includes("[") || n.includes("slug")), "no slug segment under /help/faq");
    const helpNames = readdirSync(helpDir);
    assert(!helpNames.some((n) => n.includes("[")), "no dynamic segment under /help");
    assert(!existsSync(join(helpFaqDir, "[slug]")), "no [slug] dir");
    assert(!existsSync(join(helpFaqDir, "[slug]/page.tsx")), "no /help/faq/:slug page");
    assert(!pageSrc.includes("params.slug"), "page is not a slug detail");
    assert(!pageSrc.includes("fetchPublishedLegalPage"), "no article GET");
    assert(!libSrc.includes("/legal/pages/"), "lib has no article GET");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(`\nStorefront /help/faq: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`);
    process.exit(1);
  }
  console.log(`\nStorefront /help/faq: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
