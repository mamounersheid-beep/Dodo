/**
 * Storefront /widerruf — current PUBLISHED LegalPage only.
 * Run: pnpm --filter @dodo/web test:store-widerruf
 *
 *   WR1 — published Widerruf → page (title + body)
 *   WR2 — no current PUBLISHED → not_found (/widerruf 404)
 *   WR3 — draft / admin fields are not consumed
 *   WR4 — identity / order / returns / cookie are never a valid Widerruf page
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WIDERRUF_SLUG,
  isValidPublishedWiderruf,
  widerrufViewFromLegalResponse,
} from "./store-widerruf";
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

const publishedWiderruf = {
  slug: "widerruf",
  title: "Widerrufsbelehrung",
  body: "Widerrufsbelehrung — veröffentlichter Text.",
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
  const ids = ["WR1", "WR2", "WR3", "WR4"] as const;

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

  const libSrc = readFileSync(join(process.cwd(), "src/lib/store-widerruf.ts"), "utf8");
  const clientSrc = readFileSync(join(process.cwd(), "src/lib/store-legal-page.ts"), "utf8");
  const pageSrc = readFileSync(join(process.cwd(), "src/app/widerruf/page.tsx"), "utf8");
  const impressumPage = readFileSync(join(process.cwd(), "src/app/impressum/page.tsx"), "utf8");
  const agbPage = readFileSync(join(process.cwd(), "src/app/agb/page.tsx"), "utf8");
  const dsPage = readFileSync(join(process.cwd(), "src/app/datenschutz/page.tsx"), "utf8");
  const footerSrc = readFileSync(join(process.cwd(), "src/components/store-footer.tsx"), "utf8");
  const headerSrc = readFileSync(join(process.cwd(), "src/components/store-header.tsx"), "utf8");
  const layoutSrc = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
  const titleSrc = readFileSync(join(process.cwd(), "src/lib/store-document-title.ts"), "utf8");

  await run("WR1", () => {
    assert(WIDERRUF_SLUG === "widerruf", "slug");
    assert(LEGAL_PAGES_PATH === "/legal/pages", "path");
    assert(
      publicLegalPageUrl("http://localhost:3001/v1", "widerruf") ===
        "http://localhost:3001/v1/legal/pages/widerruf",
      "url",
    );
    assert(libSrc.includes("fetchPublishedLegalPage"), "uses shared public GET");
    assert(pageSrc.includes("loadWiderruf"), "page loads Widerruf lib");
    assert(pageSrc.includes("notFound"), "page uses notFound");
    assert(pageSrc.includes("view.page.title"), "renders title");
    assert(pageSrc.includes("view.page.body"), "renders body");
    assert(pageSrc.includes("export const dynamic = \"force-dynamic\""), "dynamic");
    assert(!pageSrc.includes("prisma"), "no Prisma");
    assert(!libSrc.includes("prisma"), "lib no Prisma");
    assert(!clientSrc.includes("prisma"), "client no Prisma");
    assert(!pageSrc.includes("/v1/admin"), "no Admin");
    assert(!pageSrc.includes("generateMetadata"), "no page seoTitle");
    assert(!impressumPage.includes("widerruf"), "impressum unchanged");
    assert(!agbPage.includes("widerruf"), "agb unchanged");
    assert(!dsPage.includes("widerruf"), "datenschutz unchanged");

    const view = widerrufViewFromLegalResponse({
      legalStatus: 200,
      legalBody: publishedWiderruf,
    });
    assert(view.kind === "page", `kind=${view.kind}`);
    assert(isValidPublishedWiderruf(view), "published is valid");
    if (view.kind === "page") {
      assert(view.page.slug === "widerruf", "slug");
      assert(view.page.title === "Widerrufsbelehrung", "title");
      assert(view.page.body === publishedWiderruf.body, "body");
      assert(view.page.version === "v1", "version");
      assert(!("publishNote" in view.page), "publishNote dropped");
      assert(!("id" in view.page), "id dropped");
    }
  });

  await run("WR2", () => {
    const missing = widerrufViewFromLegalResponse({
      legalStatus: 404,
      legalBody: { code: "NOT_FOUND", message: "Legal page not found" },
    });
    assert(missing.kind === "not_found", "API 404 → not_found");
    assert(!isValidPublishedWiderruf(missing), "missing is not valid");
    assert(pageSrc.includes('view.kind === "not_found"'), "page branches on not_found");
    assert(pageSrc.includes("notFound()"), "page returns Next 404");
    const empty = widerrufViewFromLegalResponse({
      legalStatus: 200,
      legalBody: { ...publishedWiderruf, body: "   " },
    });
    assert(empty.kind === "not_found", "empty body is not Widerruf");
    const wrongSlug = widerrufViewFromLegalResponse({
      legalStatus: 200,
      legalBody: { ...publishedWiderruf, slug: "agb" },
    });
    assert(wrongSlug.kind === "not_found", "non-widerruf slug is not /widerruf");
  });

  await run("WR3", () => {
    const parsed = parsePublicLegalPage({
      ...publishedWiderruf,
      publishNote: "OWNER-ONLY",
      consentMigrationPolicy: { kind: "NO_ACTION", determinedByActorId: "admin" },
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
    }
    const draftOnly = widerrufViewFromLegalResponse({
      legalStatus: 404,
      legalBody: {
        slug: "widerruf",
        title: "Widerruf",
        body: "DRAFT-SECRET-WR",
        publishNote: "draft-note",
      },
    });
    assert(draftOnly.kind === "not_found", "draft 404 is not rendered");
    assert(!isValidPublishedWiderruf(draftOnly), "draft is not valid");
  });

  await run("WR4", () => {
    const identityOnly = widerrufViewFromLegalResponse({
      legalStatus: 404,
      legalBody: identityBody,
    });
    assert(identityOnly.kind === "not_found", "identity body is not Widerruf");
    assert(!isValidPublishedWiderruf(identityOnly), "identity-only is never valid");
    const identityAsLegal = widerrufViewFromLegalResponse({
      legalStatus: 200,
      legalBody: identityBody,
    });
    assert(identityAsLegal.kind === "not_found", "identity JSON is not a LegalPage");
    assert(!libSrc.includes("store-identity"), "lib does not import identity");
    assert(!pageSrc.includes("store-identity"), "page does not import identity");
    assert(!libSrc.includes("/store/identity"), "no identity GET");
    assert(!libSrc.includes("/consent/cookies"), "no cookie API");
    assert(!libSrc.includes("legalWiderruf"), "no Order snapshot");
    assert(!libSrc.includes("acceptedWiderrufInfo"), "no C2");
    assert(!libSrc.includes("/account/returns"), "no returns portal");
    assert(!pageSrc.includes("/account/returns"), "page no RMA");
    assert(!pageSrc.includes("356a"), "no §356a button");
    assert(!pageSrc.includes("<form"), "no interactive form");
    assert(!pageSrc.includes("legalName"), "no identity fields on page");
    assert(!footerSrc.includes("widerruf"), "Footer inventory unchanged");
    assert(!headerSrc.includes("widerruf"), "Header unchanged");
    assert(!layoutSrc.includes("widerruf"), "layout unchanged");
    assert(!titleSrc.includes("widerruf"), "document-title unchanged");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nStorefront /widerruf: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nStorefront /widerruf: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
