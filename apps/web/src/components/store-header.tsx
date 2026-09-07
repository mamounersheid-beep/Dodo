import { tokens } from "@dodo/ui";
import { fetchStoreIdentityForHeader } from "@/lib/store-identity";

/** Site Header — live legalName / logoUrl from GET /v1/store/identity only. */
export async function StoreHeader() {
  const view = await fetchStoreIdentityForHeader();

  return (
    <header
      role="banner"
      style={{
        fontFamily: tokens.fontSans,
        background: tokens.colorBg,
        borderBottom: "1px solid #e6e2dc",
        padding: "0.75rem 1.5rem",
      }}
    >
      <a
        href="/"
        style={{
          display: "inline-flex",
          alignItems: "center",
          color: tokens.colorAccent,
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        {view.kind === "logo" ? (
          <img src={view.logoUrl} alt={view.legalName} style={{ display: "block", maxHeight: "2rem" }} />
        ) : view.kind === "text" ? (
          <span>{view.legalName}</span>
        ) : null}
      </a>
    </header>
  );
}
