// Tool-panel class recipes (M22, D-074): the inside of the editor's card panels — fields (caption,
// cover title, chapter), options (font / alignment / AI choices, page actions), tiles (layout,
// background, photo pickers) and segmented controls. The panel shell itself (sheet / side card and its
// heading) comes from EditorToolbar (ED_SHEET / ED_PANEL_HEADING). T6a's tool-tile-classes.ts was
// merged in here (M22 review N1).
// Plain strings, no imports (same rules as editor-classes.ts; join with cx from @/lib/cx): 44 px
// targets, no transforms, transitions with motion-reduce:transition-none, no gold (Share is the
// screen's only gold). Contrast: emerald #0e3b2e on white 12.47:1, muted #56625a on #faf6ee ≥ 5:1,
// cream on emerald 10.28:1.
// Idle / active pairs (TOOL_OPTION / TOOL_OPTION_ACTIVE, TOOL_TILE / TOOL_TILE_ACTIVE, SEG / SEG_ACTIVE…)
// are complete alternatives — use one OR the other; cx doesn't merge conflicting utilities.
// Selected = emerald ring (ring / box-shadow); keyboard focus on every option / tile / segment = an
// outline, so the two never fight over the same utility.

// ---- Fields --------------------------------------------------------------------------------------

/** Field label above an input: emerald 12.47:1 on white. */
export const TOOL_LABEL = "text-sm font-semibold text-[#0e3b2e]";

/** Small helper / count line under a field. */
export const TOOL_HINT = "text-xs text-muted-foreground";

/**
 * Text input / textarea: white field, warm hairline, emerald focus ring (border + 2 px ring).
 * Keep dir="auto" + lang on every caption-like field; caption fields add the font chain inline.
 */
export const TOOL_INPUT =
  "w-full rounded-xl border border-[#d9ceb8] bg-white px-3 py-2 text-base text-foreground shadow-[inset_0_1px_2px_rgb(14_59_46/0.06)] transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground hover:border-[#bfb299] focus-visible:border-[#0e3b2e] focus-visible:ring-2 focus-visible:ring-[#0e3b2e]/30 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/**
 * Ivory inset card surface without padding — add your own (p-4…) when TOOL_WELL's p-3 doesn't fit
 * (cx doesn't merge conflicting padding utilities).
 */
export const TOOL_WELL_SURFACE = "rounded-2xl border border-[#e9dfca] bg-[#faf6ee]";

/** Ivory inset card inside a panel (a suggestion, a notice, a section): TOOL_WELL_SURFACE + p-3. */
export const TOOL_WELL = `${TOOL_WELL_SURFACE} p-3`;

// ---- Options -------------------------------------------------------------------------------------

/** Secondary action: outlined emerald pill on white / ivory (emerald 11.57:1 on #faf6ee), 44 px. */
export const TOOL_SECONDARY =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-[#0e3b2e]/25 bg-white px-4 text-sm font-semibold text-[#0e3b2e] transition-colors outline-none hover:border-[#0e3b2e]/50 hover:bg-[#f3f7f4] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-[#0e3b2e]/25 disabled:hover:bg-white motion-reduce:transition-none";

/** Choice tile (font, alignment, AI option) — idle. Use TOOL_OPTION_ACTIVE instead when chosen. */
export const TOOL_OPTION =
  "rounded-2xl border border-[#e2d8c4] bg-white text-[#0e3b2e] transition-[background-color,border-color,box-shadow] outline-none hover:border-[#0e3b2e]/40 hover:bg-[#f3f7f4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-[#e2d8c4] disabled:hover:bg-white motion-reduce:transition-none";

/** Choice tile — chosen: emerald ring on pale emerald (emerald 11.0:1 on #e6efe9). Focus = outline. */
export const TOOL_OPTION_ACTIVE =
  "rounded-2xl border border-[#0e3b2e] bg-[#e6efe9] text-[#0e3b2e] shadow-[0_6px_14px_-10px_rgb(14_59_46/0.8)] ring-1 ring-[#0e3b2e] transition-[background-color,border-color,box-shadow] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none";

/** Round 44 px icon button on white (page move earlier / later). */
export const TOOL_ICON_BTN =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-[#0e3b2e] transition-colors outline-none hover:bg-[#e6efe9] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent motion-reduce:transition-none";

/** "AI suggestion" marker (as the review step's "Written by AI"): accent-text #7a5f0e 6.07:1 on white. */
export const TOOL_AI_MARKER = "inline-flex items-center gap-1.5 text-xs font-semibold text-accent-text";

// ---- Tiles ---------------------------------------------------------------------------------------

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

// ---- Segments ------------------------------------------------------------------------------------

/** Segmented control track (tablist / radiogroup). Add grid-cols-N. */
export const SEG_GROUP = "grid gap-1 rounded-2xl border border-[#e9dfca] bg-[#faf6ee] p-1";

/** Segment, idle. No text size / x-padding: add them per use (text-sm px-1, text-xs leading-tight…). */
export const SEG =
  "min-h-11 min-w-0 rounded-xl font-semibold text-[#56625a] transition-colors outline-none hover:bg-white hover:text-[#0e3b2e] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#56625a] motion-reduce:transition-none";

/** Segment, selected: cream on solid emerald. Same sizing rule as SEG. */
export const SEG_ACTIVE =
  "min-h-11 min-w-0 rounded-xl bg-[#0e3b2e] font-semibold text-[#f2e8d8] shadow-[0_6px_14px_-8px_rgb(14_59_46/0.9)] transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none";
