import { storeIdentityUrl } from "./store-identity";

export const LEGAL_PAGES_PATH = "/legal/pages";
export const IMPRESSUM_SLUG = "impressum";

const IDENTITY_FIELDS = [
  "legalName",
  "line1",
  "postalCode",
  "city",
  "countryCode",
  "supportEmail",
  "supportPhone",
  "logoUrl",
  "steuernummer",
  "vatId",
  "kleinunternehmerId",
] as const;

export type PublicIdentityFields = {
  legalName?: string;
  line1?: string;
  postalCode?: string;
  city?: string;
  countryCode?: string;
  supportEmail?: string;
  supportPhone?: string;
  logoUrl?: string;
  steuernummer?: string;
  vatId?: string;
  kleinunternehmerId?: string;
};

export type PublicLegalPage = {
  slug: string;
  title: string;
  body: string;
  version: string;
  publishedAt: string;
};

export type ImpressumView =
  | { kind: "composite"; identity: PublicIdentityFields; page: PublicLegalPage }
  | { kind: "not_found" };

function present(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length === 0 ? undefined : t;
}

export function publicLegalPageUrl(apiBase: string, slug: string): string {
  return `${apiBase.replace(/\/+$/, "")}${LEGAL_PAGES_PATH}/${slug}`;
}

export function parsePublicLegalPage(body: unknown): PublicLegalPage | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  const slug = present(rec.slug);
  const title = present(rec.title);
  const pageBody = present(rec.body);
  const version = present(rec.version);
  const publishedAt = present(rec.publishedAt);
  if (!slug || !title || !pageBody || !version || !publishedAt) return null;
  return { slug, title, body: pageBody, version, publishedAt };
}

export function parsePublicIdentity(body: unknown): PublicIdentityFields {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const rec = body as Record<string, unknown>;
  const out: PublicIdentityFields = {};
  for (const key of IDENTITY_FIELDS) {
    const value = present(rec[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Composite Impressum requires current PUBLISHED legal prose.
 * Identity alone is never a valid complete Impressum.
 */
export function impressumViewFromSources(input: {
  legalStatus: number;
  legalBody: unknown;
  identityBody: unknown | null;
}): ImpressumView {
  if (input.legalStatus !== 200) return { kind: "not_found" };
  const page = parsePublicLegalPage(input.legalBody);
  if (!page) return { kind: "not_found" };
  return {
    kind: "composite",
    identity: parsePublicIdentity(input.identityBody),
    page,
  };
}

export function isValidCompleteImpressum(view: ImpressumView): boolean {
  return view.kind === "composite";
}

/** Live fetch — no-store. Legal 404 → not_found (page must 404). */
export async function loadImpressum(): Promise<ImpressumView> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL?.trim() ?? "";
  if (!apiBase) return { kind: "not_found" };
  try {
    const legalRes = await fetch(publicLegalPageUrl(apiBase, IMPRESSUM_SLUG), {
      cache: "no-store",
    });
    if (!legalRes.ok) return { kind: "not_found" };
    const legalBody: unknown = await legalRes.json();
    let identityBody: unknown = null;
    try {
      const identityRes = await fetch(storeIdentityUrl(apiBase), { cache: "no-store" });
      if (identityRes.ok) identityBody = await identityRes.json();
    } catch {
      identityBody = null;
    }
    return impressumViewFromSources({
      legalStatus: legalRes.status,
      legalBody,
      identityBody,
    });
  } catch {
    return { kind: "not_found" };
  }
}
