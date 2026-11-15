// Test data for the viewer class recipes (M23 T1): the colours behind viewer-classes.ts as plain
// data, so tests/m23-viewer-classes.test.ts can recompute every contrast pair. Never imported by app
// code (the test checks) — keeping it out of viewer-classes.ts keeps it out of the viewer's client
// bundle. The hexes must mirror the literal classes in viewer-classes.ts (tested).

/** Emerald leather's lightest point (glow over the #0e3b2e base) — the worst case for text on it. */
export const VW_LEATHER_LIGHTEST = "#1f5443";

/** Foil fill's darkest stop (home-foil-fill) — the worst case for ink on gold. */
export const VW_FOIL_DARKEST = "#bf9a23";

/** Stage vignette's darkest edge (VW_STAGE / VW_NAV_BAR). */
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
  { name: "stage label muted on stage edge", fg: "#56625a", bg: VW_STAGE_EDGE, min: 4.5 },
  { name: "stage label muted on stage base", fg: "#56625a", bg: "#f4ede0", min: 4.5 },
  { name: "nav button emerald on white", fg: "#0e3b2e", bg: "#ffffff", min: 4.5 },
  { name: "nav button emerald on hover mint", fg: "#0e3b2e", bg: "#e6efe9", min: 4.5 },
  { name: "counter emerald on white", fg: "#0e3b2e", bg: "#ffffff", min: 4.5 },
  { name: "chapter pill emerald on mint", fg: "#0e3b2e", bg: "#e6efe9", min: 4.5 },
  { name: "card ink on white", fg: "#1b1b1d", bg: "#ffffff", min: 4.5 },
  { name: "sheet ink on ivory", fg: "#1b1b1d", bg: "#faf5ec", min: 4.5 },
  { name: "sheet title emerald on ivory", fg: "#0e3b2e", bg: "#faf5ec", min: 4.5 },
  { name: "close button emerald on ivory", fg: "#0e3b2e", bg: "#faf5ec", min: 4.5 },
  { name: "list row ink on hover", fg: "#1b1b1d", bg: "#efe7d8", min: 4.5 },
  { name: "list row active emerald on mint", fg: "#0e3b2e", bg: "#e6efe9", min: 4.5 },
  { name: "list row active emerald on hover", fg: "#0e3b2e", bg: "#dbe8e0", min: 4.5 },
  { name: "muted ink-soft on ivory", fg: "#4a4740", bg: "#faf5ec", min: 4.5 },
  { name: "muted ink-soft on white", fg: "#4a4740", bg: "#ffffff", min: 4.5 },
  { name: "gold CTA ink on foil darkest stop", fg: "#1b1b1d", bg: VW_FOIL_DARKEST, min: 4.5 },
  { name: "emerald CTA white on emerald", fg: "#ffffff", bg: "#0e3b2e", min: 4.5 },
  { name: "emerald CTA white on hover", fg: "#ffffff", bg: "#145240", min: 4.5 },
  { name: "emerald outline on ivory", fg: "#0e3b2e", bg: "#faf5ec", min: 4.5 },
  { name: "emerald outline on hover mint", fg: "#0e3b2e", bg: "#e6efe9", min: 4.5 },
  { name: "WhatsApp white on #0F7A40", fg: "#ffffff", bg: "#0F7A40", min: 4.5 },
  { name: "WhatsApp white on hover", fg: "#ffffff", bg: "#0c6634", min: 4.5 },
  { name: "message eyebrow antique gold on ivory", fg: "#7a5f0e", bg: "#faf5ec", min: 4.5 },
  { name: "message heading emerald on ivory", fg: "#0e3b2e", bg: "#faf5ec", min: 4.5 },
  { name: "message body ink-soft on ivory", fg: "#4a4740", bg: "#faf5ec", min: 4.5 },
  { name: "message card ink on ivory", fg: "#1b1b1d", bg: "#faf5ec", min: 4.5 },
];
