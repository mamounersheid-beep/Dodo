import {
  parsePublicLegalPage,
  type PublicLegalPage,
} from "./store-legal-page";

/** Public FAQ index — GET /v1/legal/faq (current PUBLISHED `faq-*` DE only). */
export const FAQ_LIST_PATH = "/legal/faq";

export type FaqView = { kind: "list"; articles: PublicLegalPage[] };

export function publicFaqListUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, "")}${FAQ_LIST_PATH}`;
}

export function parsePublicFaqList(body: unknown): PublicLegalPage[] | null {
  if (!Array.isArray(body)) return null;
  const articles: PublicLegalPage[] = [];
  for (const item of body) {
    const page = parsePublicLegalPage(item);
    if (!page || !page.slug.startsWith("faq-")) continue;
    articles.push(page);
  }
  return articles;
}

export function faqViewFromListResponse(input: {
  faqStatus: number;
  faqBody: unknown;
}): FaqView {
  if (input.faqStatus !== 200) return { kind: "list", articles: [] };
  const articles = parsePublicFaqList(input.faqBody);
  if (!articles) return { kind: "list", articles: [] };
  return { kind: "list", articles };
}

export async function fetchPublishedFaqList(): Promise<{ status: number; body: unknown }> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL?.trim() ?? "";
  if (!apiBase) return { status: 0, body: null };
  const res = await fetch(publicFaqListUrl(apiBase), { cache: "no-store" });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Live fetch — no-store. Empty `[]` is a real index, never a page 404. */
export async function loadFaq(): Promise<FaqView> {
  try {
    const { status, body } = await fetchPublishedFaqList();
    return faqViewFromListResponse({ faqStatus: status, faqBody: body });
  } catch {
    return { kind: "list", articles: [] };
  }
}
