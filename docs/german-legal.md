# German legal (implementation constraints)

## Kleinunternehmer invoice text (locked)

> Gemäß § 19 UStG wird keine Umsatzsteuer berechnet. Es gilt die Steuerbefreiung für Kleinunternehmer.

- No displayed “MwSt 0,00 €” as calculated VAT while exempt
- Snapshot `companyIsKleinunternehmer` + exemption text on every order
- Button-Lösung on pay CTA; PAngV gross display; Widerruf 14 days from `deliveredAt`
- GoBD: no invoice UPDATE; GDPR export/erase with financial retention
- Cookie analytics only after consent
- `[Verify]` items stay human-closed
