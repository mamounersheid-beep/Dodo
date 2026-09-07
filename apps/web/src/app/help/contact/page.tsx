import { tokens } from "@dodo/ui";
import { ContactForm } from "@/components/contact-form";

export default function HelpContactPage() {
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
      <h1 style={{ color: tokens.colorAccent, marginTop: 0 }}>Contact</h1>
      <ContactForm />
    </main>
  );
}
