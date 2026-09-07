import { tokens } from "@dodo/ui";
import { FOOTER_NAV } from "@/lib/store-footer-nav";
import { fetchStoreIdentity } from "@/lib/store-identity";

/** Site Footer — live legalName / logoUrl from GET /v1/store/identity only. */
export async function StoreFooter() {
  const view = await fetchStoreIdentity();

  return (
    <footer
      style={{
        fontFamily: tokens.fontSans,
        background: tokens.colorBg,
        borderTop: "1px solid #e6e2dc",
        padding: "0.75rem 1.5rem",
      }}
    >
      {view.kind === "logo" ? (
        <img src={view.logoUrl} alt={view.legalName} style={{ display: "block", maxHeight: "2rem" }} />
      ) : view.kind === "text" ? (
        <span style={{ color: tokens.colorAccent, fontWeight: 600 }}>{view.legalName}</span>
      ) : null}
      <nav aria-label="Footer" style={{ marginTop: "0.75rem" }}>
        <a href={FOOTER_NAV.help.href}>{FOOTER_NAV.help.label}</a>
        {" · "}
        <a href={FOOTER_NAV.faq.href}>{FOOTER_NAV.faq.label}</a>
        {" · "}
        <a href={FOOTER_NAV.contact.href}>{FOOTER_NAV.contact.label}</a>
        {" · "}
        <span aria-label="Legal">
          Legal
          {FOOTER_NAV.legal.map((link) => (
            <span key={link.href}>
              {" · "}
              <a href={link.href}>{link.label}</a>
            </span>
          ))}
        </span>
      </nav>
    </footer>
  );
}
