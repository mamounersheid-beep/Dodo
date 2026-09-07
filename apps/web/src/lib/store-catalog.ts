/** Catalog Categories — public GET /v1/catalog/categories (+ by slug / products). FE only; Catalog owns semantics. */

export const CATALOG_CATEGORIES_PATH = "/catalog/categories";
export const CATALOG_PRODUCTS_PATH = "/catalog/products";

/** Storefront category PLP — slug-based (§1c link contract). */
export const CATEGORY_ROUTE_PREFIX = "/category";

export const HOMEPAGE_CATEGORY_CAP = 8;

export type CatalogCategory = {
  id: string;
  slug: string;
  name: string;
  depth: number;
  sortOrder: number;
  path?: string;
  description?: string | null;
};

export type CatalogProductCard = {
  id: string;
  slug: string;
  name: string;
  primaryImageUrl: string | null;
  priceFrom: string | null;
  sellable?: boolean;
};

function present(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length === 0 ? undefined : t;
}

export function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL?.trim() ?? "";
}

export function catalogCategoriesUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, "")}${CATALOG_CATEGORIES_PATH}`;
}

export function catalogCategoryUrl(apiBase: string, slug: string): string {
  return `${apiBase.replace(/\/+$/, "")}${CATALOG_CATEGORIES_PATH}/${encodeURIComponent(slug)}`;
}

export function catalogProductsByCategoryUrl(apiBase: string, categorySlug: string): string {
  const base = `${apiBase.replace(/\/+$/, "")}${CATALOG_PRODUCTS_PATH}`;
  const q = new URLSearchParams({ category: categorySlug });
  return `${base}?${q.toString()}`;
}

/** Href for storefront category page from Catalog `slug`. */
export function categoryPageHref(slug: string): string {
  return `${CATEGORY_ROUTE_PREFIX}/${encodeURIComponent(slug)}`;
}

export function parseCatalogCategory(raw: unknown): CatalogCategory | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const id = present(rec.id);
  const slug = present(rec.slug);
  const name = present(rec.name);
  const depth = typeof rec.depth === "number" && Number.isFinite(rec.depth) ? rec.depth : null;
  const sortOrder =
    typeof rec.sortOrder === "number" && Number.isFinite(rec.sortOrder) ? rec.sortOrder : 0;
  if (!id || !slug || !name || depth === null) return null;
  return {
    id,
    slug,
    name,
    depth,
    sortOrder,
    path: present(rec.path),
    description: present(rec.description) ?? null,
  };
}

/**
 * §1c Homepage roots: keep depth === 0 in Catalog order; take first HOMEPAGE_CATEGORY_CAP.
 * Activity filtering stays on the Catalog API response; FE does not re-validate visibility.
 * Does not re-sort.
 */
export function homepageRootCategories(items: CatalogCategory[]): CatalogCategory[] {
  const roots: CatalogCategory[] = [];
  for (const c of items) {
    if (c.depth === 0) roots.push(c);
  }
  return roots.slice(0, HOMEPAGE_CATEGORY_CAP);
}

export function parseCatalogCategoryList(body: unknown): CatalogCategory[] {
  if (!Array.isArray(body)) return [];
  const out: CatalogCategory[] = [];
  for (const row of body) {
    const parsed = parseCatalogCategory(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseCatalogProductCard(raw: unknown): CatalogProductCard | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const id = present(rec.id);
  const slug = present(rec.slug);
  const name = present(rec.name);
  if (!id || !slug || !name) return null;
  const primaryImageUrl = present(rec.primaryImageUrl) ?? null;
  const priceFrom = present(rec.priceFrom) ?? null;
  return { id, slug, name, primaryImageUrl, priceFrom };
}

export type HomepageCategoryShowcaseView =
  | { kind: "ready"; categories: CatalogCategory[] }
  | { kind: "empty" }
  | { kind: "error" };

export async function fetchHomepageCategoryShowcase(): Promise<HomepageCategoryShowcaseView> {
  const apiBase = apiBaseUrl();
  if (!apiBase) return { kind: "empty" };
  try {
    const res = await fetch(catalogCategoriesUrl(apiBase), { cache: "no-store" });
    if (!res.ok) return { kind: "error" };
    const items = parseCatalogCategoryList(await res.json());
    const categories = homepageRootCategories(items);
    if (categories.length === 0) return { kind: "empty" };
    return { kind: "ready", categories };
  } catch {
    return { kind: "error" };
  }
}

export type CategoryPageView =
  | { kind: "ready"; category: CatalogCategory; products: CatalogProductCard[] }
  | { kind: "not_found" }
  | { kind: "error" };

export async function fetchCategoryPage(slug: string): Promise<CategoryPageView> {
  const apiBase = apiBaseUrl();
  if (!apiBase) return { kind: "error" };
  const trimmed = slug.trim();
  if (!trimmed) return { kind: "not_found" };

  try {
    const catRes = await fetch(catalogCategoryUrl(apiBase, trimmed), { cache: "no-store" });
    if (catRes.status === 404) return { kind: "not_found" };
    if (!catRes.ok) return { kind: "error" };
    const category = parseCatalogCategory(await catRes.json());
    if (!category) return { kind: "error" };

    const prodRes = await fetch(catalogProductsByCategoryUrl(apiBase, category.slug), {
      cache: "no-store",
    });
    if (!prodRes.ok) return { kind: "error" };
    const prodBody = (await prodRes.json()) as { items?: unknown };
    const items = Array.isArray(prodBody?.items) ? prodBody.items : [];
    const products: CatalogProductCard[] = [];
    for (const row of items) {
      const card = parseCatalogProductCard(row);
      if (card) products.push(card);
    }
    return { kind: "ready", category, products };
  } catch {
    return { kind: "error" };
  }
}
