/**
 * Footer identity slice — GET /v1/store/identity (CI-6).
 * Run: pnpm --filter @dodo/web test:store-footer-identity
 *
 *   FT1 — Footer consumes existing /store/identity contract
 *   FT2 — logoUrl present → logo view
 *   FT3 — logoUrl absent → text legalName
 *   FT4 — logoObjectKey is not consumed
 *   FT5 — no hardcoded Dodo / company name in Footer identity
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
  const ids = ["FT1", "FT2", "FT3", "FT4", "FT5"] as const;

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

  const footerSrc = readFileSync(join(process.cwd(), "src/components/store-footer.tsx"), "utf8");
  const layoutSrc = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
  const identitySrc = readFileSync(join(process.cwd(), "src/lib/store-identity.ts"), "utf8");

  await run("FT1", () => {
    assert(STORE_IDENTITY_PATH === "/store/identity", "path");
    assert(storeIdentityUrl("http://localhost:3001/v1") === "http://localhost:3001/v1/store/identity", "url");
    assert(footerSrc.includes("fetchStoreIdentity"), "footer uses shared fetch");
    assert(footerSrc.includes("@/lib/store-identity"), "footer uses existing identity module");
    assert(layoutSrc.includes("StoreFooter"), "layout mounts Footer");
    assert(!footerSrc.includes("/store/status"), "footer must not call /store/status");
    assert(identitySrc.includes("/store/identity"), "shared module uses identity path");
  });

  await run("FT2", () => {
    const view = headerIdentityFromResponse({
      legalName: "Live Firma",
      logoUrl: "https://cdn.example/mark.svg",
    });
    assert(view.kind === "logo", `kind=${view.kind}`);
    if (view.kind === "logo") {
      assert(view.logoUrl === "https://cdn.example/mark.svg", "logo src");
    }
    assert(footerSrc.includes("view.logoUrl"), "footer renders logoUrl");
    assert(footerSrc.includes("<img"), "footer uses img when logo");
  });

  await run("FT3", () => {
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
    assert(footerSrc.includes("view.legalName"), "footer renders legalName");
    const emptyLogo = headerIdentityFromResponse({ legalName: "Nur Text Firma", logoUrl: "" });
    assert(emptyLogo.kind === "text", "empty logoUrl → text");
  });

  await run("FT4", () => {
    const view = headerIdentityFromResponse({
      legalName: "Firma",
      logoObjectKey: "secret/key.png",
    });
    assert(view.kind === "text", "must not treat storage key as logo");
    assert(!/\blogoObjectKey\b/.test(footerSrc), "footer must not mention storage key");
  });

  await run("FT5", () => {
    assert(!footerSrc.includes("Dodo"), "Footer identity has no hardcoded Dodo");
    const empty = headerIdentityFromResponse({});
    assert(empty.kind === "empty", "empty body is not a default name");
    const live = headerIdentityFromResponse({ legalName: "Andere Firma GmbH" });
    assert(live.kind === "text" && live.legalName === "Andere Firma GmbH", "uses API name");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nFooter identity: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nFooter identity: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
