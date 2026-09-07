/**
 * Storefront /agb — current PUBLISHED LegalPage only.
 * Run: pnpm --filter @dodo/web test:store-agb
 *
 *   AG1 — published AGB → page (title + body)
 *   AG2 — no current PUBLISHED → not_found (/agb 404)
 *   AG3 — draft / admin fields are not consumed
 *   AG4 — identity-only is never a valid AGB
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGB_SLUG, agbViewFromLegalResponse, isValidPublishedAgb } from "./store-agb";
import {
  LEGAL_PAGES_PATH,
  PUBLIC_LEGAL_PAGE_FIELDS,
  parsePublicLegalPage,
  publicLegalPageUrl,
} from "./store-legal-page";

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

const publishedAgb = {
  slug: "agb",
  title: "AGB",
  body: "Allgemeine Geschäftsbedingungen — veröffentlichter Text.",
  version: "v1",
  publishedAt: "2026-09-05T00:00:00.000Z",
  publishNote: "MUST-NOT-CONSUME",
  id: "secret-id",
  consentMigrationPolicy: { kind: "NO_ACTION" },
};

const identityBody = {
  legalName: "Beispiel Firma UG",
  line1: "Musterstraße 1",
  postalCode: "10115",
  city: "Berlin",
  countryCode: "DE",
};

async function main(): Promise<void> {
  const results: Result[] = [];
  const ids = ["AG1", "AG2", "AG3", "AG4"] as const;

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

  const libSrc = readFileSync(join(process.cwd(), "src/lib/store-agb.ts"), "utf8");
  const clientSrc = readFileSync(join(process.cwd(), "src/lib/store-legal-page.ts"), "utf8");
  const pageSrc = readFileSync(join(process.cwd(), "src/app/agb/page.tsx"), "utf8");
  const impressumPage = readFileSync(join(process.cwd(), "src/app/impressum/page.tsx"), "utf8");
  const footerSrc = readFileSync(join(process.cwd(), "src/components/store-footer.tsx"), "utf8");
  const headerSrc = readFileSync(join(process.cwd(), "src/components/store-header.tsx"), "utf8");
  const layoutSrc = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
  const titleSrc = readFileSync(join(process.cwd(), "src/lib/store-document-title.ts"), "utf8");

  await run("AG1", () => {
    assert(AGB_SLUG === "agb", "slug");
    assert(LEGAL_PAGES_PATH === "/legal/pages", "path");
    assert(
      publicLegalPageUrl("http://localhost:3001/v1", "agb") === "http://localhost:3001/v1/legal/pages/agb",
      "url",
    );
    assert(libSrc.includes("fetchPublishedLegalPage"), "uses shared public GET");
    assert(libSrc.includes("AGB_SLUG") || libSrc.includes("\"agb\""), "slug agb");
    assert(pageSrc.includes("loadAgb"), "page loads AGB lib");
    assert(pageSrc.includes("notFound"), "page uses notFound");
    assert(pageSrc.includes("view.page.title"), "renders title");
    assert(pageSrc.includes("view.page.body"), "renders body");
    assert(!pageSrc.includes("prisma"), "no Prisma");
    assert(!libSrc.includes("prisma"), "lib no Prisma");
    assert(!clientSrc.includes("prisma"), "client no Prisma");
    assert(!pageSrc.includes("/v1/admin"), "no Admin");
    assert(!libSrc.includes("/store/identity"), "no identity");
    assert(!libSrc.includes("/store/status"), "no store/status");
    assert(!pageSrc.includes("generateMetadata"), "no page seoTitle");
    assert(!pageSrc.includes("datenschutz"), "not Datenschutz");
    assert(!pageSrc.includes("widerruf"), "not Widerruf");
    assert(!impressumPage.includes("/agb"), "impressum unchanged");

    const view = agbViewFromLegalResponse({
      legalStatus: 200,
      legalBody: publishedAgb,
    });
    assert(view.kind === "page", `kind=${view.kind}`);
    assert(isValidPublishedAgb(view), "published is valid");
    if (view.kind === "page") {
      assert(view.page.slug === "agb", "slug");
      assert(view.page.title === "AGB", "title");
      assert(view.page.body === publishedAgb.body, "body");
      assert(view.page.version === "v1", "version");
      assert(!("publishNote" in view.page), "publishNote dropped");
      assert(!("id" in view.page), "id dropped");
    }
  });

  await run("AG2", () => {
    const missing = agbViewFromLegalResponse({
      legalStatus: 404,
      legalBody: { code: "NOT_FOUND", message: "Legal page not found" },
    });
    assert(missing.kind === "not_found", "API 404 → not_found");
    assert(!isValidPublishedAgb(missing), "missing is not valid AGB");
    assert(pageSrc.includes('view.kind === "not_found"'), "page branches on not_found");
    assert(pageSrc.includes("notFound()"), "page returns Next 404");
    const empty = agbViewFromLegalResponse({
      legalStatus: 200,
      legalBody: { ...publishedAgb, body: "   " },
    });
    assert(empty.kind === "not_found", "empty body is not AGB");
    const wrongSlug = agbViewFromLegalResponse({
      legalStatus: 200,
      legalBody: { ...publishedAgb, slug: "impressum" },
    });
    assert(wrongSlug.kind === "not_found", "non-agb slug is not /agb");
  });

  await run("AG3", () => {
    const parsed = parsePublicLegalPage({
      ...publishedAgb,
      publishNote: "OWNER-ONLY",
      consentMigrationPolicy: { kind: "NO_ACTION", determinedByActorId: "admin" },
      supersededAt: "2026-01-01T00:00:00.000Z",
      body: "DRAFT-SECRET should not appear if unpublished — this is published body",
    });
    assert(parsed !== null, "published parses");
    if (parsed) {
      for (const key of Object.keys(parsed)) {
        assert(
          (PUBLIC_LEGAL_PAGE_FIELDS as readonly string[]).includes(key),
          `unexpected consumed field ${key}`,
        );
      }
      assert(!("publishNote" in parsed), "publishNote not consumed");
      assert(!("consentMigrationPolicy" in parsed), "policy not consumed");
      assert(!("supersededAt" in parsed), "supersededAt not consumed");
      assert(!("id" in parsed), "id not consumed");
      assert(!("determinedByActorId" in parsed), "actor not consumed");
    }
    const draftOnly = agbViewFromLegalResponse({
      legalStatus: 404,
      legalBody: {
        slug: "agb",
        title: "AGB",
        body: "DRAFT-SECRET-AGB",
        publishNote: "draft-note",
      },
    });
    assert(draftOnly.kind === "not_found", "draft 404 is not rendered");
    assert(!isValidPublishedAgb(draftOnly), "draft is not valid");
  });

  await run("AG4", () => {
    const identityOnly = agbViewFromLegalResponse({
      legalStatus: 404,
      legalBody: identityBody,
    });
    assert(identityOnly.kind === "not_found", "identity body is not AGB");
    assert(!isValidPublishedAgb(identityOnly), "identity-only is never valid AGB");
    const identityAsLegal = agbViewFromLegalResponse({
      legalStatus: 200,
      legalBody: identityBody,
    });
    assert(identityAsLegal.kind === "not_found", "identity JSON is not a LegalPage");
    assert(!libSrc.includes("store-identity"), "AGB lib does not import identity");
    assert(!pageSrc.includes("store-identity"), "AGB page does not import identity");
    assert(!pageSrc.includes("legalName"), "no identity fields on page");
    assert(!libSrc.includes("legalAgbVersionId"), "no Order snapshot");
    assert(!libSrc.includes("acceptedAgbAt"), "no C2");
    assert(!footerSrc.includes("agb"), "Footer inventory unchanged");
    assert(!headerSrc.includes("agb"), "Header unchanged");
    assert(!layoutSrc.includes("agb"), "layout unchanged");
    assert(!titleSrc.includes("agb"), "document-title unchanged");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(`\nStorefront /agb: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`);
    process.exit(1);
  }
  console.log(`\nStorefront /agb: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
