// Pure data + helpers for the wizard upload stage (M20 T5, D-072). No React, no DOM: the slot table,
// stable slot assignment, burst dots and the derived stage state are unit-tested in node.
//
// Coordinates are % of the stage box (aspect 5 / 4): an "incoming" card hovers at the top centre
// (the file being uploaded) and an open book fills y 24–100 %. Each landed thumbnail sits in one of
// THUMB_SLOTS (top-left corner + rotation); `fx`/`fy` are the start offsets of its fly-in, in % of the
// thumbnail's own size (CSS translate %), so it appears to leave the incoming card.

/** Thumbnails animated on the book at once (older ones collapse into the "+N" pile). */
export const STAGE_MAX_THUMBS = 12;
/** No progress for this long (and not paused) → the calm "taking longer" notice. */
export const STALL_MS = 20_000;
/** Success burst length before onSettled fires (0 when the user prefers reduced motion). */
export const SETTLE_MS = 1400;

/** Stage box aspect = width / height. */
const STAGE_ASPECT = 5 / 4;
/** Thumbnail width in % of the stage width; photos are 4:3. */
export const THUMB_W = 17;
/** Thumbnail height in % of the stage height. */
export const THUMB_H = THUMB_W * 0.75 * STAGE_ASPECT;
/** Centre of the incoming card (% of the stage box). */
const INCOMING = { x: 50, y: 11 };

export type ThumbSlot = { left: number; top: number; rot: number; fx: number; fy: number };

// Centres (% of stage) + tilt, in fill order: left page top → bottom, then right page.
const CENTRES: readonly (readonly [number, number, number])[] = [
  [16, 38, -6],
  [37, 40, 4],
  [15, 61, 3],
  [36, 62, -4],
  [17, 84, -3],
  [38, 83, 6],
  [62, 39, 5],
  [84, 38, -4],
  [63, 61, -3],
  [85, 62, 4],
  [62, 84, 3],
  [83, 83, -6],
];

const round = (n: number) => Math.round(n * 100) / 100;

export const THUMB_SLOTS: readonly ThumbSlot[] = CENTRES.map(([x, y, rot]) => ({
  left: round(x - THUMB_W / 2),
  top: round(y - THUMB_H / 2),
  rot,
  fx: round(((INCOMING.x - x) / THUMB_W) * 100),
  fy: round(((INCOMING.y - y) / THUMB_H) * 100),
}));

/**
 * Stable slots: keys still shown keep their slot (a thumbnail never jumps when an older one leaves);
 * new keys take the lowest free slot in fill order, so the newest reuses the slot of the one evicted.
 */
export function assignSlots(
  prev: ReadonlyMap<number, number>,
  keys: readonly number[],
  max: number = STAGE_MAX_THUMBS,
): Map<number, number> {
  const next = new Map<number, number>();
  const used = new Set<number>();
  for (const k of keys) {
    const s = prev.get(k);
    if (s !== undefined && s < max && !used.has(s)) {
      next.set(k, s);
      used.add(s);
    }
  }
  let free = 0;
  for (const k of keys) {
    if (next.has(k)) continue;
    while (used.has(free)) free++;
    if (free >= max) break;
    next.set(k, free);
    used.add(free);
  }
  return next;
}

export type StageState = "running" | "paused" | "settled";

export type StageProgress = { done: number; total: number; uploaded: number };

/** Settled = every picked file reached a final state (or the caller says so). */
export function stageState(p: StageProgress, paused: boolean, settled?: boolean): StageState {
  if (settled ?? (p.total > 0 && p.done >= p.total)) return "settled";
  return paused ? "paused" : "running";
}

/** Photos uploaded beyond the animated ones ("+N" pile). */
export function pileCount(uploaded: number, max: number = STAGE_MAX_THUMBS): number {
  return Math.max(0, uploaded - max);
}

export function stagePercent(p: StageProgress): number {
  return p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
}

export type BurstDot = { dx: number; dy: number; size: number; color: string; delay: number };

const BURST_COLORS = ["#c9a227", "#1f7a55", "#e3c766", "#7fd6a6"] as const;

/** Deterministic confetti-like dots around the book's centre (px offsets). */
export function burstDots(n = 18): BurstDot[] {
  return Array.from({ length: n }, (_, i) => {
    const angle = (i / n) * Math.PI * 2 + (i % 3) * 0.17;
    const dist = 110 + ((i * 37) % 70);
    return {
      dx: Math.round(Math.cos(angle) * dist),
      dy: Math.round(Math.sin(angle) * dist * 0.8),
      size: 6 + ((i * 5) % 5),
      color: BURST_COLORS[i % BURST_COLORS.length],
      delay: (i % 4) * 40,
    };
  });
}

/**
 * Suggested class for Uploader's wizard pick button when it renders <UploadPickArt /> (T6 wires it;
 * keeps `group` so the art reacts to data-drag="over", min-h-56 and a 44 px+ target).
 */
export const UPLOAD_PICK_WIZARD_CLASS =
  "group flex min-h-56 w-full flex-col items-center justify-center rounded-2xl border border-border bg-card px-4 py-6 text-center shadow-card outline-none transition-colors hover:bg-secondary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[drag=over]:bg-secondary sm:px-6 sm:py-8";
