// Tool panel option recipes (M22 T6a, D-074): card tiles, photo tiles, check badge and segmented
// controls for the Layout / Background / Replace panels, in the emerald / cream language of
// editor-classes.ts. Plain strings, no imports (join with cx from @/lib/cx).
//
// Idle / active pairs are complete alternatives: use one OR the other, never both (cx doesn't
// merge). Selected = emerald ring (box-shadow) + CHECK_BADGE; keyboard focus = outline, so the two
// never fight over the same utility. No transforms (opacity / shadow / colour transitions only).
// Contrast: emerald #0e3b2e on white 12.47:1, muted #56625a on #faf6ee ≥ 5:1, cream on emerald 10.28:1.

/** Option card (layout diagram, paper texture), idle. 44 px min target. */
export const TOOL_TILE =
  "relative flex min-h-11 w-full min-w-0 flex-col items-stretch gap-1 rounded-2xl border border-[#e9dfca] bg-white p-1.5 text-start shadow-[0_6px_16px_-12px_rgb(14_59_46/0.45)] transition-[border-color,box-shadow] outline-none hover:border-[#0e3b2e]/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-[#e9dfca] motion-reduce:transition-none";

/** Option card, selected: emerald border + ring + soft glow (pair with CHECK_BADGE). */
export const TOOL_TILE_ACTIVE =
  "relative flex min-h-11 w-full min-w-0 flex-col items-stretch gap-1 rounded-2xl border border-[#0e3b2e] bg-[#f3f8f5] p-1.5 text-start shadow-[0_10px_22px_-14px_rgb(14_59_46/0.6)] ring-1 ring-[#0e3b2e] transition-[border-color,box-shadow] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none";

/** Square photo tile, idle (cream placeholder, hairline ring). */
export const TOOL_PHOTO_TILE =
  "relative block aspect-square w-full min-w-0 overflow-hidden rounded-xl bg-[#f4ede0] ring-1 ring-[#e5dccb] transition-shadow outline-none hover:ring-2 hover:ring-[#0e3b2e]/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e3b2e] disabled:cursor-not-allowed motion-reduce:transition-none";

/** Square photo tile, selected: 3 px emerald ring + glow (pair with CHECK_BADGE). */
export const TOOL_PHOTO_TILE_ACTIVE =
  "relative block aspect-square w-full min-w-0 overflow-hidden rounded-xl bg-[#f4ede0] shadow-[0_8px_18px_-10px_rgb(14_59_46/0.7)] ring-[3px] ring-[#0e3b2e] transition-shadow outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e3b2e] disabled:cursor-not-allowed motion-reduce:transition-none";

/** Round emerald check in the tile's top end corner (decorative: aria-hidden; state is on the button). */
export const CHECK_BADGE =
  "pointer-events-none absolute end-1 top-1 z-[1] flex size-5 items-center justify-center rounded-full bg-[#0e3b2e] text-white shadow-[0_2px_6px_rgb(0_0_0/0.3)] ring-2 ring-white";

/** Segmented control track (tablist / radiogroup). Add grid-cols-N. */
export const SEG_GROUP = "grid gap-1 rounded-2xl border border-[#e9dfca] bg-[#faf6ee] p-1";

/** Segment, idle. No text size / x-padding: add them per use (text-sm px-1, text-xs leading-tight…). */
export const SEG =
  "min-h-11 min-w-0 rounded-xl font-semibold text-[#56625a] transition-colors outline-none hover:bg-white hover:text-[#0e3b2e] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#56625a] motion-reduce:transition-none";

/** Segment, selected: cream on solid emerald. Same sizing rule as SEG. */
export const SEG_ACTIVE =
  "min-h-11 min-w-0 rounded-xl bg-[#0e3b2e] font-semibold text-[#f2e8d8] shadow-[0_6px_14px_-8px_rgb(14_59_46/0.9)] transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none";
