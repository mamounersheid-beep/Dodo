/**
 * Footer reachability — frozen inventory links only.
 * Run: pnpm --filter @dodo/web test:store-footer-nav
 *
 *   FN1 — Help → /help
 *   FN2 — FAQ → /help/faq
 *   FN3 — Contact → /help/contact
 *   FN4 — Legal is one label with exactly four closed hrefs
 *   FN5 — /kontakt and /versand absent
 *   FN6 — Footer identity fetch/chrome unchanged
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FOOTER_CONTACT_HREF,
  FOOTER_FAQ_HREF,
  FOOTER_HELP_HREF,
  FOOTER_LEGAL_HREFS,
  FOOTER_NAV,
} from "./store-footer-nav";

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
  const ids = ["FN1", "FN2", "FN3", "FN4", "FN5", "FN6"] as const;

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

  const navSrc = readFileSync(join(process.cwd(), "src/lib/store-footer-nav.ts"), "utf8");
  const footerSrc = readFileSync(join(process.cwd(), "src/components/store-footer.tsx"), "utf8");
  const headerSrc = readFileSync(join(process.cwd(), "src/components/store-header.tsx"), "utf8");

  await run("FN1", () => {
    assert(FOOTER_HELP_HREF === "/help", "help href");
    assert(FOOTER_NAV.help.href === "/help", "nav help");
    assert(FOOTER_NAV.help.label === "Help", "help label");
    assert(footerSrc.includes("FOOTER_NAV.help"), "footer renders Help");
  });

  await run("FN2", () => {
    assert(FOOTER_FAQ_HREF === "/help/faq", "faq href");
    assert(FOOTER_NAV.faq.href === "/help/faq", "nav faq");
    assert(footerSrc.includes("FOOTER_NAV.faq"), "footer renders FAQ");
  });

  await run("FN3", () => {
    assert(FOOTER_CONTACT_HREF === "/help/contact", "contact href");
    assert(FOOTER_NAV.contact.href === "/help/contact", "nav contact");
    assert(footerSrc.includes("FOOTER_NAV.contact"), "footer renders Contact");
  });

  await run("FN4", () => {
    assert(FOOTER_LEGAL_HREFS.length === 4, "four legal hrefs");
    assert(FOOTER_LEGAL_HREFS.join(",") === "/impressum,/agb,/datenschutz,/widerruf", "legal set");
    assert(FOOTER_NAV.legal.map((l) => l.href).join(",") === "/impressum,/agb,/datenschutz,/widerruf", "nav legal");
    assert(footerSrc.includes("FOOTER_NAV.legal"), "footer renders Legal group");
    assert(footerSrc.includes('aria-label="Legal"'), "Legal is one label/group");
  });

  await run("FN5", () => {
    assert(!navSrc.includes("/kontakt"), "nav lib no /kontakt");
    assert(!navSrc.includes("/versand"), "nav lib no /versand");
    assert(!footerSrc.includes("/kontakt"), "footer no /kontakt");
    assert(!footerSrc.includes("/versand"), "footer no /versand");
  });

  await run("FN6", () => {
    assert(footerSrc.includes("fetchStoreIdentity"), "identity fetch kept");
    assert(footerSrc.includes("@/lib/store-identity"), "identity module kept");
    assert(footerSrc.includes("view.logoUrl"), "logo chrome kept");
    assert(footerSrc.includes("view.legalName"), "legalName chrome kept");
    assert(!footerSrc.includes("/store/status"), "no status API");
    assert(!footerSrc.includes("/legal/faq"), "no FAQ API");
    assert(!footerSrc.includes("/legal/pages"), "no LegalPage GET");
    assert(!footerSrc.includes("submitContact"), "no Contact POST");
    assert(!footerSrc.includes("fetch("), "footer has no extra fetch");
    assert(!headerSrc.includes("FOOTER_NAV"), "Header unchanged");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(`\nFooter reachability: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`);
    process.exit(1);
  }
  console.log(`\nFooter reachability: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
