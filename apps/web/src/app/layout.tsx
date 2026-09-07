import type { Metadata } from "next";
import { StoreHeader } from "@/components/store-header";
import { StoreFooter } from "@/components/store-footer";
import { fetchStoreIdentity } from "@/lib/store-identity";
import {
  legalNameFromIdentityView,
  resolveDocumentTitle,
} from "@/lib/store-document-title";

/** Live CompanySettings via identity fetch — not a build snapshot (CI-3 / CI-6). */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const view = await fetchStoreIdentity();
  const title = resolveDocumentTitle({
    legalName: legalNameFromIdentityView(view),
  });
  return {
    ...(title !== undefined ? { title } : {}),
    description: "Deutscher Onlineshop — Aufbau Schritt 8",
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body style={{ margin: 0 }}>
        <StoreHeader />
        {children}
        <StoreFooter />
      </body>
    </html>
  );
}
