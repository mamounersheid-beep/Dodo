/**
 * Header identity slice — GET /v1/store/identity (CI-6).
 * Run: pnpm --filter @dodo/web test:store-header-identity
 *
 *   SH1 — consumes legalName + logoUrl from identity body / path
 *   SH2 — logoUrl present → logo view
 *   SH3 — logoUrl absent → text legalName
 *   SH4 — logoObjectKey is not consumed
 *   SH5 — no hardcoded company/store name
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
  const ids = ["SH1", "SH2", "SH3", "SH4", "SH5"] as const;

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

  const identitySrc = readFileSync(join(process.cwd(), "src/lib/store-identity.ts"), "utf8");
  const headerSrc = readFileSync(join(process.cwd(), "src/components/store-header.tsx"), "utf8");

  await run("SH1", () => {
    assert(STORE_IDENTITY_PATH === "/store/identity", "path");
    assert(!STORE_IDENTITY_PATH.includes("status"), "must not be store/status");
    assert(storeIdentityUrl("http://localhost:3001/v1") === "http://localhost:3001/v1/store/identity", "url");
    assert(identitySrc.includes("/store/identity"), "fetch path in source");
    assert(!identitySrc.includes("/store/status"), "source must not call /store/status");
    assert(!headerSrc.includes("/store/status"), "header must not call /store/status");
    const view = headerIdentityFromResponse({
      legalName: "Beispiel Firma UG",
      line1: "Musterstraße 1",
      postalCode: "10115",
      city: "Berlin",
      countryCode: "DE",
      logoUrl: "http://localhost:9000/dodo/logo.png",
      supportEmail: "a@b.c",
    });
    assert(view.kind === "logo", "kind");
    assert(view.kind === "logo" && view.legalName === "Beispiel Firma UG", "legalName");
    assert(view.kind === "logo" && view.logoUrl === "http://localhost:9000/dodo/logo.png", "logoUrl");
  });

  await run("SH2", () => {
    const view = headerIdentityFromResponse({
      legalName: "Live Firma",
      logoUrl: "https://cdn.example/mark.svg",
    });
    assert(view.kind === "logo", `kind=${view.kind}`);
    if (view.kind === "logo") {
      assert(view.logoUrl === "https://cdn.example/mark.svg", "logo src");
      assert(view.legalName === "Live Firma", "alt/legalName");
    }
    assert(headerSrc.includes("view.logoUrl"), "header renders logoUrl");
    assert(headerSrc.includes("<img"), "header uses img for logo");
  });

  await run("SH3", () => {
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
    const emptyLogo = headerIdentityFromResponse({ legalName: "Nur Text Firma", logoUrl: "" });
    assert(emptyLogo.kind === "text", "empty logoUrl → text");
  });

  await run("SH4", () => {
    const view = headerIdentityFromResponse({
      legalName: "Firma",
      logoObjectKey: "secret/key.png",
    });
    assert(view.kind === "text", "must not treat logoObjectKey as logo");
    assert(!("logoUrl" in view), "no logoUrl from key");
    const leaked = headerIdentityFromResponse({
      legalName: "Firma",
      logoObjectKey: "http://evil/key.png",
    });
    assert(leaked.kind === "text", "object key string is not a logo");
    assert(!/\blogoObjectKey\b/.test(identitySrc), "lib must not mention storage key");
    assert(!/\blogoObjectKey\b/.test(headerSrc), "header must not mention storage key");
  });

  await run("SH5", () => {
    const empty = headerIdentityFromResponse({});
    assert(empty.kind === "empty", "empty body is not a default name");
    const live = headerIdentityFromResponse({ legalName: "Andere Firma GmbH" });
    assert(live.kind === "text" && live.legalName === "Andere Firma GmbH", "uses API name");
    assert(!identitySrc.includes("Dodo"), "lib has no hardcoded Dodo");
    assert(!headerSrc.includes("Dodo"), "header has no hardcoded Dodo");
    assert(!headerSrc.includes("store-default"), "no store-default name");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nHeader identity: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nHeader identity: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
