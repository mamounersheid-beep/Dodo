/**
 * Default document <title> — legalName / seoTitle precedence (§12.18b · 11 §10).
 * Run: pnpm --filter @dodo/web test:store-document-title
 *
 *   DT1 — default title = legalName
 *   DT2 — page-specific seoTitle wins
 *   DT3 — no hardcoded Dodo as production default title
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { headerIdentityFromResponse } from "./store-identity";
import { legalNameFromIdentityView, resolveDocumentTitle } from "./store-document-title";

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

async function main(): Promise<void> {
  const results: Result[] = [];
  const ids = ["DT1", "DT2", "DT3"] as const;

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

  const layoutSrc = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
  const titleSrc = readFileSync(join(process.cwd(), "src/lib/store-document-title.ts"), "utf8");

  await run("DT1", () => {
    const view = headerIdentityFromResponse({
      legalName: "Beispiel Firma UG",
      line1: "x",
      postalCode: "1",
      city: "y",
      countryCode: "DE",
    });
    const legalName = legalNameFromIdentityView(view);
    assert(legalName === "Beispiel Firma UG", "legalName from identity");
    assert(resolveDocumentTitle({ legalName }) === "Beispiel Firma UG", "default = legalName");
    assert(layoutSrc.includes("resolveDocumentTitle"), "layout uses resolver");
    assert(layoutSrc.includes("fetchStoreIdentity"), "layout uses existing identity fetch");
    assert(!layoutSrc.includes("/store/status"), "layout title must not use /store/status");
  });

  await run("DT2", () => {
    assert(
      resolveDocumentTitle({
        seoTitle: "Produkt SEO Titel",
        legalName: "Beispiel Firma UG",
      }) === "Produkt SEO Titel",
      "seoTitle wins",
    );
    assert(
      resolveDocumentTitle({
        seoTitle: "   ",
        legalName: "Beispiel Firma UG",
      }) === "Beispiel Firma UG",
      "blank seoTitle falls through",
    );
    assert(
      resolveDocumentTitle({
        seoTitle: null,
        legalName: "Beispiel Firma UG",
      }) === "Beispiel Firma UG",
      "null seoTitle falls through",
    );
  });

  await run("DT3", () => {
    assert(!layoutSrc.includes("Dodo"), "layout has no hardcoded Dodo");
    assert(!titleSrc.includes("Dodo"), "resolver has no hardcoded Dodo");
    assert(resolveDocumentTitle({}) === undefined, "empty is not a default name");
    assert(layoutSrc.includes("generateMetadata"), "dynamic title, not static metadata.title");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nDocument title: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nDocument title: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
