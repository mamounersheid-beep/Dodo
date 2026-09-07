import { tokens } from "@dodo/ui";
import { HELP_HUB_LINKS } from "@/lib/store-help";

export default function HelpHubPage() {
  return (
    <main
      style={{
        fontFamily: tokens.fontSans,
        background: tokens.colorBg,
        color: tokens.colorText,
        minHeight: "100vh",
        padding: "2rem",
      }}
    >
      <h1 style={{ color: tokens.colorAccent, marginTop: 0 }}>Help</h1>
      <section aria-label="FAQ">
        <a href={HELP_HUB_LINKS.faq.href}>{HELP_HUB_LINKS.faq.label}</a>
      </section>
      <section aria-label="Contact">
        <a href={HELP_HUB_LINKS.contact.href}>{HELP_HUB_LINKS.contact.label}</a>
      </section>
      <section aria-label="Legal">
        {HELP_HUB_LINKS.legal.map((link) => (
          <div key={link.href}>
            <a href={link.href}>{link.label}</a>
          </div>
        ))}
      </section>
    </main>
  );
}
