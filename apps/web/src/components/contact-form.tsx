"use client";

import { useState } from "react";
import { CONTACT_SUBJECTS, submitContact, type ContactSubject } from "@/lib/store-contact";

export function ContactForm() {
  const [status, setStatus] = useState<"idle" | "ok" | "err">("idle");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setStatus("idle");
    try {
      const orderNumber = String(data.get("orderNumber") ?? "").trim();
      const result = await submitContact({
        name: String(data.get("name") ?? ""),
        email: String(data.get("email") ?? ""),
        subject: String(data.get("subject") ?? "general") as ContactSubject,
        message: String(data.get("message") ?? ""),
        ...(orderNumber ? { orderNumber } : {}),
      });
      setStatus(result.status === 202 ? "ok" : "err");
      if (result.status === 202) form.reset();
    } catch {
      setStatus("err");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label="Contact">
      <div>
        <label htmlFor="contact-name">Name</label>
        <input id="contact-name" name="name" required />
      </div>
      <div>
        <label htmlFor="contact-email">E-Mail</label>
        <input id="contact-email" name="email" type="email" required />
      </div>
      <div>
        <label htmlFor="contact-subject">Thema</label>
        <select id="contact-subject" name="subject" required defaultValue="general">
          {CONTACT_SUBJECTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="contact-message">Nachricht</label>
        <textarea id="contact-message" name="message" required />
      </div>
      <div>
        <label htmlFor="contact-order">Bestellnummer (optional)</label>
        <input id="contact-order" name="orderNumber" />
      </div>
      <button type="submit" disabled={pending}>
        Senden
      </button>
      {status === "ok" ? <p>Accepted</p> : null}
      {status === "err" ? <p>Invalid request</p> : null}
    </form>
  );
}
