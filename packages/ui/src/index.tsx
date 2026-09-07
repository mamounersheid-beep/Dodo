import type { CSSProperties, ReactNode } from "react";

const tokens = {
  colorText: "#1a1a1a",
  colorMuted: "#5c5c5c",
  colorBg: "#f7f5f2",
  colorAccent: "#0f3d2e",
  fontSans: '"IBM Plex Sans", system-ui, sans-serif',
} as const;

export { tokens };

export function Price(props: { amount: string; currency?: string }) {
  const style: CSSProperties = {
    fontFamily: tokens.fontSans,
    fontWeight: 600,
    color: tokens.colorText,
  };
  return (
    <span style={style}>
      {props.amount} {props.currency ?? "€"}
    </span>
  );
}

export function EmptyState(props: { title: string; children?: ReactNode }) {
  return (
    <div style={{ fontFamily: tokens.fontSans, color: tokens.colorMuted }}>
      <strong style={{ color: tokens.colorText }}>{props.title}</strong>
      {props.children}
    </div>
  );
}
