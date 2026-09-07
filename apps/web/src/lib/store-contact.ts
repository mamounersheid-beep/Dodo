export const CONTACT_PATH = "/contact";
export const HELP_CONTACT_HREF = "/help/contact";

export const CONTACT_SUBJECTS = [
  "order",
  "payment",
  "shipping",
  "return",
  "account",
  "general",
] as const;

export type ContactSubject = (typeof CONTACT_SUBJECTS)[number];

export function publicContactUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, "")}${CONTACT_PATH}`;
}

export async function submitContact(input: {
  name: string;
  email: string;
  subject: ContactSubject;
  message: string;
  orderNumber?: string;
}): Promise<{ status: number; body: unknown }> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL?.trim() ?? "";
  if (!apiBase) return { status: 0, body: null };
  const res = await fetch(publicContactUrl(apiBase), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      email: input.email,
      subject: input.subject,
      message: input.message,
      ...(input.orderNumber ? { orderNumber: input.orderNumber } : {}),
    }),
    cache: "no-store",
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}
