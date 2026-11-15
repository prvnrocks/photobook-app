// Editor class recipes (M22 T2, D-074): the emerald leather / cream / gold language of the wizard
// (WizardBand) and the share page (share-classes.ts), applied to the editor.
// Plain strings in a plain module: no "use client", no imports at all (no cn, no buttonVariants, no
// next/link), so the editor's first-load island pays nothing for them (lessons 2026-11-11 / 2026-11-14).
// Join with cx from @/lib/cx.
//
// Rules baked into these strings (M22 guardrails):
// - 44 px targets (min-h-11 / size-11) for everything tappable.
// - Text contrast ≥ 4.5:1: ED_CONTRAST_PAIRS (editor-classes.data.ts — test data, never imported by
//   app code) lists every pair, tests/m22-editor-classes.test.ts recomputes them. On the leather the
//   worst case is its lightest point #1f5443.
// - Motion: only opacity / box-shadow / colour transitions, each with motion-reduce:transition-none.
//   No transform anywhere (no active:translate-y-px either) — the page carousel, EditablePage
//   ancestors and the crop box rely on getBoundingClientRect and dnd-kit hit-testing.
// - One gold per screen: ED_CTA_GOLD is for Share only; every other primary is ED_CTA_EMERALD.
// - Alternating recipes (ED_PILL / ED_PILL_ACTIVE, ED_THUMB / ED_THUMB_ACTIVE) are complete strings:
//   use one OR the other, never both (cx doesn't merge conflicting utilities).

// ---- Band (leather header) ---------------------------------------------------------------------

/**
 * The editor's leather band (outer element, e.g. <header>). Phones: one compact row — pair with
 * ED_BAND_ROW (h-14 = 56 px, under the 64 px budget); the top safe-area inset is added above the row.
 * ≥ lg: the tall variant (more vertical padding, room for ED_BAND_EYEBROW + page-count chip).
 * Foil rules at the sides/foot are separate decorative spans (as in WizardBand).
 */
export const ED_BAND =
  "home-leather relative isolate shrink-0 overflow-hidden text-[#f2e8d8] pt-[env(safe-area-inset-top)] ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)]";

/**
 * The band's content row: 56 px on phones (≤ 64 px), tall from lg. Phones: no gaps and 4 px side
 * padding — the 44 px icon buttons already carry 12 px of air around their icons — so the title gets
 * ≥ 140 px at 375 (M22 T7; it had ~105 px).
 */
export const ED_BAND_ROW =
  "flex h-14 min-w-0 items-center gap-0 px-1 sm:gap-2 sm:px-4 lg:h-auto lg:min-h-24 lg:gap-4 lg:px-8 lg:py-5";

/** Title block (eyebrow + h1) — flexes and truncates so the row never scrolls horizontally. */
export const ED_BAND_TITLE_WRAP = "flex min-w-0 flex-1 flex-col justify-center";

/**
 * The h1 (keep font-display; the user text goes in an inner <span dir="auto">). One line, ellipsis.
 * Cream on the leather's lightest point 7.19:1.
 */
export const ED_BAND_TITLE =
  "truncate font-display text-lg leading-tight font-semibold tracking-[-0.01em] text-[#f2e8d8] lg:text-[1.9rem]";

/** "EDITING" small caps over a foil hairline — ≥ lg only. Pale gold 5.25:1 on #1f5443. */
export const ED_BAND_EYEBROW =
  "hidden items-center gap-3 text-xs font-semibold tracking-[0.28em] text-[#e3c766] uppercase lg:mb-1 lg:flex";

/** The foil hairline after the eyebrow text (decorative span, aria-hidden). */
export const ED_BAND_EYEBROW_RULE = "home-foil-h block h-px w-12";

/** Round 44 px icon button on the leather (back, undo, redo, more). Cream 7.19:1; cream focus ring. */
export const ED_BAND_ICON_BTN =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-[#f2e8d8] transition-colors outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[#f2e8d8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent motion-reduce:transition-none";

// ---- Status chips on the leather (save status, page count, AI summary) ---------------------------

export type EdChipTone = "saved" | "saving" | "warn";

/** Chip shape (status, never a button): one line, 32 px, truncates. Combine with ED_CHIP_TONE[tone]. */
export const ED_CHIP =
  "inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 text-xs leading-none font-semibold whitespace-nowrap sm:text-sm";

/** Per-tone colours (literal classes so Tailwind sees them); hexes mirror ED_CHIP_COLORS (editor-classes.data.ts). */
export const ED_CHIP_TONE: Record<EdChipTone, string> = {
  saved: "border-[#7fd6a6]/50 bg-[#0f3a2d] text-[#9ee6bd]",
  saving: "border-[#9fb3a6]/45 bg-[#143f33] text-[#d7cdb9]",
  warn: "border-[#f3c969]/50 bg-[#2f2a14] text-[#f3c969]",
};

/** Leading status dot inside a chip (decorative; add ed-save-pulse while saving). */
export const ED_CHIP_DOT: Record<EdChipTone, string> = {
  saved: "size-1.5 shrink-0 rounded-full bg-[#7fd6a6]",
  saving: "size-1.5 shrink-0 rounded-full bg-[#9fb3a6]",
  warn: "size-1.5 shrink-0 rounded-full bg-[#f3c969]",
};

// ---- Floating toolbar pills (emerald segmented) --------------------------------------------------

/** The floating toolbar's container: white pill bar with a soft emerald shadow, safe-area aware. */
export const ED_PILL_BAR =
  "flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-[#e9dfca] bg-white p-1 shadow-[0_14px_32px_-18px_rgb(14_59_46/0.55)]";

/** Idle pill: emerald on white 12.47:1, 44 px. Use ED_PILL_ACTIVE instead (not with) when selected. */
export const ED_PILL =
  "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-sm font-semibold text-[#0e3b2e] transition-[background-color,color,box-shadow] outline-none hover:bg-[#e6efe9] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

/** Selected pill: cream on solid emerald 10.28:1, 44 px (pair with aria-pressed / aria-checked). */
export const ED_PILL_ACTIVE =
  "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full bg-[#0e3b2e] px-3.5 text-sm font-semibold text-[#f2e8d8] shadow-[0_6px_14px_-8px_rgb(14_59_46/0.9)] transition-[background-color,color,box-shadow] outline-none hover:bg-[#145240] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

// ---- Sheets, panel headings ----------------------------------------------------------------------

/**
 * Phone bottom sheet surface: rounded-t-3xl, a drag handle drawn by ::before (first block in the
 * sheet — keep the sheet a block or flex-col), bottom safe-area padding. Positioning (fixed inset-x-0
 * bottom-0, z-index) stays with the sheet component. Add ed-sheet-rise to animate a plain sheet in (MoreSheet,
 * SpreadPreviewSheet) — the tool panel host uses ed-panel-in (opacity only; crop/dnd inside).
 */
export const ED_SHEET =
  "rounded-t-3xl border-t border-[#e9dfca] bg-card px-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-18px_40px_-24px_rgb(14_59_46/0.45)] before:mx-auto before:mt-2 before:mb-3 before:block before:h-1.5 before:w-10 before:rounded-full before:bg-[#cfc4ad] before:content-['']";

/** Round 44 px close / dismiss button on white (sheets, panel, coach card): emerald 12.47:1. */
export const ED_CLOSE_BTN =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-[#0e3b2e] outline-none transition-colors hover:bg-[#e6efe9] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] motion-reduce:transition-none";

/** Small caps heading inside a card / sheet / panel (accent-text #7a5f0e on white 6.07:1). */
export const ED_PANEL_EYEBROW = "text-[0.7rem] font-semibold tracking-[0.24em] text-accent-text uppercase";

/** Panel heading (serif, emerald 12.47:1 on white). */
export const ED_PANEL_HEADING = "font-display text-lg leading-tight font-semibold text-[#0e3b2e]";

// ---- Stage, page frame, thumbnails ---------------------------------------------------------------

/**
 * The cream stage behind the page: radial vignette from #fdfaf3 (centre) to #ebe2d0 (edges). Muted
 * text #56625a stays ≥ 4.96:1 even at the darkest edge.
 */
export const ED_STAGE =
  "relative min-h-0 bg-[#f4ede0] bg-[radial-gradient(ellipse_75%_65%_at_50%_42%,#fdfaf3_0%,#f4ede0_62%,#ebe2d0_100%)]";

/**
 * Stage box without its own background (M22 review N4): PageCarousel / SpreadCarouselPlaceholder with
 * `bare`, when the host (ED_STAGE_HOST) paints the stage. Same geometry as ED_STAGE.
 */
export const ED_STAGE_BARE = "relative min-h-0";

/**
 * The stage column (EditorShell's <main>: stage + floating toolbar) as ONE cream surface (M22 T7):
 * the column paints the ED_STAGE gradient and the stage boxes inside it are rendered `bare`
 * (ED_STAGE_BARE), so there's no colour step between the stage and the strip under the toolbar.
 * ED_STAGE itself stays for stand-alone stages (spread preview).
 */
export const ED_STAGE_HOST =
  "bg-[#f4ede0] bg-[radial-gradient(ellipse_75%_65%_at_50%_42%,#fdfaf3_0%,#f4ede0_62%,#ebe2d0_100%)]";

/** Page strip column surface (EditorShell's width placeholder matches PageStrip's own STRIP colours). */
export const ED_STRIP_SURFACE = "border-r border-[#e5dccb] bg-[#f4ede0]";

/**
 * Outer frame around <BookPage>: soft shadow + hairline only. No padding, border width or aspect
 * changes — the page's aspect box inside is untouched (BookPage stays the single renderer).
 */
export const ED_PAGE_FRAME =
  "relative bg-white shadow-[0_28px_50px_-30px_rgb(14_59_46/0.55),0_2px_8px_-2px_rgb(14_59_46/0.12)] ring-1 ring-[#0e3b2e]/8";

/** Page strip thumbnail card (idle). Use ED_THUMB_ACTIVE instead (not with) for the current page. */
export const ED_THUMB =
  "relative block overflow-hidden rounded-xl bg-white shadow-[0_6px_16px_-10px_rgb(14_59_46/0.45)] ring-1 ring-[#e5dccb] transition-shadow outline-none hover:ring-[#0e3b2e]/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e3b2e] motion-reduce:transition-none";

/** Current page thumbnail: emerald ring + glow (box-shadow only). */
export const ED_THUMB_ACTIVE =
  "relative block overflow-hidden rounded-xl bg-white shadow-[0_0_0_4px_rgb(14_59_46/0.16),0_10px_24px_-12px_rgb(14_59_46/0.6)] ring-2 ring-[#0e3b2e] transition-shadow outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e3b2e] motion-reduce:transition-none";

/** Page label under a thumbnail / on the stage: muted #56625a, ≥ 4.96:1 on the stage edge. */
export const ED_STAGE_LABEL = "text-xs font-medium text-[#56625a]";

// ---- Calls to action -----------------------------------------------------------------------------

/**
 * Share — the screen's ONE gold action, on the leather band. Ink on the foil's darkest stop 6.44:1.
 * 44 px on phones, 48 px from lg. Cream focus ring offset on the leather. No press transform.
 * Phones (< sm): 10 px side padding (the note "Free · 30 days" still clears the pill's curve) so the
 * band title has room; 16 px from sm, 24 px from lg.
 */
export const ED_CTA_GOLD =
  "home-foil-fill inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full px-2.5 sm:px-4 font-brand text-sm font-semibold text-[#1b1b1d] shadow-[0_10px_22px_-14px_rgb(0_0_0/0.8),inset_0_1px_0_rgb(255_255_255/0.4)] transition-[filter] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-[#f2e8d8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e3b2e] active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none lg:min-h-12 lg:px-6 lg:text-base";

/** Emerald solid action (Make with AI, Apply, Done…): white on #0e3b2e 12.47:1, 44 px. */
export const ED_CTA_EMERALD =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#0e3b2e] px-5 text-sm font-semibold text-white shadow-[0_10px_22px_-14px_rgb(14_59_46/0.9)] transition-colors outline-none hover:bg-[#145240] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/** Quiet text action on white / ivory (Cancel, Reset): emerald 11.57:1 on #faf6ee, 44 px. */
export const ED_CTA_QUIET =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold text-[#0e3b2e] transition-colors outline-none hover:bg-[#e6efe9] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

/** Quiet destructive action (Remove photo, Delete page): #b42318 6.10:1 on #faf6ee, 44 px. */
export const ED_DANGER_QUIET =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold text-destructive transition-colors outline-none hover:bg-destructive-soft focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
