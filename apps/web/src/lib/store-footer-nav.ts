/** Footer reachability — frozen inventory hrefs only. No API fetch. */

export const FOOTER_HELP_HREF = "/help";
export const FOOTER_FAQ_HREF = "/help/faq";
export const FOOTER_CONTACT_HREF = "/help/contact";

export const FOOTER_LEGAL_HREFS = [
  "/impressum",
  "/agb",
  "/datenschutz",
  "/widerruf",
] as const;

export const FOOTER_NAV = {
  help: { label: "Help", href: FOOTER_HELP_HREF },
  faq: { label: "FAQ", href: FOOTER_FAQ_HREF },
  contact: { label: "Contact", href: FOOTER_CONTACT_HREF },
  legal: [
    { label: "Impressum", href: "/impressum" },
    { label: "AGB", href: "/agb" },
    { label: "Datenschutz", href: "/datenschutz" },
    { label: "Widerruf", href: "/widerruf" },
  ],
} as const;
