import { notFound } from "next/navigation";
import { tokens } from "@dodo/ui";
import { loadDatenschutz } from "@/lib/store-datenschutz";

export const dynamic = "force-dynamic";

export default async function DatenschutzPage() {
  const view = await loadDatenschutz();
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
      <section aria-label="Datenschutz">
        <div style={{ whiteSpace: "pre-wrap" }}>{view.page.body}</div>
      </section>
    </main>
  );
}
