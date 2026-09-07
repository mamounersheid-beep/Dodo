/**
 * Storefront /help/contact — POST /v1/contact form only.
 * Run: pnpm --filter @dodo/web test:store-contact
 *
 *   CF1 — route is /help/contact and posts only to /v1/contact
 *   CF2 — no /kontakt, /contact alias, FAQ/legal fetch, identity, seoTitle
 *   CF3 — no Help/FAQ detail routes introduced by this slice
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTACT_PATH, CONTACT_SUBJECTS, HELP_CONTACT_HREF, publicContactUrl } from "./store-contact";

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
  const ids = ["CF1", "CF2", "CF3"] as const;

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

  const libSrc = readFileSync(join(process.cwd(), "src/lib/store-contact.ts"), "utf8");
  const formSrc = readFileSync(join(process.cwd(), "src/components/contact-form.tsx"), "utf8");
  const pageSrc = readFileSync(join(process.cwd(), "src/app/help/contact/page.tsx"), "utf8");
  const hubSrc = readFileSync(join(process.cwd(), "src/app/help/page.tsx"), "utf8");
  const faqSrc = readFileSync(join(process.cwd(), "src/app/help/faq/page.tsx"), "utf8");
  const footerSrc = readFileSync(join(process.cwd(), "src/components/store-footer.tsx"), "utf8");
  const headerSrc = readFileSync(join(process.cwd(), "src/components/store-header.tsx"), "utf8");
  const layoutSrc = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
  const titleSrc = readFileSync(join(process.cwd(), "src/lib/store-document-title.ts"), "utf8");
  const helpDir = join(process.cwd(), "src/app/help");

  await run("CF1", () => {
    assert(HELP_CONTACT_HREF === "/help/contact", "canonical route");
    assert(CONTACT_PATH === "/contact", "API path");
    assert(
      publicContactUrl("http://localhost:3001/v1") === "http://localhost:3001/v1/contact",
      "url",
    );
    assert(CONTACT_SUBJECTS.join(",") === "order,payment,shipping,return,account,general", "subjects");
    assert(pageSrc.includes("ContactForm"), "page renders form");
    assert(formSrc.includes("submitContact"), "form posts via lib");
    assert(libSrc.includes("method: \"POST\""), "POST");
    assert(!libSrc.includes("/legal/"), "no legal API");
    assert(!formSrc.includes("/legal/"), "form no legal API");
    assert(!pageSrc.includes("notFound"), "no notFound");
    assert(!pageSrc.includes("generateMetadata"), "no seoTitle");
  });

  await run("CF2", () => {
    assert(!existsSync(join(process.cwd(), "src/app/kontakt/page.tsx")), "no /kontakt page from this slice");
    assert(!existsSync(join(process.cwd(), "src/app/contact/page.tsx")), "no /contact alias");
    assert(!pageSrc.includes("/kontakt"), "page no /kontakt");
    assert(!pageSrc.includes("store-faq"), "no FAQ fetch");
    assert(!pageSrc.includes("store-legal-page"), "no LegalPage GET");
    assert(!pageSrc.includes("store-identity"), "no identity");
    assert(!libSrc.includes("store-identity"), "lib no identity");
    assert(!libSrc.includes("/store/status"), "no status");
    assert(!formSrc.includes("captcha"), "no captcha");
    assert(!hubSrc.includes("ContactForm"), "Help Hub unchanged");
    assert(!faqSrc.includes("ContactForm"), "FAQ unchanged");
    assert(!footerSrc.includes("ContactForm"), "Footer unchanged");
    assert(!headerSrc.includes("/help/contact"), "Header unchanged");
    assert(!layoutSrc.includes("help/contact"), "layout unchanged");
    assert(!titleSrc.includes("contact"), "document-title unchanged");
  });

  await run("CF3", () => {
    assert(existsSync(join(helpDir, "contact/page.tsx")), "/help/contact exists");
    const contactNames = readdirSync(join(helpDir, "contact"));
    assert(!contactNames.some((n) => n.includes("[")), "no contact detail segment");
    assert(!existsSync(join(helpDir, "faq/[slug]")), "no FAQ slug route");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(`\nStorefront /help/contact: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`);
    process.exit(1);
  }
  console.log(`\nStorefront /help/contact: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
