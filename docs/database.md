# Database

- Schema legal source: locked `DATABASE_ERD.md` (Ersheid · 2026-08-30)
- Prisma = derived implementation only; any schema change starts in ERD first, then Prisma
- Checkout/state/compliance/architecture behavior lives outside the ERD (dedicated docs)
- Order snapshot at confirm; never UPDATE invoice totals (CreditNote / Storno only)
- `orderNumber` and `invoiceNumber` = separate atomic sequences
- Cart = purchase intent only; stock deduct / short lock at checkout-payment — not on add-to-cart
- Free shipping progress: DE threshold **70.00 EUR** Warenwert after Gutschein (per-country rows later)
- Discount order: Gutschein (Coupon) then Bonus+
- BonusLedger append-only + `idempotencyKey`; earn after PAID+CONFIRMED
- Locales: `de` | `en` | `ar`; device default then account settings
- Seeds must not invent fake public stock scarcity
