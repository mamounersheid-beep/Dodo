/**
 * Storefront /help — static Help Hub composition only.
 * Run: pnpm --filter @dodo/web test:store-help
 *
 *   HH1 — route exists at /help
 *   HH2 — FAQ link is exactly /help/faq
 *   HH3 — Contact link is exactly /help/contact
 *   HH4 — legal links are exactly /impressum /agb /datenschutz /widerruf
 *   HH5 — no /kontakt link
 *   HH6 — no /versand link
 *   HH7 — no FAQ API/content fetch from the Hub
 *   HH8 — no notFound() on downstream availability
 *   HH9 — no Help detail route
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HELP_HUB_CONTACT_HREF,
  HELP_HUB_FAQ_HREF,
  HELP_HUB_LEGAL_HREFS,
  HELP_HUB_LINKS,
  HELP_HUB_PATH,
} from "./store-help";

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

function hrefsIn(src: string, href: string): boolean {
  return src.includes(`href="${href}"`) || src.includes(`href={'${href}'}`) || src.includes(`href={"${href}"}`);
}

async function main(): Promise<void> {
  const results: Result[] = [];
  const ids = ["HH1", "HH2", "HH3", "HH4", "HH5", "HH6", "HH7", "HH8", "HH9"] as const;

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

  const libSrc = readFileSync(join(process.cwd(), "src/lib/store-help.ts"), "utf8");
  const pageSrc = readFileSync(join(process.cwd(), "src/app/help/page.tsx"), "utf8");
  const faqPageSrc = readFileSync(join(process.cwd(), "src/app/help/faq/page.tsx"), "utf8");
  const footerSrc = readFileSync(join(process.cwd(), "src/components/store-footer.tsx"), "utf8");
  const headerSrc = readFileSync(join(process.cwd(), "src/components/store-header.tsx"), "utf8");
  const layoutSrc = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
  const titleSrc = readFileSync(join(process.cwd(), "src/lib/store-document-title.ts"), "utf8");
  const helpDir = join(process.cwd(), "src/app/help");

  await run("HH1", () => {
    assert(HELP_HUB_PATH === "/help", "path constant");
    assert(existsSync(join(helpDir, "page.tsx")), "/help page exists");
    assert(pageSrc.includes("HELP_HUB_LINKS"), "page uses hub link inventory");
    assert(!pageSrc.includes("generateMetadata"), "no page seoTitle");
    assert(!pageSrc.includes("export const dynamic"), "no extra dynamic on static hub");
    assert(!footerSrc.includes("/help\""), "Footer inventory unchanged");
    assert(!headerSrc.includes("/help"), "Header unchanged");
    assert(!layoutSrc.includes("help/page"), "layout unchanged");
    assert(!titleSrc.includes("help"), "document-title unchanged");
  });

  await run("HH2", () => {
    assert(HELP_HUB_FAQ_HREF === "/help/faq", "faq href constant");
    assert(HELP_HUB_LINKS.faq.href === "/help/faq", "faq link href");
    assert(pageSrc.includes("HELP_HUB_LINKS.faq"), "page renders FAQ link");
    assert(libSrc.includes('"/help/faq"'), "inventory names /help/faq");
  });

  await run("HH3", () => {
    assert(HELP_HUB_CONTACT_HREF === "/help/contact", "contact href constant");
    assert(HELP_HUB_LINKS.contact.href === "/help/contact", "contact link href");
    assert(pageSrc.includes("HELP_HUB_LINKS.contact"), "page renders Contact link");
    assert(HELP_HUB_CONTACT_HREF === "/help/contact", "hub still links to /help/contact");
  });

  await run("HH4", () => {
    assert(HELP_HUB_LEGAL_HREFS.length === 4, "four legal hrefs");
    assert(HELP_HUB_LEGAL_HREFS[0] === "/impressum", "impressum");
    assert(HELP_HUB_LEGAL_HREFS[1] === "/agb", "agb");
    assert(HELP_HUB_LEGAL_HREFS[2] === "/datenschutz", "datenschutz");
    assert(HELP_HUB_LEGAL_HREFS[3] === "/widerruf", "widerruf");
    const legalHrefs = HELP_HUB_LINKS.legal.map((l) => l.href);
    assert(legalHrefs.join(",") === "/impressum,/agb,/datenschutz,/widerruf", "legal href set");
    assert(pageSrc.includes("HELP_HUB_LINKS.legal"), "page renders legal links");
  });

  await run("HH5", () => {
    assert(!libSrc.includes("/kontakt"), "lib has no /kontakt");
    assert(!pageSrc.includes("/kontakt"), "page has no /kontakt");
    assert(!hrefsIn(pageSrc, "/kontakt"), "no /kontakt href");
  });

  await run("HH6", () => {
    assert(!libSrc.includes("/versand"), "lib has no /versand");
    assert(!pageSrc.includes("/versand"), "page has no /versand");
    assert(!hrefsIn(pageSrc, "/versand"), "no /versand href");
  });

  await run("HH7", () => {
    assert(!pageSrc.includes("loadFaq"), "hub does not load FAQ");
    assert(!pageSrc.includes("store-faq"), "hub does not import store-faq");
    assert(!pageSrc.includes("/legal/faq"), "hub does not call FAQ API");
    assert(!pageSrc.includes("/legal/pages"), "hub does not call LegalPage GET");
    assert(!pageSrc.includes("fetchPublished"), "hub has no published fetch");
    assert(!libSrc.includes("fetch("), "hub lib has no fetch");
    assert(!libSrc.includes("/legal/faq"), "hub lib has no FAQ API");
    assert(!libSrc.includes("/legal/pages"), "hub lib has no LegalPage GET");
    assert(!libSrc.includes("store-identity"), "hub lib has no identity");
    assert(!libSrc.includes("/store/status"), "hub lib has no status");
    assert(!pageSrc.includes("store-identity"), "hub page has no identity");
    assert(!faqPageSrc.includes("store-help"), "FAQ page unchanged by hub");
  });

  await run("HH8", () => {
    assert(!pageSrc.includes("notFound"), "hub never notFound()");
    assert(!libSrc.includes("notFound"), "lib never notFound()");
    assert(!pageSrc.includes("async"), "hub page is not a data-loading async page");
  });

  await run("HH9", () => {
    const names = readdirSync(helpDir);
    assert(names.includes("page.tsx"), "/help page");
    assert(names.includes("faq"), "closed FAQ dir remains");
    assert(!names.some((n) => n.includes("[")), "no dynamic Help segment");
    assert(!existsSync(join(helpDir, "[slug]")), "no /help/:slug");
    assert(!existsSync(join(helpDir, "faq/[slug]")), "no /help/faq/:slug");
    assert(!pageSrc.includes("params.slug"), "hub is not a detail route");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(`\nStorefront /help: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`);
    process.exit(1);
  }
  console.log(`\nStorefront /help: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
