/** Public store identity — Header / Homepage / Footer consume GET /v1/store/identity only (CI-6). */

export const STORE_IDENTITY_PATH = "/store/identity";

export type HeaderIdentityView =
  | { kind: "logo"; legalName: string; logoUrl: string }
  | { kind: "text"; legalName: string }
  | { kind: "empty" };

function present(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length === 0 ? undefined : t;
}

/**
 * Storefront identity view from a live identity JSON body.
 * Reads only `legalName` and `logoUrl`. Never the storage object key, never operational flags.
 */
export function headerIdentityFromResponse(body: unknown): HeaderIdentityView {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { kind: "empty" };
  }
  const rec = body as Record<string, unknown>;
  const legalName = present(rec.legalName);
  const logoUrl = present(rec.logoUrl);
  if (logoUrl) {
    return { kind: "logo", legalName: legalName ?? "", logoUrl };
  }
  if (legalName) {
    return { kind: "text", legalName };
  }
  return { kind: "empty" };
}

export function storeIdentityUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, "")}${STORE_IDENTITY_PATH}`;
}

/** Live fetch — no-store so Header / Homepage / Footer are not a snapshot. */
export async function fetchStoreIdentity(): Promise<HeaderIdentityView> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL?.trim() ?? "";
  if (!apiBase) return { kind: "empty" };
  try {
    const res = await fetch(storeIdentityUrl(apiBase), { cache: "no-store" });
    if (!res.ok) return { kind: "empty" };
    return headerIdentityFromResponse(await res.json());
  } catch {
    return { kind: "empty" };
  }
}

export const fetchStoreIdentityForHeader = fetchStoreIdentity;
