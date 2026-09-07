import {
  fetchPublishedLegalPage,
  parsePublicLegalPage,
  type PublicLegalPage,
} from "./store-legal-page";

export const AGB_SLUG = "agb";

export type AgbView = { kind: "page"; page: PublicLegalPage } | { kind: "not_found" };

/**
 * `/agb` is a single-source LegalPage consumer.
 * Identity / Order snapshot / Admin are never a valid AGB page.
 */
export function agbViewFromLegalResponse(input: {
  legalStatus: number;
  legalBody: unknown;
}): AgbView {
  if (input.legalStatus !== 200) return { kind: "not_found" };
  const page = parsePublicLegalPage(input.legalBody);
  if (!page || page.slug !== AGB_SLUG) return { kind: "not_found" };
  return { kind: "page", page };
}

export function isValidPublishedAgb(view: AgbView): boolean {
  return view.kind === "page";
}

/** Live fetch — no-store. Legal 404 → not_found (page must 404). */
export async function loadAgb(): Promise<AgbView> {
  try {
    const { status, body } = await fetchPublishedLegalPage(AGB_SLUG);
    return agbViewFromLegalResponse({ legalStatus: status, legalBody: body });
  } catch {
    return { kind: "not_found" };
  }
}
