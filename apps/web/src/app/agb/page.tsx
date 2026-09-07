import { notFound } from "next/navigation";
import { tokens } from "@dodo/ui";
import { loadAgb } from "@/lib/store-agb";

export const dynamic = "force-dynamic";

export default async function AgbPage() {
  const view = await loadAgb();
  if (view.kind === "not_found") notFound();

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
      <h1 style={{ color: tokens.colorAccent, marginTop: 0 }}>{view.page.title}</h1>
      <section aria-label="AGB">
        <div style={{ whiteSpace: "pre-wrap" }}>{view.page.body}</div>
      </section>
    </main>
  );
}
