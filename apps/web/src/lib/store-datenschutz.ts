import {
  fetchPublishedLegalPage,
  parsePublicLegalPage,
  type PublicLegalPage,
} from "./store-legal-page";

export const DATENSCHUTZ_SLUG = "datenschutz";

export type DatenschutzView = { kind: "page"; page: PublicLegalPage } | { kind: "not_found" };

/**
 * `/datenschutz` is a single-source LegalPage consumer.
 * Identity / Order snapshot / cookies / Admin are never a valid Datenschutz page.
 */
export function datenschutzViewFromLegalResponse(input: {
  legalStatus: number;
  legalBody: unknown;
}): DatenschutzView {
  if (input.legalStatus !== 200) return { kind: "not_found" };
  const page = parsePublicLegalPage(input.legalBody);
  if (!page || page.slug !== DATENSCHUTZ_SLUG) return { kind: "not_found" };
  return { kind: "page", page };
}

export function isValidPublishedDatenschutz(view: DatenschutzView): boolean {
  return view.kind === "page";
}

/** Live fetch — no-store. Legal 404 → not_found (page must 404). */
export async function loadDatenschutz(): Promise<DatenschutzView> {
  try {
    const { status, body } = await fetchPublishedLegalPage(DATENSCHUTZ_SLUG);
    return datenschutzViewFromLegalResponse({ legalStatus: status, legalBody: body });
  } catch {
    return { kind: "not_found" };
  }
}
