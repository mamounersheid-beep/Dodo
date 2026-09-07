/** Public LegalPage client — GET /v1/legal/pages/:slug (current PUBLISHED only). */

export const LEGAL_PAGES_PATH = "/legal/pages";

export const PUBLIC_LEGAL_PAGE_FIELDS = [
  "slug",
  "title",
  "body",
  "version",
  "publishedAt",
] as const;

export type PublicLegalPage = {
  slug: string;
  title: string;
  body: string;
  version: string;
  publishedAt: string;
};

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

export async function fetchPublishedLegalPage(
  slug: string,
): Promise<{ status: number; body: unknown }> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL?.trim() ?? "";
  if (!apiBase) return { status: 0, body: null };
  const res = await fetch(publicLegalPageUrl(apiBase, slug), { cache: "no-store" });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}
