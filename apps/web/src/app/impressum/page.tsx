import { notFound } from "next/navigation";
import { tokens } from "@dodo/ui";
import { loadImpressum, type PublicIdentityFields } from "@/lib/store-impressum";

export const dynamic = "force-dynamic";

function TmgBlock({ identity }: { identity: PublicIdentityFields }) {
  const hasAddress = Boolean(identity.line1 || identity.postalCode || identity.city || identity.countryCode);
  const hasContact = Boolean(identity.supportEmail || identity.supportPhone);
  const hasTax = Boolean(identity.steuernummer || identity.vatId || identity.kleinunternehmerId);

  return (
    <section aria-label="Angaben gemäß TMG">
      {identity.logoUrl ? (
        <img
          src={identity.logoUrl}
          alt={identity.legalName ?? ""}
          style={{ display: "block", maxHeight: "2.5rem", marginBottom: "1rem" }}
        />
      ) : null}
      {identity.legalName ? (
        <p style={{ fontWeight: 600, margin: "0 0 0.5rem" }}>{identity.legalName}</p>
      ) : null}
      {hasAddress ? (
        <p style={{ margin: "0 0 0.5rem" }}>
          {identity.line1 ? (
            <>
              {identity.line1}
              <br />
            </>
          ) : null}
          {[identity.postalCode, identity.city].filter(Boolean).join(" ")}
          {identity.countryCode ? (
            <>
              <br />
              {identity.countryCode}
            </>
          ) : null}
        </p>
      ) : null}
      {hasContact ? (
        <p style={{ margin: "0 0 0.5rem" }}>
          {identity.supportEmail ? (
            <>
              E-Mail: {identity.supportEmail}
              <br />
            </>
          ) : null}
          {identity.supportPhone ? <>Telefon: {identity.supportPhone}</> : null}
        </p>
      ) : null}
      {hasTax ? (
        <p style={{ margin: 0 }}>
          {identity.steuernummer ? (
            <>
              Steuernummer: {identity.steuernummer}
              <br />
            </>
          ) : null}
          {identity.vatId ? (
            <>
              USt-IdNr.: {identity.vatId}
              <br />
            </>
          ) : null}
          {identity.kleinunternehmerId ? <>Kleinunternehmer-Id: {identity.kleinunternehmerId}</> : null}
        </p>
      ) : null}
    </section>
  );
}

export default async function ImpressumPage() {
  const view = await loadImpressum();
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
      <TmgBlock identity={view.identity} />
      <section aria-label="Rechtlicher Text" style={{ marginTop: "2rem" }}>
        <div style={{ whiteSpace: "pre-wrap" }}>{view.page.body}</div>
      </section>
    </main>
  );
}
