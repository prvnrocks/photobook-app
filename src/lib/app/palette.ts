// The M11 app palette (D-067) as data, for the /dev-style board and the contrast test. The live
// values are the CSS custom properties in src/app/globals.css (:root); tests/app-palette.test.ts
// fails if the two drift. Pure: safe on client and server.

export type PaletteToken = {
  /** CSS custom property name without the leading "--". */
  token: string;
  hex: string;
  role: string;
};

export const PALETTE: readonly PaletteToken[] = [
  { token: "background", hex: "#fbf8f2", role: "Paper: page background" },
  { token: "card", hex: "#ffffff", role: "Card, sheet, menu" },
  // --foreground stays oklch(0.145 0 0) (book text inherits it); this is its sRGB value.
  { token: "foreground", hex: "#0a0a0a", role: "Ink: body text (unchanged)" },
  { token: "primary", hex: "#1e2a47", role: "Navy: primary buttons, done steps" },
  { token: "primary-foreground", hex: "#fbf8f2", role: "Text on navy" },
  { token: "accent-strong", hex: "#a65a3f", role: "Terracotta: one CTA, eyebrows, focus ring" },
  { token: "accent-strong-foreground", hex: "#ffffff", role: "Text on terracotta" },
  { token: "secondary", hex: "#f1ebe1", role: "Secondary button, hover" },
  { token: "muted", hex: "#f3eee6", role: "Warm stone surface, skeleton" },
  { token: "muted-foreground", hex: "#6b6257", role: "Secondary text" },
  { token: "border", hex: "#e6ded1", role: "Dividers, card edges" },
  { token: "input", hex: "#8c8172", role: "Form field borders" },
  { token: "ring", hex: "#a65a3f", role: "Focus ring" },
  { token: "destructive", hex: "#b42318", role: "Errors, delete" },
  { token: "destructive-soft", hex: "#fbedeb", role: "Error notice" },
  { token: "info", hex: "#2b4c8c", role: "Info icon" },
  { token: "info-soft", hex: "#eef2f8", role: "Info notice" },
  { token: "success", hex: "#1e6b45", role: "Success icon" },
  { token: "success-soft", hex: "#edf5ef", role: "Success notice" },
  { token: "warning", hex: "#8a5a12", role: "Warning icon" },
  { token: "warning-soft", hex: "#fbf2e2", role: "Warning notice" },
];

export const paletteHex = (token: string): string => {
  const t = PALETTE.find((p) => p.token === token);
  if (!t) throw new Error(`unknown palette token ${token}`);
  return t.hex;
};

/** Text pairs need 4.5:1 (AA); UI parts (borders, focus, icons) need 3:1. */
export type ContrastPair = { fg: string; bg: string; min: 4.5 | 3; use: string };

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: "foreground", bg: "background", min: 4.5, use: "Body text on paper" },
  { fg: "muted-foreground", bg: "background", min: 4.5, use: "Secondary text on paper" },
  { fg: "muted-foreground", bg: "muted", min: 4.5, use: "Secondary text on stone" },
  { fg: "muted-foreground", bg: "card", min: 4.5, use: "Secondary text on card" },
  { fg: "primary-foreground", bg: "primary", min: 4.5, use: "Primary button" },
  { fg: "accent-strong-foreground", bg: "accent-strong", min: 4.5, use: "Accent button" },
  { fg: "accent-strong", bg: "background", min: 4.5, use: "Eyebrow on paper" },
  { fg: "primary", bg: "secondary", min: 4.5, use: "Secondary button" },
  { fg: "destructive", bg: "background", min: 4.5, use: "Error text on paper" },
  { fg: "foreground", bg: "destructive-soft", min: 4.5, use: "Error notice text" },
  { fg: "foreground", bg: "warning-soft", min: 4.5, use: "Warning notice text" },
  { fg: "warning", bg: "warning-soft", min: 3, use: "Warning icon" },
  { fg: "success", bg: "success-soft", min: 3, use: "Success icon" },
  { fg: "info", bg: "info-soft", min: 3, use: "Info icon" },
  { fg: "input", bg: "background", min: 3, use: "Field border on paper" },
  { fg: "ring", bg: "background", min: 3, use: "Focus ring on paper" },
];

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2.x contrast ratio of two #rrggbb colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
