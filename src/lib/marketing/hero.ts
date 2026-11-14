// Home hero (M15 structure, M16 "Emerald & gold" palette). Pure data — safe in client and server code; the hero
// components only map these values to styles (no layout maths in components).

/**
 * The book that bursts out of the hero. Swap `src`/`w`/`h` for a real product photo when one exists
 * (transparent PNG or a cut-out WebP works best; keep the natural pixel size here).
 */
export const HERO_BOOK = {
  src: "/home/books/08-the-day-we-said-yes-cover.png",
  w: 362,
  h: 419,
  alt: "A printed photobook titled “The Day We Said Yes” with a wedding photo on the cover",
} as const;

/**
 * Gold-foil flecks (M16, replaces the M15 paper confetti): a few tiny slivers that drift very slowly,
 * like leaf caught in the light. Static under prefers-reduced-motion (home-fleck in globals.css).
 */
export interface FoilFleck {
  /** Position of the fleck's top-left corner: % of the hero box ("back") or of the book box ("front"). */
  x: number;
  y: number;
  /** Size in px at scale 1. */
  w: number;
  h: number;
  /** Resting rotation (deg). */
  rot: number;
  /** Drift loop length + start offset (s). Long loops so it reads as shimmer, not motion. */
  dur: number;
  delay: number;
  /** "front" flecks sit over the book's edge for depth; "back" flecks sit behind everything. */
  layer: "back" | "front";
  /** Hidden below the md breakpoint (keeps the phone hero calm and the text clear). */
  desktopOnly?: boolean;
}

export const FOIL_FLECKS: readonly FoilFleck[] = [
  { x: 6, y: 30, w: 5, h: 9, rot: 24, dur: 26, delay: -4, layer: "back" },
  { x: 22, y: 14, w: 4, h: 4, rot: 45, dur: 30, delay: -12, layer: "back", desktopOnly: true },
  { x: 88, y: 12, w: 6, h: 10, rot: -18, dur: 28, delay: -8, layer: "back" },
  { x: 90, y: 38, w: 4, h: 4, rot: 45, dur: 24, delay: -16, layer: "back", desktopOnly: true },
  { x: 7, y: 50, w: 4, h: 7, rot: -30, dur: 32, delay: -2, layer: "back", desktopOnly: true },
  { x: 27, y: 74, w: 5, h: 5, rot: 45, dur: 27, delay: -20, layer: "back", desktopOnly: true },
  { x: 62, y: 60, w: 4, h: 8, rot: 12, dur: 29, delay: -10, layer: "back", desktopOnly: true },
  // front flecks are positioned in % of the book box (just off its edges, never over the cover title)
  { x: 101, y: 46, w: 5, h: 9, rot: -22, dur: 25, delay: -6, layer: "front" },
  { x: -7, y: 72, w: 4, h: 4, rot: 45, dur: 31, delay: -14, layer: "front", desktopOnly: true },
];
