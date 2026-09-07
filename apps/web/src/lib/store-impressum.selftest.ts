/**
 * Storefront /impressum — composite identity + PUBLISHED LegalPage.
 * Run: pnpm --filter @dodo/web test:store-impressum
 *
 *   IM1 — identity + published prose → composite
 *   IM2 — missing published prose → not_found (/impressum 404)
 *   IM3 — identity-only is never a valid complete Impressum
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STORE_IDENTITY_PATH } from "./store-identity";
import {
  IMPRESSUM_SLUG,
  LEGAL_PAGES_PATH,
  impressumViewFromSources,
  isValidCompleteImpressum,
  publicLegalPageUrl,
} from "./store-impressum";

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

const identityBody = {
  legalName: "Beispiel Firma UG",
  line1: "Musterstraße 1",
  postalCode: "10115",
  city: "Berlin",
  countryCode: "DE",
  supportEmail: "info@example.de",
};

const publishedPage = {
  slug: "impressum",
  title: "Impressum",
  body: "Angaben gemäß § 5 TMG — veröffentlichter Text.",
  version: "v1",
  publishedAt: "2026-09-05T00:00:00.000Z",
};

async function main(): Promise<void> {
  const results: Result[] = [];
  const ids = ["IM1", "IM2", "IM3"] as const;

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

  const libSrc = readFileSync(join(process.cwd(), "src/lib/store-impressum.ts"), "utf8");
  const pageSrc = readFileSync(join(process.cwd(), "src/app/impressum/page.tsx"), "utf8");
  const footerSrc = readFileSync(join(process.cwd(), "src/components/store-footer.tsx"), "utf8");
  const headerSrc = readFileSync(join(process.cwd(), "src/components/store-header.tsx"), "utf8");
  const layoutSrc = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");

  await run("IM1", () => {
    assert(STORE_IDENTITY_PATH === "/store/identity", "identity path");
    assert(LEGAL_PAGES_PATH === "/legal/pages", "legal path");
    assert(IMPRESSUM_SLUG === "impressum", "slug");
    assert(
      publicLegalPageUrl("http://localhost:3001/v1", "impressum") ===
        "http://localhost:3001/v1/legal/pages/impressum",
      "legal url",
    );
    assert(libSrc.includes("/legal/pages"), "lib fetches legal pages");
    assert(libSrc.includes("/store/identity") || libSrc.includes("storeIdentityUrl"), "lib uses identity");
    assert(pageSrc.includes("loadImpressum"), "page loads via lib");
    assert(pageSrc.includes("notFound"), "page uses notFound");
    assert(!pageSrc.includes("prisma"), "page must not use Prisma");
    assert(!libSrc.includes("prisma"), "lib must not use Prisma");
    assert(!pageSrc.includes("/v1/admin"), "page must not call Admin");
    assert(!libSrc.includes("/store/status"), "lib must not call store/status");
    assert(!pageSrc.includes("/agb"), "slice is not AGB");
    assert(!pageSrc.includes("datenschutz"), "slice is not Datenschutz");
    assert(!pageSrc.includes("widerruf"), "slice is not Widerruf");

    const view = impressumViewFromSources({
      legalStatus: 200,
      legalBody: publishedPage,
      identityBody,
    });
    assert(view.kind === "composite", `kind=${view.kind}`);
    assert(isValidCompleteImpressum(view), "composite is valid complete");
    if (view.kind === "composite") {
      assert(view.page.body === publishedPage.body, "published prose");
      assert(view.page.title === "Impressum", "title");
      assert(view.identity.legalName === "Beispiel Firma UG", "live identity name");
      assert(view.identity.line1 === "Musterstraße 1", "live identity address");
      assert(view.identity.supportEmail === "info@example.de", "contact");
    }
    assert(pageSrc.includes("view.page.body"), "page renders published body");
    assert(pageSrc.includes("view.identity") || pageSrc.includes("TmgBlock"), "page renders TMG");
  });

  await run("IM2", () => {
    const missing = impressumViewFromSources({
      legalStatus: 404,
      legalBody: { code: "NOT_FOUND", message: "Legal page not found" },
      identityBody,
    });
    assert(missing.kind === "not_found", "legal 404 → not_found");
    assert(!isValidCompleteImpressum(missing), "missing prose is not complete");
    assert(pageSrc.includes('view.kind === "not_found"'), "page branches on not_found");
    assert(pageSrc.includes("notFound()"), "page returns Next 404");
    const emptyBody = impressumViewFromSources({
      legalStatus: 200,
      legalBody: { ...publishedPage, body: "   " },
      identityBody,
    });
    assert(emptyBody.kind === "not_found", "empty prose is not a page");
  });

  await run("IM3", () => {
    const identityOnly = impressumViewFromSources({
      legalStatus: 404,
      legalBody: { code: "NOT_FOUND" },
      identityBody,
    });
    assert(identityOnly.kind === "not_found", "identity-only is not found");
    assert(!isValidCompleteImpressum(identityOnly), "identity-only is never complete Impressum");
    const noLegal = impressumViewFromSources({
      legalStatus: 200,
      legalBody: { slug: "impressum", title: "Impressum" },
      identityBody,
    });
    assert(noLegal.kind === "not_found", "incomplete legal body is not complete");
    assert(!footerSrc.includes("impressum"), "Footer link inventory unchanged");
    assert(!headerSrc.includes("impressum"), "Header unchanged");
    assert(!layoutSrc.includes("impressum"), "layout title/surface unchanged");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nStorefront /impressum: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nStorefront /impressum: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
