// Test data for the viewer class recipes (M23 T1): the colours behind viewer-classes.ts as plain
// data, so tests/m23-viewer-classes.test.ts can recompute every contrast pair. Never imported by app
// code (the test checks) — keeping it out of viewer-classes.ts keeps it out of the viewer's client
// bundle. The hexes must mirror the literal classes in viewer-classes.ts (tested).

/** Emerald leather's lightest point (glow over the #0e3b2e base) — the worst case for text on it. */
export const VW_LEATHER_LIGHTEST = "#1f5443";

/** Foil fill's darkest stop (home-foil-fill) — the worst case for ink on gold. */
export const VW_FOIL_DARKEST = "#bf9a23";

/** Stage vignette's darkest edge (VW_STAGE / VW_NAV_BAR / VW_SHELL_BG — no text sits on it directly). */
export const VW_STAGE_EDGE = "#ebe2d0";

export type VwContrastPair = { name: string; fg: string; bg: string; min: number };

/** Every text/background pair the viewer recipes rely on (each recomputed ≥ min ≥ 4.5 in tests). */
export const VW_CONTRAST_PAIRS: readonly VwContrastPair[] = [
  { name: "band title cream on leather lightest", fg: "#f2e8d8", bg: VW_LEATHER_LIGHTEST, min: 4.5 },
  { name: "band subline pale gold on leather lightest", fg: "#e3c766", bg: VW_LEATHER_LIGHTEST, min: 4.5 },
  { name: "band icon button cream on leather lightest", fg: "#f2e8d8", bg: VW_LEATHER_LIGHTEST, min: 4.5 },
  { name: "footer muted cream on leather lightest", fg: "#d7cdb9", bg: VW_LEATHER_LIGHTEST, min: 4.5 },
  { name: "footer strong cream on leather lightest", fg: "#f2e8d8", bg: VW_LEATHER_LIGHTEST, min: 4.5 },
  { name: "float button cream on emerald", fg: "#f2e8d8", bg: "#0e3b2e", min: 4.5 },
  { name: "nav button emerald on white", fg: "#0e3b2e", bg: "#ffffff", min: 4.5 },
  { name: "nav button emerald on hover mint", fg: "#0e3b2e", bg: "#e6efe9", min: 4.5 },
  { name: "counter emerald on white", fg: "#0e3b2e", bg: "#ffffff", min: 4.5 },
  { name: "sheet ink on ivory", fg: "#1b1b1d", bg: "#faf5ec", min: 4.5 },
  { name: "sheet title emerald on ivory", fg: "#0e3b2e", bg: "#faf5ec", min: 4.5 },
  { name: "close button emerald on ivory", fg: "#0e3b2e", bg: "#faf5ec", min: 4.5 },
  { name: "list row ink on hover", fg: "#1b1b1d", bg: "#efe7d8", min: 4.5 },
  { name: "list row active emerald on mint", fg: "#0e3b2e", bg: "#e6efe9", min: 4.5 },
  { name: "list row active emerald on hover", fg: "#0e3b2e", bg: "#dbe8e0", min: 4.5 },
  { name: "muted ink-soft on ivory", fg: "#4a4740", bg: "#faf5ec", min: 4.5 },
  { name: "muted ink-soft on white", fg: "#4a4740", bg: "#ffffff", min: 4.5 },
  { name: "gold CTA ink on foil darkest stop", fg: "#1b1b1d", bg: VW_FOIL_DARKEST, min: 4.5 },
  { name: "paid end Share white on emerald", fg: "#ffffff", bg: "#0e3b2e", min: 4.5 },
  { name: "paid end Share white on hover", fg: "#ffffff", bg: "#145240", min: 4.5 },
  { name: "emerald outline on ivory", fg: "#0e3b2e", bg: "#faf5ec", min: 4.5 },
  { name: "emerald outline on hover mint", fg: "#0e3b2e", bg: "#e6efe9", min: 4.5 },
  { name: "WhatsApp white on #0F7A40", fg: "#ffffff", bg: "#0F7A40", min: 4.5 },
  { name: "WhatsApp white on hover", fg: "#ffffff", bg: "#0c6634", min: 4.5 },
  { name: "message eyebrow antique gold on ivory", fg: "#7a5f0e", bg: "#faf5ec", min: 4.5 },
  { name: "message heading emerald on ivory", fg: "#0e3b2e", bg: "#faf5ec", min: 4.5 },
  { name: "message body ink-soft on ivory", fg: "#4a4740", bg: "#faf5ec", min: 4.5 },
  { name: "message card ink on ivory", fg: "#1b1b1d", bg: "#faf5ec", min: 4.5 },
  { name: "message seal pale gold on emerald", fg: "#e3c766", bg: "#0e3b2e", min: 4.5 },
  { name: "message brand link cream on leather lightest", fg: "#f2e8d8", bg: VW_LEATHER_LIGHTEST, min: 4.5 },
  { name: "field label ink on ivory", fg: "#1b1b1d", bg: "#faf5ec", min: 4.5 },
  { name: "password input ink on white", fg: "#1b1b1d", bg: "#ffffff", min: 4.5 },
  { name: "field error red on ivory", fg: "#b42318", bg: "#faf5ec", min: 4.5 },
  { name: "share toast white on emerald", fg: "#ffffff", bg: "#0e3b2e", min: 4.5 },
  { name: "free end eyebrow antique gold on ivory", fg: "#7a5f0e", bg: "#faf5ec", min: 4.5 },
  { name: "free end gold CTA ink on foil darkest stop", fg: "#1b1b1d", bg: VW_FOIL_DARKEST, min: 4.5 },
];

/**
 * Non-text boundaries the recipes rely on (WCAG 1.4.11, ≥ 3:1). The skeleton page (VW_SKELETON_PAGE)
 * and the shell fill (VW_SHELL_BG) are decorative surfaces with no text and no required contrast.
 */
export const VW_NONTEXT_PAIRS: readonly VwContrastPair[] = [
  { name: "password input hairline on white", fg: "#8c8270", bg: "#ffffff", min: 3 },
  { name: "password input invalid border on white", fg: "#b42318", bg: "#ffffff", min: 3 },
];
