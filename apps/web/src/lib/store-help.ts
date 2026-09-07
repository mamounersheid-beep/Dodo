/** Help Hub `/help` — static link composition only. No CMS / API fetch. */

export const HELP_HUB_PATH = "/help";

export const HELP_HUB_FAQ_HREF = "/help/faq";
export const HELP_HUB_CONTACT_HREF = "/help/contact";

export const HELP_HUB_LEGAL_HREFS = [
  "/impressum",
  "/agb",
  "/datenschutz",
  "/widerruf",
] as const;

export const HELP_HUB_LINKS = {
  faq: { label: "FAQ", href: HELP_HUB_FAQ_HREF },
  contact: { label: "Contact", href: HELP_HUB_CONTACT_HREF },
  legal: [
    { label: "Impressum", href: "/impressum" },
    { label: "AGB", href: "/agb" },
    { label: "Datenschutz", href: "/datenschutz" },
    { label: "Widerruf", href: "/widerruf" },
  ],
} as const;
