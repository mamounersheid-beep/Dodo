import type { HeaderIdentityView } from "./store-identity";

function present(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length === 0 ? undefined : t;
}

/**
 * Closed SoT: page `seoTitle` wins where defined; otherwise `legalName`.
 * Never returns a bootstrap project name.
 */
export function resolveDocumentTitle(input: {
  seoTitle?: unknown;
  legalName?: unknown;
}): string | undefined {
  const seoTitle = present(input.seoTitle);
  if (seoTitle !== undefined) return seoTitle;
  return present(input.legalName);
}

export function legalNameFromIdentityView(view: HeaderIdentityView): string | undefined {
  if (view.kind === "empty") return undefined;
  return present(view.legalName);
}
