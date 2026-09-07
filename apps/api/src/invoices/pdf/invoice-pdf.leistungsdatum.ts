/**
 * Leistungsdatum as-of Invoice.issuedAt (10.11 §7 + content authority).
 * Precedence: deliveredAt → shippedAt → confirmedAt → placedAt.
 * Only timestamps ≤ issuedAt may win (post-issue fulfillment must not alter PDF).
 */

export type LeistungsdatumSources = {
  issuedAt: Date;
  placedAt: Date;
  confirmedAt: Date | null;
  /** Order.deliveredAt */
  orderDeliveredAt: Date | null;
  /** Shipment.shippedAt values for the order */
  shipmentShippedAts: Array<Date | null | undefined>;
};

function atOrBefore(ts: Date | null | undefined, issuedAt: Date): Date | null {
  if (!ts) return null;
  return ts.getTime() <= issuedAt.getTime() ? ts : null;
}

function earliest(
  dates: Array<Date | null | undefined>,
  issuedAt: Date,
): Date | null {
  let best: Date | null = null;
  for (const d of dates) {
    const ok = atOrBefore(d, issuedAt);
    if (!ok) continue;
    if (!best || ok.getTime() < best.getTime()) best = ok;
  }
  return best;
}

export function resolveLeistungsdatumAsOfIssuedAt(
  sources: LeistungsdatumSources,
): Date {
  const { issuedAt } = sources;
  const delivered = atOrBefore(sources.orderDeliveredAt, issuedAt);
  if (delivered) return delivered;

  const shipped = earliest(sources.shipmentShippedAts, issuedAt);
  if (shipped) return shipped;

  const confirmed = atOrBefore(sources.confirmedAt, issuedAt);
  if (confirmed) return confirmed;

  return sources.placedAt;
}
