import { Price } from "@dodo/ui";
import { fetchStoreIdentity } from "@/lib/store-identity";
import { fetchHomepageCategoryShowcase } from "@/lib/store-catalog";
import { HomepageCategoryShowcase } from "@/components/homepage-category-showcase";

export default async function HomePage() {
  const view = await fetchStoreIdentity();
  const categoriesView = await fetchHomepageCategoryShowcase();

  return (
    <main style={{ fontFamily: "IBM Plex Sans, system-ui", padding: "2rem", background: "#f7f5f2", minHeight: "100vh" }}>
      <p style={{ letterSpacing: "0.08em", textTransform: "uppercase", color: "#5c5c5c" }}>
        {view.kind === "logo" ? (
          <img src={view.logoUrl} alt={view.legalName} style={{ display: "block", maxHeight: "2.5rem" }} />
        ) : view.kind === "text" ? (
          view.legalName
        ) : null}
      </p>
      <h1 style={{ color: "#0f3d2e" }}>Kunden-Shop (Schritt 8)</h1>
      <p>Keine Geschäftslogik hier — Preise kommen später nur vom API.</p>
      <p>
        Beispielanzeige: <Price amount="0,00" />
      </p>

      {categoriesView.kind === "ready" ? (
        <HomepageCategoryShowcase categories={categoriesView.categories} />
      ) : categoriesView.kind === "error" ? (
        <p style={{ marginTop: "2rem", color: "#5c5c5c" }} role="status">
          Kategorien konnten nicht geladen werden.
        </p>
      ) : null}
    </main>
  );
}
