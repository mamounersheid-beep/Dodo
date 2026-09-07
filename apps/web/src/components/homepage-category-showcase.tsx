import Link from "next/link";
import type { CatalogCategory } from "@/lib/store-catalog";
import { categoryPageHref } from "@/lib/store-catalog";

/** Minimal §1c homepage category tile — name + slug link only (no images). */
export function HomepageCategoryShowcase(props: {
  categories: CatalogCategory[];
}) {
  if (props.categories.length === 0) return null;

  return (
    <section aria-label="Kategorien" style={{ marginTop: "2.5rem" }}>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "grid",
          gap: "0.75rem",
          gridTemplateColumns: "repeat(auto-fill, minmax(10rem, 1fr))",
        }}
      >
        {props.categories.map((c) => (
          <li key={c.id}>
            <Link
              href={categoryPageHref(c.slug)}
              style={{
                display: "block",
                padding: "0.85rem 1rem",
                border: "1px solid #d4cfc7",
                color: "#0f3d2e",
                textDecoration: "none",
                background: "#fff",
              }}
            >
              {c.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
