/**
 * V1 Invoice PDF builder — closed content authority only.
 * No live CS / Product / User. No payment method, Widerruf, logo, bonus narrative, ZUGFeRD.
 */
import PDFDocument from "pdfkit";

export type InvoicePdfLine = {
  name: string;
  sku: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  /** Print only when non-null and not KU */
  taxRate: string | null;
};

export type InvoicePdfContent = {
  documentLocale: "de" | "en" | "ar";
  invoiceNumber: string;
  issuedAt: Date;
  leistungsdatum: Date;
  orderNumber: string;
  currencyCode: string;
  isKleinunternehmer: boolean;
  exemptionText: string | null;
  seller: {
    legalName: string;
    line1: string;
    postalCode: string;
    city: string;
    countryCode: string;
    supportEmail: string | null;
    supportPhone: string | null;
    steuernummer: string | null;
    vatId: string | null;
    kleinunternehmerId: string | null;
  };
  buyer: {
    name: string;
    line1: string;
    line2: string | null;
    postalCode: string;
    city: string;
    countryCode: string;
    phone: string | null;
  };
  lines: InvoicePdfLine[];
  itemsSubtotal: string;
  shippingTotal: string;
  discountCoupon: string;
  discountBonus: string;
  couponCode: string | null;
  grandTotal: string;
};

const LABELS = {
  de: {
    title: "Rechnung",
    invoiceNo: "Rechnungsnummer",
    issuedAt: "Rechnungsdatum",
    leistungsdatum: "Leistungsdatum",
    orderNo: "Bestellnummer",
    seller: "Verkäufer",
    buyer: "Rechnungsempfänger",
    sku: "SKU",
    qty: "Menge",
    unit: "Einzelpreis",
    lineTotal: "Summe",
    subtotal: "Zwischensumme",
    shipping: "Versand",
    coupon: "Rabatt (Gutschein)",
    bonus: "Rabatt (Bonus+)",
    grand: "Gesamtbetrag",
    taxIds: "Steuerangaben",
  },
  en: {
    title: "Invoice",
    invoiceNo: "Invoice number",
    issuedAt: "Invoice date",
    leistungsdatum: "Supply date",
    orderNo: "Order number",
    seller: "Seller",
    buyer: "Bill to",
    sku: "SKU",
    qty: "Qty",
    unit: "Unit price",
    lineTotal: "Line total",
    subtotal: "Subtotal",
    shipping: "Shipping",
    coupon: "Discount (coupon)",
    bonus: "Discount (Bonus+)",
    grand: "Grand total",
    taxIds: "Tax identifiers",
  },
  ar: {
    title: "Invoice",
    invoiceNo: "Invoice number",
    issuedAt: "Invoice date",
    leistungsdatum: "Supply date",
    orderNo: "Order number",
    seller: "Seller",
    buyer: "Bill to",
    sku: "SKU",
    qty: "Qty",
    unit: "Unit price",
    lineTotal: "Line total",
    subtotal: "Subtotal",
    shipping: "Shipping",
    coupon: "Discount (coupon)",
    bonus: "Discount (Bonus+)",
    grand: "Grand total",
    taxIds: "Tax identifiers",
  },
} as const;

/** Legal/tax boilerplate always Market DE (10.11 §7). */
const LEGAL_DE_FOOTER =
  "Steuerliche Angaben gemäß deutschem Recht (Market DE). Bei Kleinunternehmerregelung nach § 19 UStG wird keine Umsatzsteuer gesondert ausgewiesen.";

export function resolveDocumentLocale(locale: string | null | undefined): "de" | "en" | "ar" {
  const v = (locale ?? "").trim().toLowerCase();
  if (v === "de" || v === "en" || v === "ar") return v;
  return "en";
}

export function formatInvoiceMoney(value: { toString(): string } | string | number): string {
  const n = typeof value === "number" ? value : Number(value.toString());
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

export function buildInvoicePdfBuffer(content: InvoicePdfContent): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, compress: false });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const L = LABELS[content.documentLocale];
    const money = (v: string) => `${v} ${content.currencyCode}`;

    doc.fontSize(18).text(L.title, { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);
    doc.text(`${L.invoiceNo}: ${content.invoiceNumber}`);
    doc.text(`${L.issuedAt}: ${formatDateDe(content.issuedAt)}`);
    doc.text(`${L.leistungsdatum}: ${formatDateDe(content.leistungsdatum)}`);
    doc.text(`${L.orderNo}: ${content.orderNumber}`);
    doc.moveDown();

    doc.fontSize(12).text(L.seller);
    doc.fontSize(10);
    const s = content.seller;
    doc.text(s.legalName);
    doc.text(s.line1);
    doc.text(`${s.postalCode} ${s.city}`);
    doc.text(s.countryCode);
    if (s.supportEmail) doc.text(s.supportEmail);
    if (s.supportPhone) doc.text(s.supportPhone);
    doc.moveDown(0.5);
    doc.text(L.taxIds);
    if (s.steuernummer) doc.text(`Steuernummer: ${s.steuernummer}`);
    if (s.vatId) doc.text(`USt-IdNr.: ${s.vatId}`);
    if (s.kleinunternehmerId) doc.text(`Kleinunternehmer-ID: ${s.kleinunternehmerId}`);
    doc.moveDown();

    doc.fontSize(12).text(L.buyer);
    doc.fontSize(10);
    const b = content.buyer;
    doc.text(b.name);
    doc.text(b.line1);
    if (b.line2) doc.text(b.line2);
    doc.text(`${b.postalCode} ${b.city}`);
    doc.text(b.countryCode);
    if (b.phone) doc.text(b.phone);
    doc.moveDown();

    for (const line of content.lines) {
      doc.text(`${line.name} (${L.sku}: ${line.sku})`);
      const taxBit =
        !content.isKleinunternehmer && line.taxRate != null
          ? ` · MwSt ${line.taxRate}%`
          : "";
      doc.text(
        `  ${L.qty}: ${line.quantity} · ${L.unit}: ${money(line.unitPrice)} · ${L.lineTotal}: ${money(line.lineTotal)}${taxBit}`,
      );
    }
    doc.moveDown();

    doc.text(`${L.subtotal}: ${money(content.itemsSubtotal)}`);
    doc.text(`${L.shipping}: ${money(content.shippingTotal)}`);
    if (Number(content.discountCoupon) > 0) {
      const code = content.couponCode ? ` (${content.couponCode})` : "";
      doc.text(`${L.coupon}${code}: -${money(content.discountCoupon)}`);
    }
    if (Number(content.discountBonus) > 0) {
      doc.text(`${L.bonus}: -${money(content.discountBonus)}`);
    }
    doc.fontSize(12).text(`${L.grand}: ${money(content.grandTotal)}`);
    doc.moveDown();

    doc.fontSize(9);
    if (content.isKleinunternehmer && content.exemptionText) {
      doc.text(content.exemptionText);
    } else if (content.exemptionText) {
      doc.text(content.exemptionText);
    }
    // Under KU: never print synthetic "MwSt 0,00"
    doc.moveDown(0.5);
    doc.text(LEGAL_DE_FOOTER);

    doc.end();
  });
}

function formatDateDe(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${day}.${m}.${y}`;
}
