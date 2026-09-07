/** Catalog helpers — no Nest/DB side effects (unit-tested). */

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Levels: depth 0..2 inclusive (3 levels max). */
export const MAX_CATEGORY_DEPTH = 2;

/** Max ProductImage rows per product (product-level + variant-level). */
export const MAX_IMAGES_PER_PRODUCT = 20;

/**
 * Service-closed Grundpreis units (L5 / 10.2).
 * Not the final legal catalogue — expandable; no free text.
 */
export const ALLOWED_GRUNDPREIS_UNITS = [
  "1 kg",
  "100 g",
  "1 l",
  "100 ml",
  "1 m",
  "1 m²",
  "1 Stück",
] as const;

export type AllowedGrundpreisUnit = (typeof ALLOWED_GRUNDPREIS_UNITS)[number];

export function assertAspectRatio(ratio: string): void {
  if (ratio !== "4:5") {
    throw new Error("IMAGE_ASPECT_MUST_BE_4_5");
  }
}

/** sellable(product) = Product.isActive ∧ ≥1 active Variant (10.2). */
export function isProductSellable(productIsActive: boolean, activeVariantCount: number): boolean {
  return productIsActive === true && activeVariantCount > 0;
}

/** lineSellable = Product.isActive ∧ Variant.isActive (no stock). */
export function isLineSellable(productIsActive: boolean, variantIsActive: boolean): boolean {
  return productIsActive === true && variantIsActive === true;
}

export function isAllowedGrundpreisUnit(unit: string | null | undefined): boolean {
  if (!unit) return false;
  return (ALLOWED_GRUNDPREIS_UNITS as readonly string[]).includes(unit);
}

/** effectiveRequired from Category.requiresGrundpreis + Product.grundpreisRequirement. */
export function grundpreisEffectiveRequired(
  categoryRequires: boolean,
  productRequirement: "inherit" | "require" | "exempt",
): boolean {
  if (productRequirement === "require") return true;
  if (productRequirement === "exempt") return false;
  return categoryRequires === true;
}

export function attributeKeys(attrs: unknown): string[] {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return [];
  return Object.keys(attrs as Record<string, unknown>).sort();
}

export function attributeFingerprint(attrs: unknown): string {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return "{}";
  const o = attrs as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of keys) normalized[k] = o[k];
  return JSON.stringify(normalized);
}

export function sameKeySet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Derive option axes from variant attributes; label fallback = key (no ERD labels field). */
export function deriveOptionAxes(
  variants: Array<{ attributesJson: unknown; isActive?: boolean }>,
): { axes: Array<{ key: string; label: string; values: string[] }>; optionMode: "simple" | "variable" } {
  const active = variants.filter((v) => v.isActive !== false);
  const keySets = active.map((v) => attributeKeys(v.attributesJson));
  const allKeys = new Set<string>();
  for (const ks of keySets) for (const k of ks) allKeys.add(k);
  const keys = [...allKeys].sort();
  if (keys.length === 0) {
    return { axes: [], optionMode: "simple" };
  }
  const axes = keys.map((key) => {
    const values = new Set<string>();
    for (const v of active) {
      const o = v.attributesJson;
      if (o && typeof o === "object" && !Array.isArray(o)) {
        const val = (o as Record<string, unknown>)[key];
        if (val !== undefined && val !== null) values.add(String(val));
      }
    }
    return { key, label: key, values: [...values].sort() };
  });
  return { axes, optionMode: "variable" };
}

export function resolveLocale(requested?: string | null): "de" | "en" | "ar" {
  if (requested === "de" || requested === "en" || requested === "ar") return requested;
  return "de";
}

/** Parse Accept-Language primary tag → de|en|ar|null. */
export function localeFromAcceptLanguage(header?: string | null): "de" | "en" | "ar" | null {
  if (!header) return null;
  const primary = header.split(",")[0]?.trim().split(";")[0]?.trim().toLowerCase();
  if (!primary) return null;
  if (primary.startsWith("de")) return "de";
  if (primary.startsWith("en")) return "en";
  if (primary.startsWith("ar")) return "ar";
  return null;
}
