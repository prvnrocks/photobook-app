// The app palette (M11 D-067 tokens; M17 emerald & gold values) as data, for the /dev-style board and the contrast test. The live
// values are the CSS custom properties in src/app/globals.css (:root); tests/app-palette.test.ts
// fails if the two drift. Pure: safe on client and server.

export type PaletteToken = {
  /** CSS custom property name without the leading "--". */
  token: string;
  hex: string;
  role: string;
};

export const PALETTE: readonly PaletteToken[] = [
  { token: "background", hex: "#faf6ee", role: "Ivory: page background" },
  { token: "card", hex: "#ffffff", role: "Card, sheet, menu" },
  // --foreground stays oklch(0.145 0 0) (book text inherits it); this is its sRGB value.
  { token: "foreground", hex: "#0a0a0a", role: "Ink: body text (unchanged)" },
  { token: "heading", hex: "#0e3b2e", role: "Deep emerald: page titles, wordmark" },
  { token: "primary", hex: "#0e3b2e", role: "Deep emerald: primary buttons, selected, done steps" },
  { token: "primary-foreground", hex: "#faf6ee", role: "Text on deep emerald" },
  { token: "accent-strong", hex: "#c9a227", role: "Gold: one CTA, current step, hairlines" },
  { token: "accent-strong-foreground", hex: "#1b1b1d", role: "Ink text on gold" },
  { token: "accent-text", hex: "#7a5f0e", role: "Antique gold: eyebrows, small gold icons" },
  { token: "secondary", hex: "#f1eadb", role: "Cream: secondary button, hover" },
  { token: "secondary-foreground", hex: "#0e3b2e", role: "Text on cream" },
  { token: "muted", hex: "#f2ece0", role: "Cream stone surface, skeleton" },
  { token: "muted-foreground", hex: "#56625a", role: "Grey-green: secondary text" },
  { token: "border", hex: "#e5dccb", role: "Dividers, card edges" },
  { token: "input", hex: "#7c857a", role: "Form field borders" },
  { token: "ring", hex: "#1f6f54", role: "Emerald: focus ring" },
  { token: "destructive", hex: "#b42318", role: "Errors, delete" },
  { token: "destructive-soft", hex: "#fbedeb", role: "Error notice" },
  { token: "info", hex: "#2f5a78", role: "Info icon" },
  { token: "info-soft", hex: "#edf3f5", role: "Info notice" },
  { token: "success", hex: "#1f6f54", role: "Emerald: success icon" },
  { token: "success-soft", hex: "#ebf4ee", role: "Success notice" },
  { token: "warning", hex: "#8a5a12", role: "Amber: warning icon" },
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
  { fg: "foreground", bg: "background", min: 4.5, use: "Body text on ivory" },
  { fg: "foreground", bg: "card", min: 4.5, use: "Body text on card" },
  { fg: "heading", bg: "background", min: 4.5, use: "Page title on ivory" },
  { fg: "heading", bg: "card", min: 4.5, use: "Heading on card" },
  { fg: "muted-foreground", bg: "background", min: 4.5, use: "Secondary text on ivory" },
  { fg: "muted-foreground", bg: "muted", min: 4.5, use: "Secondary text on stone" },
  { fg: "muted-foreground", bg: "secondary", min: 4.5, use: "Secondary text on cream" },
  { fg: "muted-foreground", bg: "card", min: 4.5, use: "Secondary text on card" },
  { fg: "primary-foreground", bg: "primary", min: 4.5, use: "Primary button" },
  { fg: "accent-strong-foreground", bg: "accent-strong", min: 4.5, use: "Gold CTA (ink on gold)" },
  { fg: "accent-strong", bg: "primary", min: 3, use: "Gold marker on deep emerald (active tool)" },
  { fg: "accent-text", bg: "background", min: 4.5, use: "Eyebrow on ivory" },
  { fg: "accent-text", bg: "card", min: 4.5, use: "Eyebrow on card" },
  { fg: "accent-text", bg: "secondary", min: 3, use: "Gold icon on cream" },
  { fg: "primary", bg: "secondary", min: 4.5, use: "Secondary button" },
  { fg: "primary", bg: "background", min: 4.5, use: "Link on ivory" },
  { fg: "destructive", bg: "background", min: 4.5, use: "Error text on ivory" },
  { fg: "destructive", bg: "card", min: 4.5, use: "Error text on card" },
  { fg: "foreground", bg: "destructive-soft", min: 4.5, use: "Error notice text" },
  { fg: "foreground", bg: "warning-soft", min: 4.5, use: "Warning notice text" },
  { fg: "foreground", bg: "success-soft", min: 4.5, use: "Success notice text" },
  { fg: "foreground", bg: "info-soft", min: 4.5, use: "Info notice text" },
  { fg: "warning", bg: "warning-soft", min: 4.5, use: "Warning chip text / icon" },
  { fg: "success", bg: "success-soft", min: 4.5, use: "Success chip text / icon" },
  { fg: "info", bg: "info-soft", min: 3, use: "Info icon" },
  { fg: "input", bg: "background", min: 3, use: "Field border on ivory" },
  { fg: "input", bg: "card", min: 3, use: "Field border on card" },
  { fg: "ring", bg: "background", min: 3, use: "Focus ring on ivory" },
  { fg: "ring", bg: "card", min: 3, use: "Focus ring on card" },
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
