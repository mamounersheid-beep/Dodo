/** Parse durations like 15m, 7d into milliseconds — no env side effects. */
export function durationToMs(raw: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(raw.trim());
  if (!m) throw new Error(`Invalid duration: ${raw}`);
  const n = Number(m[1]);
  const unit = m[2] as "ms" | "s" | "m" | "h" | "d";
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return n * mult;
}
