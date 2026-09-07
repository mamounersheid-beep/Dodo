import { env } from "../../config/env";
import type { EnqueueContactFormJob } from "./email-integration.port";
import type { SmtpTransport } from "./smtp-transport.port";

const SUBJECT_LABEL: Record<string, string> = {
  order: "Bestellung",
  payment: "Zahlung",
  shipping: "Versand",
  return: "Rückgabe",
  account: "Konto",
  general: "Allgemein",
};

export async function processContactFormJob(
  payload: EnqueueContactFormJob,
  deps: { transport: SmtpTransport },
): Promise<void> {
  const label = SUBJECT_LABEL[payload.subject] ?? payload.subject;
  const lines = [
    `Betreff: ${label}`,
    `Name: ${payload.name}`,
    `E-Mail: ${payload.replyEmail}`,
  ];
  if (payload.orderNumber) lines.push(`Bestellnummer: ${payload.orderNumber}`);
  if (payload.userId) lines.push(`userId: ${payload.userId}`);
  lines.push("", payload.message);

  await deps.transport.sendMail({
    from: env.EMAIL_FROM,
    to: payload.to,
    subject: `Kontakt: ${label}`,
    text: lines.join("\n"),
    meta: {
      template: payload.template,
      idempotencyKey: payload.idempotencyKey,
      communicationLocale: payload.communicationLocale,
    },
  });
}
