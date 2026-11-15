// Test data for the editor class recipes (M22 review N3): the colours behind editor-classes.ts as
// plain data, so tests/m22-editor-classes.test.ts can recompute every contrast pair. Never imported by
// app code (the test checks) — keeping it out of editor-classes.ts keeps it out of the editor's
// client bundle. The hexes must mirror the literal classes in editor-classes.ts (tested).
import type { EdChipTone } from "./editor-classes";

/** Emerald leather's lightest point (glow over the #0e3b2e base) — the worst case for text on it. */
export const ED_LEATHER_LIGHTEST = "#1f5443";

export const ED_CHIP_TONES_LIST: readonly EdChipTone[] = ["saved", "saving", "warn"];

/**
 * Chip colours (ED_CHIP_TONE / ED_CHIP_DOT). Each chip has a solid background; the text also clears
 * 4.5:1 on the leather's lightest point should the background ever be dropped.
 *   saved  #9ee6bd on #0f3a2d 8.72  (on #1f5443 6.03)
 *   saving #d7cdb9 on #143f33 7.45  (on #1f5443 5.53)
 *   warn   #f3c969 on #2f2a14 9.14  (on #1f5443 5.55)
 */
export const ED_CHIP_COLORS: Record<EdChipTone, { text: string; bg: string; dot: string }> = {
  saved: { text: "#9ee6bd", bg: "#0f3a2d", dot: "#7fd6a6" },
  saving: { text: "#d7cdb9", bg: "#143f33", dot: "#9fb3a6" },
  warn: { text: "#f3c969", bg: "#2f2a14", dot: "#f3c969" },
};

export type EdContrastPair = { name: string; fg: string; bg: string; min: number };

/** Every text/background pair the editor recipes rely on (each recomputed ≥ min ≥ 4.5 in tests). */
export const ED_CONTRAST_PAIRS: readonly EdContrastPair[] = [
  { name: "band title cream on leather lightest", fg: "#f2e8d8", bg: ED_LEATHER_LIGHTEST, min: 4.5 },
  { name: "band muted cream on leather lightest", fg: "#d7cdb9", bg: ED_LEATHER_LIGHTEST, min: 4.5 },
  { name: "band eyebrow pale gold on leather lightest", fg: "#e3c766", bg: ED_LEATHER_LIGHTEST, min: 4.5 },
  { name: "band icon button cream on leather lightest", fg: "#f2e8d8", bg: ED_LEATHER_LIGHTEST, min: 4.5 },
  ...ED_CHIP_TONES_LIST.flatMap((tone) => [
    { name: `chip ${tone} text on chip`, fg: ED_CHIP_COLORS[tone].text, bg: ED_CHIP_COLORS[tone].bg, min: 4.5 },
    { name: `chip ${tone} text on leather lightest`, fg: ED_CHIP_COLORS[tone].text, bg: ED_LEATHER_LIGHTEST, min: 4.5 },
  ]),
  { name: "pill idle emerald on white", fg: "#0e3b2e", bg: "#ffffff", min: 4.5 },
  { name: "pill idle emerald on hover", fg: "#0e3b2e", bg: "#e6efe9", min: 4.5 },
  { name: "pill active cream on emerald", fg: "#f2e8d8", bg: "#0e3b2e", min: 4.5 },
  { name: "pill active cream on hover emerald", fg: "#f2e8d8", bg: "#145240", min: 4.5 },
  { name: "share gold ink on foil darkest stop", fg: "#1b1b1d", bg: "#bf9a23", min: 4.5 },
  { name: "emerald CTA white on emerald", fg: "#ffffff", bg: "#0e3b2e", min: 4.5 },
  { name: "emerald CTA white on hover", fg: "#ffffff", bg: "#145240", min: 4.5 },
  { name: "quiet CTA emerald on ivory", fg: "#0e3b2e", bg: "#faf6ee", min: 4.5 },
  { name: "danger quiet on white", fg: "#b42318", bg: "#ffffff", min: 4.5 },
  { name: "danger quiet on ivory", fg: "#b42318", bg: "#faf6ee", min: 4.5 },
  { name: "panel eyebrow accent-text on white", fg: "#7a5f0e", bg: "#ffffff", min: 4.5 },
  { name: "stage label muted on stage edge", fg: "#56625a", bg: "#ebe2d0", min: 4.5 },
  { name: "stage label muted on stage base", fg: "#56625a", bg: "#f4ede0", min: 4.5 },
];
