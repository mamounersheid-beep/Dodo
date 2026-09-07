/**
 * Homepage identity slice — GET /v1/store/identity (CI-6).
 * Run: pnpm --filter @dodo/web test:store-homepage-identity
 *
 *   HP1 — Homepage consumes existing /store/identity contract
 *   HP2 — logoUrl present → logo view
 *   HP3 — logoUrl absent → text legalName
 *   HP4 — logoObjectKey is not consumed
 *   HP5 — no hardcoded Dodo / company name in Homepage identity
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STORE_IDENTITY_PATH,
  headerIdentityFromResponse,
  storeIdentityUrl,
} from "./store-identity";

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
  const ids = ["HP1", "HP2", "HP3", "HP4", "HP5"] as const;

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

  const pageSrc = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");
  const identitySrc = readFileSync(join(process.cwd(), "src/lib/store-identity.ts"), "utf8");

  await run("HP1", () => {
    assert(STORE_IDENTITY_PATH === "/store/identity", "path");
    assert(storeIdentityUrl("http://localhost:3001/v1") === "http://localhost:3001/v1/store/identity", "url");
    assert(pageSrc.includes("fetchStoreIdentity"), "page uses shared fetch");
    assert(pageSrc.includes("@/lib/store-identity"), "page uses existing identity module");
    assert(!pageSrc.includes("/store/status"), "page must not call /store/status");
    assert(identitySrc.includes("/store/identity"), "shared module uses identity path");
  });

  await run("HP2", () => {
    const view = headerIdentityFromResponse({
      legalName: "Live Firma",
      logoUrl: "https://cdn.example/mark.svg",
    });
    assert(view.kind === "logo", `kind=${view.kind}`);
    if (view.kind === "logo") {
      assert(view.logoUrl === "https://cdn.example/mark.svg", "logo src");
    }
    assert(pageSrc.includes("view.logoUrl"), "page renders logoUrl");
    assert(pageSrc.includes("<img"), "page uses img when logo");
  });

  await run("HP3", () => {
    const view = headerIdentityFromResponse({
      legalName: "Nur Text Firma",
      line1: "x",
      postalCode: "1",
      city: "y",
      countryCode: "DE",
    });
    assert(view.kind === "text", `kind=${view.kind}`);
    if (view.kind === "text") {
      assert(view.legalName === "Nur Text Firma", "text legalName");
    }
    assert(pageSrc.includes("view.legalName"), "page renders legalName");
    const emptyLogo = headerIdentityFromResponse({ legalName: "Nur Text Firma", logoUrl: "" });
    assert(emptyLogo.kind === "text", "empty logoUrl → text");
  });

  await run("HP4", () => {
    const view = headerIdentityFromResponse({
      legalName: "Firma",
      logoObjectKey: "secret/key.png",
    });
    assert(view.kind === "text", "must not treat storage key as logo");
    assert(!/\blogoObjectKey\b/.test(pageSrc), "page must not mention storage key");
  });

  await run("HP5", () => {
    assert(!pageSrc.includes("Dodo"), "Homepage identity has no hardcoded Dodo");
    const empty = headerIdentityFromResponse({});
    assert(empty.kind === "empty", "empty body is not a default name");
    const live = headerIdentityFromResponse({ legalName: "Andere Firma GmbH" });
    assert(live.kind === "text" && live.legalName === "Andere Firma GmbH", "uses API name");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nHomepage identity: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nHomepage identity: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
