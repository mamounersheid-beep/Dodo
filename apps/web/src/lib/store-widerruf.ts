import {
  fetchPublishedLegalPage,
  parsePublicLegalPage,
  type PublicLegalPage,
} from "./store-legal-page";

export const WIDERRUF_SLUG = "widerruf";

export type WiderrufView = { kind: "page"; page: PublicLegalPage } | { kind: "not_found" };

/**
 * `/widerruf` is a single-source LegalPage consumer.
 * Identity / Order snapshot / returns / Admin are never a valid Widerruf page.
 */
export function widerrufViewFromLegalResponse(input: {
  legalStatus: number;
  legalBody: unknown;
}): WiderrufView {
  if (input.legalStatus !== 200) return { kind: "not_found" };
  const page = parsePublicLegalPage(input.legalBody);
  if (!page || page.slug !== WIDERRUF_SLUG) return { kind: "not_found" };
  return { kind: "page", page };
}

export function isValidPublishedWiderruf(view: WiderrufView): boolean {
  return view.kind === "page";
}

/** Live fetch — no-store. Legal 404 → not_found (page must 404). */
export async function loadWiderruf(): Promise<WiderrufView> {
  try {
    const { status, body } = await fetchPublishedLegalPage(WIDERRUF_SLUG);
    return widerrufViewFromLegalResponse({ legalStatus: status, legalBody: body });
  } catch {
    return { kind: "not_found" };
  }
}
