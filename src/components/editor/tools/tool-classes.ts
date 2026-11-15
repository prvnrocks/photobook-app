// Tool-panel class recipes (M22 T6b, D-074): the inside of the editor's card panels (caption, AI
// caption, cover title, chapter, pages, page options, PDF). The panel shell itself (sheet / side card
// and its heading) comes from EditorToolbar (ED_SHEET / ED_PANEL_HEADING).
// Plain strings, no imports (same rules as editor-classes.ts): 44 px targets, no transforms,
// transitions with motion-reduce:transition-none, no gold (Share is the screen's only gold).
// Idle / active pairs (TOOL_OPTION / TOOL_OPTION_ACTIVE) are complete alternatives — use one OR the
// other; cx doesn't merge conflicting utilities.

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

/** Ivory inset card inside a panel (a suggestion, a notice, a section). */
export const TOOL_WELL = "rounded-2xl border border-[#e9dfca] bg-[#faf6ee] p-3";

/** Secondary action: outlined emerald pill on white / ivory (emerald 11.57:1 on #faf6ee), 44 px. */
export const TOOL_SECONDARY =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-[#0e3b2e]/25 bg-white px-4 text-sm font-semibold text-[#0e3b2e] transition-colors outline-none hover:border-[#0e3b2e]/50 hover:bg-[#f3f7f4] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-[#0e3b2e]/25 disabled:hover:bg-white motion-reduce:transition-none";

/** Choice tile (font, alignment, AI option) — idle. Use TOOL_OPTION_ACTIVE instead when chosen. */
export const TOOL_OPTION =
  "rounded-2xl border border-[#e2d8c4] bg-white text-[#0e3b2e] transition-[background-color,border-color,box-shadow] outline-none hover:border-[#0e3b2e]/40 hover:bg-[#f3f7f4] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-[#e2d8c4] disabled:hover:bg-white motion-reduce:transition-none";

/** Choice tile — chosen: emerald ring on pale emerald (emerald 11.0:1 on #e6efe9). */
export const TOOL_OPTION_ACTIVE =
  "rounded-2xl border border-[#0e3b2e] bg-[#e6efe9] text-[#0e3b2e] shadow-[0_6px_14px_-10px_rgb(14_59_46/0.8)] ring-1 ring-[#0e3b2e] transition-[background-color,border-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none";

/** Round 44 px icon button on white (page move earlier / later). */
export const TOOL_ICON_BTN =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-[#0e3b2e] transition-colors outline-none hover:bg-[#e6efe9] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent motion-reduce:transition-none";

/** "AI suggestion" marker (as the review step's "Written by AI"): accent-text #7a5f0e 6.07:1 on white. */
export const TOOL_AI_MARKER = "inline-flex items-center gap-1.5 text-xs font-semibold text-accent-text";
