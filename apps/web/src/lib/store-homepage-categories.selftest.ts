/**
 * §1c Homepage Category Showcase — focused FE rules.
 * Run: pnpm --filter @dodo/web test:store-homepage-categories
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  CATEGORY_ROUTE_PREFIX,
  CATALOG_CATEGORIES_PATH,
  HOMEPAGE_CATEGORY_CAP,
  categoryPageHref,
  homepageRootCategories,
  parseCatalogCategoryList,
  type CatalogCategory,
} from "./store-catalog";

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
  const ids = ["HC1", "HC2", "HC3", "HC4", "HC5", "HC6", "HC7"] as const;

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

  const root = process.cwd();
  const pageSrc = readFileSync(join(root, "src/app/page.tsx"), "utf8");
  const libSrc = readFileSync(join(root, "src/lib/store-catalog.ts"), "utf8");
  const showcaseSrc = readFileSync(
    join(root, "src/components/homepage-category-showcase.tsx"),
    "utf8",
  );
  const catPagePath = join(root, "src/app/category/[slug]/page.tsx");

  await run("HC1", () => {
    assert(CATALOG_CATEGORIES_PATH === "/catalog/categories", "catalog path");
    assert(pageSrc.includes("fetchHomepageCategoryShowcase"), "homepage fetches showcase");
    assert(pageSrc.includes("HomepageCategoryShowcase"), "homepage renders showcase");
    assert(libSrc.includes("/catalog/categories"), "lib calls categories API");
    assert(!libSrc.includes("/store/home"), "must not use store/home");
    assert(!pageSrc.includes("/store/home"), "page must not use store/home");
  });

  await run("HC2", () => {
    const sample: CatalogCategory[] = [
      { id: "1", slug: "a", name: "A", depth: 0, sortOrder: 2 },
      { id: "2", slug: "b", name: "B", depth: 1, sortOrder: 0 },
      { id: "3", slug: "c", name: "C", depth: 0, sortOrder: 1 },
      { id: "4", slug: "d", name: "D", depth: 0, sortOrder: 0 },
    ];
    const roots = homepageRootCategories(sample);
    assert(roots.map((r) => r.slug).join(",") === "a,c,d", `order=${roots.map((r) => r.slug)}`);
    assert(roots.every((r) => r.depth === 0), "roots only");
  });

  await run("HC3", () => {
    assert(HOMEPAGE_CATEGORY_CAP === 8, "cap 8");
    const many: CatalogCategory[] = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      slug: `r${i}`,
      name: `R${i}`,
      depth: 0,
      sortOrder: i,
    }));
    const capped = homepageRootCategories(many);
    assert(capped.length === 8, `len=${capped.length}`);
    assert(capped[0].slug === "r0" && capped[7].slug === "r7", "first eight in order");
    const few = homepageRootCategories(many.slice(0, 3));
    assert(few.length === 3, "fewer than 8 → all");
  });

  await run("HC4", () => {
    assert(CATEGORY_ROUTE_PREFIX === "/category", "route prefix");
    assert(categoryPageHref("tee") === "/category/tee", "href");
    assert(existsSync(catPagePath), "category [slug] page exists");
    assert(showcaseSrc.includes("categoryPageHref"), "showcase uses href helper");
    assert(showcaseSrc.includes("c.name"), "renders German name");
    assert(!showcaseSrc.includes("<img"), "no category images on showcase");
  });

  await run("HC5", () => {
    const fnStart = libSrc.indexOf("function homepageRootCategories");
    assert(fnStart >= 0, "homepageRootCategories present");
    const fnBody = libSrc.slice(fnStart, fnStart + 400);
    assert(!fnBody.includes("effectiveActive"), "must not re-check activity in filter fn");
    assert(fnBody.includes("depth === 0"), "depth 0 filter");
    assert(!fnBody.includes(".sort("), "no second sort in selection");
  });

  await run("HC6", () => {
    const parsed = parseCatalogCategoryList([
      { id: "1", slug: "x", name: "X", depth: 0, sortOrder: 0 },
      { id: "bad" },
    ]);
    assert(parsed.length === 1 && parsed[0].slug === "x", "parse list");
  });

  await run("HC7", () => {
    const catPageSrc = readFileSync(catPagePath, "utf8");
    assert(catPageSrc.includes("fetchCategoryPage"), "PLP uses catalog fetch");
    assert(catPageSrc.includes("catalog/products") || libSrc.includes("CATALOG_PRODUCTS_PATH"), "products API");
    assert(!catPageSrc.includes("/store/home"), "PLP not store/home");
  });

  printSummary(results);
  const failed = results.filter((r) => r.status !== "PASS");
  if (failed.length || results.length !== ids.length) {
    console.log(
      `\nHomepage categories: FAIL (${results.filter((r) => r.status === "PASS").length}/${ids.length})`,
    );
    process.exit(1);
  }
  console.log(`\nHomepage categories: ${results.length}/${ids.length} PASS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
