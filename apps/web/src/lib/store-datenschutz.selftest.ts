/**
 * Storefront /datenschutz — current PUBLISHED LegalPage only.
 * Run: pnpm --filter @dodo/web test:store-datenschutz
 *
 *   DS1 — published Datenschutz → page (title + body)
 *   DS2 — no current PUBLISHED → not_found (/datenschutz 404)
 *   DS3 — draft / admin / consentMigrationPolicy are not consumed
 *   DS4 — identity / order / cookie APIs are never a valid Datenschutz page
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATENSCHUTZ_SLUG,
  datenschutzViewFromLegalResponse,
  isValidPublishedDatenschutz,
} from "./store-datenschutz";
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

const publishedDatenschutz = {
  slug: "datenschutz",
  title: "Datenschutz",
  body: "Datenschutzerklärung — veröffentlichter Text.",
  version: "v1",
  publishedAt: "2026-09-05T00:00:00.000Z",
  publishNote: "MUST-NOT-CONSUME",
  id: "secret-id",
  consentMigrationPolicy: { kind: "NO_ACTION", determinedByActorId: "admin" },
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
  const ids = ["DS1", "DS2", "DS3", "DS4"] as const;

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

  const libSrc = readFileSync(join(process.cwd(), "src/lib/store-datenschutz.ts"), "utf8");
  const clientSrc = readFileSync(join(process.cwd(), "src/lib/store-legal-page.ts"), "utf8");
  const pageSrc = readFileSync(join(process.cwd(), "src/app/datenschutz/page.tsx"), "utf8");
  const impressumPage = readFileSync(join(process.cwd(), "src/app/impressum/page.tsx"), "utf8");
  const agbPage = readFileSync(join(process.cwd(), "src/app/agb/page.tsx"), "utf8");
  const footerSrc = readFileSync(join(process.cwd(), "src/components/store-footer.tsx"), "utf8");
  const headerSrc = readFileSync(join(process.cwd(), "src/components/store-header.tsx"), "utf8");
  const layoutSrc = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
  const titleSrc = readFileSync(join(process.cwd(), "src/lib/store-document-title.ts"), "utf8");

  await run("DS1", () => {
    assert(DATENSCHUTZ_SLUG === "datenschutz", "slug");
    assert(LEGAL_PAGES_PATH === "/legal/pages", "path");
    assert(
      publicLegalPageUrl("http://localhost:3001/v1", "datenschutz") ===
        "http://localhost:3001/v1/legal/pages/datenschutz",
      "url",
    );
    assert(libSrc.includes("fetchPublishedLegalPage"), "uses shared public GET");
    assert(pageSrc.includes("loadDatenschutz"), "page loads Datenschutz lib");
    assert(pageSrc.includes("notFound"), "page uses notFound");
    assert(pageSrc.includes("view.page.title"), "renders title");
    assert(pageSrc.includes("view.page.body"), "renders body");
    assert(!pageSrc.includes("prisma"), "no Prisma");
    assert(!libSrc.includes("prisma"), "lib no Prisma");
    assert(!clientSrc.includes("prisma"), "client no Prisma");
    assert(!pageSrc.includes("/v1/admin"), "no Admin");
    assert(!pageSrc.includes("generateMetadata"), "no page seoTitle");
    assert(!impressumPage.includes("datenschutz"), "impressum unchanged");
    assert(!agbPage.includes("datenschutz"), "agb unchanged");

    const view = datenschutzViewFromLegalResponse({
      legalStatus: 200,
      legalBody: publishedDatenschutz,
    });
    assert(view.kind === "page", `kind=${view.kind}`);
    assert(isValidPublishedDatenschutz(view), "published is valid");
    if (view.kind === "page") {
      assert(view.page.slug === "datenschutz", "slug");
      assert(view.page.title === "Datenschutz", "title");
      assert(view.page.body === publishedDatenschutz.body, "body");
      assert(view.page.version === "v1", "version");
      assert(!("publishNote" in view.page), "publishNote dropped");
      assert(!("consentMigrationPolicy" in view.page), "policy dropped");
      assert(!("id" in view.page), "id dropped");
    }
  });

  await run("DS2", () => {
    const missing = datenschutzViewFromLegalResponse({
      legalStatus: 404,
      legalBody: { code: "NOT_FOUND", message: "Legal page not found" },
    });
    assert(missing.kind === "not_found", "API 404 → not_found");
    assert(!isValidPublishedDatenschutz(missing), "missing is not valid");
    assert(pageSrc.includes('view.kind === "not_found"'), "page branches on not_found");
    assert(pageSrc.includes("notFound()"), "page returns Next 404");
    const empty = datenschutzViewFromLegalResponse({
      legalStatus: 200,
      legalBody: { ...publishedDatenschutz, body: "   " },
    });
    assert(empty.kind === "not_found", "empty body is not Datenschutz");
    const wrongSlug = datenschutzViewFromLegalResponse({
      legalStatus: 200,
      legalBody: { ...publishedDatenschutz, slug: "agb" },
    });
    assert(wrongSlug.kind === "not_found", "non-datenschutz slug is not /datenschutz");
  });

  await run("DS3", () => {
    const parsed = parsePublicLegalPage({
      ...publishedDatenschutz,
      publishNote: "OWNER-ONLY",
      consentMigrationPolicy: { kind: "INVALIDATE_ALL_NON_ESSENTIAL", determinedByActorId: "admin" },
      supersededAt: "2026-01-01T00:00:00.000Z",
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
    const draftOnly = datenschutzViewFromLegalResponse({
      legalStatus: 404,
      legalBody: {
        slug: "datenschutz",
        title: "Datenschutz",
        body: "DRAFT-SECRET-DS",
        publishNote: "draft-note",
        consentMigrationPolicy: { kind: "NO_ACTION" },
      },
    });
    assert(draftOnly.kind === "not_found", "draft 404 is not rendered");
    assert(!isValidPublishedDatenschutz(draftOnly), "draft is not valid");
  });

  await run("DS4", () => {
    const identityOnly = datenschutzViewFromLegalResponse({
      legalStatus: 404,
      legalBody: identityBody,
    });
    assert(identityOnly.kind === "not_found", "identity body is not Datenschutz");
    assert(!isValidPublishedDatenschutz(identityOnly), "identity-only is never valid");
    const identityAsLegal = datenschutzViewFromLegalResponse({
      legalStatus: 200,
      legalBody: identityBody,
    });
    assert(identityAsLegal.kind === "not_found", "identity JSON is not a LegalPage");
    assert(!libSrc.includes("store-identity"), "lib does not import identity");
    assert(!pageSrc.includes("store-identity"), "page does not import identity");
    assert(!libSrc.includes("/store/identity"), "no identity GET");
    assert(!libSrc.includes("/consent/cookies"), "no cookie consent API");
    assert(!pageSrc.includes("/consent/cookies"), "page no cookie API");
    assert(!libSrc.includes("legalPrivacy"), "no Order snapshot");
    assert(!libSrc.includes("acceptedPrivacy"), "no C2 privacy checkbox");
    assert(!pageSrc.includes("legalName"), "no identity fields on page");
    assert(!footerSrc.includes("datenschutz"), "Footer inventory unchanged");
    assert(!headerSrc.includes("datenschutz"), "Header unchanged");
    assert(!layoutSrc.includes("datenschutz"), "layout unchanged");
    assert(!titleSrc.includes("datenschutz"), "document-title unchanged");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nStorefront /datenschutz: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nStorefront /datenschutz: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
