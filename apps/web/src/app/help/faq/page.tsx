import { tokens } from "@dodo/ui";
import { loadFaq } from "@/lib/store-faq";

export const dynamic = "force-dynamic";

export default async function HelpFaqPage() {
  const view = await loadFaq();

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
      <h1 style={{ color: tokens.colorAccent, marginTop: 0 }}>FAQ</h1>
      {view.articles.length === 0 ? (
        <section aria-label="FAQ" data-faq-empty="true" />
      ) : (
        <section aria-label="FAQ">
          {view.articles.map((article) => (
            <article key={article.slug}>
              <h2>{article.title}</h2>
              <div style={{ whiteSpace: "pre-wrap" }}>{article.body}</div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
