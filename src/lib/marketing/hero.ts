// Home hero, Direction A "Confetti" (M15). Pure data — safe in client and server code; the hero
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

/** Paper confetti colours: pop pink, sun, sea, paper white. */
export const CONFETTI_COLORS = {
  pop: "#ff1f84",
  sun: "#ffc93c",
  sea: "#18b8a6",
  paper: "#ffffff",
} as const;

export type ConfettiColor = keyof typeof CONFETTI_COLORS;

export interface ConfettiPiece {
  /** Position of the piece's top-left corner: % of the hero box ("back") or of the book box ("front"). */
  x: number;
  y: number;
  /** Size in px at scale 1 (strips are long, squares equal). */
  w: number;
  h: number;
  color: ConfettiColor;
  /** Resting rotation (deg). */
  rot: number;
  /** Drift loop length + start offset (s). Kept slow so it reads as "settling", not as motion. */
  dur: number;
  delay: number;
  /** "front" pieces sit over the book for depth; "back" pieces sit behind everything. */
  layer: "back" | "front";
  /** Hidden below the md breakpoint (keeps the phone hero calm and the text clear). */
  desktopOnly?: boolean;
}

export const CONFETTI: readonly ConfettiPiece[] = [
  { x: 7, y: 17, w: 10, h: 26, color: "sea", rot: 18, dur: 13, delay: -2, layer: "back" },
  { x: 17, y: 10, w: 24, h: 10, color: "pop", rot: -24, dur: 16, delay: -7, layer: "back" },
  { x: 28, y: 22, w: 12, h: 12, color: "paper", rot: 30, dur: 14, delay: -4, layer: "back", desktopOnly: true },
  { x: 41, y: 9, w: 9, h: 24, color: "sun", rot: 12, dur: 17, delay: -9, layer: "back" },
  { x: 59, y: 11, w: 24, h: 10, color: "pop", rot: 20, dur: 15, delay: -3, layer: "back", desktopOnly: true },
  { x: 71, y: 19, w: 11, h: 11, color: "sea", rot: -15, dur: 12, delay: -6, layer: "back" },
  { x: 86, y: 11, w: 10, h: 26, color: "sun", rot: -30, dur: 18, delay: -1, layer: "back" },
  { x: 93, y: 31, w: 24, h: 10, color: "paper", rot: 40, dur: 14, delay: -8, layer: "back" },
  { x: 4, y: 47, w: 24, h: 11, color: "pop", rot: -40, dur: 16, delay: -5, layer: "back" },
  { x: 11, y: 71, w: 11, h: 11, color: "sun", rot: 10, dur: 13, delay: -10, layer: "back" },
  { x: 21, y: 86, w: 10, h: 24, color: "paper", rot: -20, dur: 15, delay: -2, layer: "back" },
  { x: 31, y: 66, w: 22, h: 9, color: "sea", rot: 35, dur: 17, delay: -6, layer: "back", desktopOnly: true },
  { x: 65, y: 55, w: 9, h: 22, color: "pop", rot: -10, dur: 14, delay: -11, layer: "back", desktopOnly: true },
  { x: 95, y: 60, w: 10, h: 24, color: "sea", rot: 25, dur: 16, delay: -4, layer: "back" },
  { x: 47, y: 93, w: 22, h: 10, color: "sun", rot: -35, dur: 15, delay: -9, layer: "back", desktopOnly: true },
  // front pieces are positioned in % of the book box (they sit on top of the book, off the cover title)
  { x: -12, y: 56, w: 10, h: 24, color: "paper", rot: 30, dur: 12, delay: -3, layer: "front" },
  { x: 99, y: 30, w: 22, h: 10, color: "pop", rot: -20, dur: 14, delay: -7, layer: "front" },
  { x: 94, y: 70, w: 11, h: 11, color: "sun", rot: 15, dur: 13, delay: -5, layer: "front" },
  { x: -6, y: 84, w: 22, h: 9, color: "sea", rot: -28, dur: 15, delay: -10, layer: "front", desktopOnly: true },
];

/** Starburst sticker outline (SVG polygon points in a 100×100 box): 16 points, inner radius 41. */
export const STICKER_POINTS = Array.from({ length: 32 }, (_, i) => {
  const r = i % 2 === 0 ? 50 : 41;
  const a = (Math.PI * i) / 16 - Math.PI / 2;
  return `${(50 + r * Math.cos(a)).toFixed(2)},${(50 + r * Math.sin(a)).toFixed(2)}`;
}).join(" ");
