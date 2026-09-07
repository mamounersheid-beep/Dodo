import Link from "next/link";
import { notFound } from "next/navigation";
import { Price, tokens } from "@dodo/ui";
import { fetchCategoryPage } from "@/lib/store-catalog";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export default async function CategoryPage({ params }: PageProps) {
  const { slug } = await params;
  const view = await fetchCategoryPage(slug);

  if (view.kind === "not_found") notFound();

  if (view.kind === "error") {
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
        <p role="status">Kategorie konnte nicht geladen werden.</p>
        <p>
          <Link href="/">Zur Startseite</Link>
        </p>
      </main>
    );
  }

  const { category, products } = view;

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
      <p style={{ margin: "0 0 0.5rem" }}>
        <Link href="/" style={{ color: tokens.colorMuted }}>
          Home
        </Link>
      </p>
      <h1 style={{ color: tokens.colorAccent, marginTop: 0 }}>{category.name}</h1>

      {products.length === 0 ? (
        <p style={{ color: tokens.colorMuted }} role="status">
          Keine Produkte in dieser Kategorie.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "1.5rem 0 0", display: "grid", gap: "1rem" }}>
          {products.map((p) => (
            <li
              key={p.id}
              style={{
                display: "flex",
                gap: "1rem",
                alignItems: "center",
                borderBottom: "1px solid #e5e1db",
                paddingBottom: "0.75rem",
              }}
            >
              {p.primaryImageUrl ? (
                <img
                  src={p.primaryImageUrl}
                  alt=""
                  style={{ width: "4rem", height: "5rem", objectFit: "cover" }}
                />
              ) : (
                <div
                  aria-hidden
                  style={{ width: "4rem", height: "5rem", background: "#e5e1db" }}
                />
              )}
              <div>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                {p.priceFrom ? (
                  <p style={{ margin: "0.25rem 0 0" }}>
                    <Price amount={p.priceFrom} />
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
