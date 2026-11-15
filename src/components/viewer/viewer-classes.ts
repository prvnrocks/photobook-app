// Viewer class recipes (M23 T1, D-075): the emerald leather / cream / gold language of the editor
// (editor-classes.ts) and the share page, applied to the public flipbook viewer /b/[slug].
// Plain strings in a plain module: no "use client", no imports at all (no cn, no buttonVariants, no
// next/link), so the viewer's first-load island pays nothing for them (lessons 2026-11-11 / 2026-11-14).
// Join with cx from @/lib/cx.
//
// Rules baked into these strings (M23 guardrails, .agentos/runs/m23.md):
// - 44 px targets (min-h-11 / size-11) for everything tappable.
// - Text contrast ≥ 4.5:1: VW_CONTRAST_PAIRS (viewer-classes.data.ts — test data, never imported by
//   app code) lists every pair, tests/m23-viewer-classes.test.ts recomputes them. On the leather the
//   worst case is its lightest point #1f5443 (cream #f2e8d8, muted #d7cdb9, pale gold #e3c766).
// - Motion: only opacity / box-shadow / colour transitions, each with motion-reduce:transition-none.
//   No transform anywhere: page-flip maps touch coordinates through the stage's bounding box, so
//   nothing may translate or scale viewer-stage or its descendants. The one translating animation
//   (vw-sheet-rise, viewer-motion.css) belongs on ViewerSheet's panel only.
// - The stage keeps its own geometry: VW_STAGE is paint only (no padding, border or transform —
//   ViewerShell keeps p-2 sm:p-4). The book's "shadow" is the pool gradient painted here, never a
//   box-shadow on the book box (page-flip shows one half of a spread alone).
// - One gold per screen: VW_CTA_GOLD (free end "Create yours", expired Upgrade / "Create your own",
//   password "Open photobook", not-found create link). Every other primary is VW_CTA_EMERALD.
// - Alternating recipes are complete strings: use one OR the other, never both (cx doesn't merge
//   conflicting utilities).
// - User text (title, chapter) keeps dir="auto" on the element / an inner span and labelFontStyle;
//   no letter-spacing in VW_TITLE / VW_SUBLINE (it breaks Arabic joining).

// ---- Band (slim leather header) -----------------------------------------------------------------

/**
 * The viewer's leather band (outer <header>). Safe-area insets only (top/left/right); no border or
 * block padding of its own, so its height is exactly VW_BAND_ROW's 52 px + the top inset — constant
 * while reading. A foil hairline under it is a separate decorative span (VW_BAND_RULE).
 */
export const VW_BAND =
  "home-leather relative isolate shrink-0 overflow-hidden text-[#f2e8d8] pt-[env(safe-area-inset-top)] ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)]";

/** The band's single row: 52 px (h-13). 4 px side air on phones (the 44 px buttons carry their own). */
export const VW_BAND_ROW = "flex h-13 min-w-0 items-center gap-0.5 ps-3 pe-1 sm:gap-1 sm:ps-4 sm:pe-2 lg:ps-6 lg:pe-4";

/** Optional foil hairline at the band's foot (aria-hidden span, absolutely placed — no height change). */
export const VW_BAND_RULE = "home-foil-h pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-60";

/** Title + chapter column: flexes and truncates so the band never scrolls horizontally. */
export const VW_TITLE_WRAP = "flex min-w-0 flex-1 flex-col justify-center";

/**
 * The h1 (keep dir="auto" as its FIRST attribute and labelFontStyle(title) — the Cairo chain for
 * Arabic). One line, ellipsis. Cream on the leather's lightest point 7.19:1. No letter-spacing.
 */
export const VW_TITLE = "truncate font-display text-base leading-tight font-semibold text-[#f2e8d8] sm:text-lg";

/**
 * Chapter line under the title (pass as ChapterLabel's className — it has dir="auto"). Pale gold
 * 5.25:1 on the leather's lightest point. No letter-spacing / uppercase (user text, may be Arabic).
 */
export const VW_SUBLINE = "truncate text-xs leading-snug text-[#e3c766]";

/** Round 44 px icon button on the leather (fullscreen, contents, share). Cream 7.19:1; gold focus ring. */
export const VW_ICON_BTN =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-[#f2e8d8] transition-colors outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[#e3c766] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent motion-reduce:transition-none";

/**
 * Icon + text button on the leather (e.g. "Contents" / "Share" from sm when there is room). Same
 * colours as VW_ICON_BTN, 44 px tall. Use instead of (not with) VW_ICON_BTN.
 */
export const VW_BAND_TEXT_BTN =
  "inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-semibold text-[#f2e8d8] transition-colors outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[#e3c766] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e3b2e] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent motion-reduce:transition-none";

// ---- Stage ----------------------------------------------------------------------------------------

/**
 * The cream stage (viewer-stage) — paint only. Two background layers: a soft emerald ground-shadow
 * "pool" under the book (low, wide ellipse) over the editor's cream radial vignette. No padding,
 * border or transform here (ViewerShell keeps `relative min-h-0 flex-1 p-2 sm:p-4`). No text sits on
 * the pool; stage text (VW_STAGE_LABEL) is checked against the vignette's darkest edge #ebe2d0.
 */
export const VW_STAGE =
  "bg-[#f4ede0] bg-[radial-gradient(ellipse_44%_7%_at_50%_93%,rgb(14_59_46/0.2)_0%,rgb(14_59_46/0.08)_55%,transparent_100%),radial-gradient(ellipse_75%_65%_at_50%_42%,#fdfaf3_0%,#f4ede0_62%,#ebe2d0_100%)]";

/** Small muted text on the stage (hints, empty states): #56625a ≥ 4.96:1 on the stage edge. */
export const VW_STAGE_LABEL = "text-xs font-medium text-[#56625a]";

/**
 * Pseudo-fullscreen "Show controls" button floating over the stage (absolute; caller places it with
 * safe-area offsets). Cream on solid emerald 10.28:1, 44 px. No transform.
 */
export const VW_FLOAT_BTN =
  "flex size-11 items-center justify-center rounded-full bg-[#0e3b2e]/85 text-[#f2e8d8] shadow-[0_8px_20px_-10px_rgb(14_59_46/0.9)] transition-colors outline-none hover:bg-[#0e3b2e] focus-visible:ring-2 focus-visible:ring-[#e3c766] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e3b2e] motion-reduce:transition-none";

// ---- Navigation (bottom bar) ---------------------------------------------------------------------

/**
 * The bottom bar row holding the nav pill (and Contents / Share where the layout puts them).
 * Solid #ebe2d0 (the stage vignette's edge colour, so stage and bar read as one surface). Safe-area
 * left/right; the caller adds the bottom inset
 * when no footer follows (paid / pseudo-fullscreen).
 */
export const VW_NAV_BAR =
  "flex shrink-0 items-center justify-center gap-2 bg-[#ebe2d0] py-1.5 ps-[max(0.5rem,env(safe-area-inset-left))] pe-[max(0.5rem,env(safe-area-inset-right))]";

/**
 * White pill holding prev / counter / next: exactly 44 px tall (its buttons are size-11). Hairline
 * via ring (no border, no padding — geometry stays the buttons'). Soft emerald shadow. No transform.
 */
export const VW_NAV_PILL =
  "inline-flex h-11 max-w-full items-center rounded-full bg-white ring-1 ring-[#e9dfca] shadow-[0_12px_28px_-16px_rgb(14_59_46/0.55)]";

/** Prev / next inside the nav pill: emerald 12.47:1 on white, 44 px; disabled fades. */
export const VW_NAV_BTN =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-[#0e3b2e] transition-colors outline-none hover:bg-[#e6efe9] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent motion-reduce:transition-none";

/**
 * The page counter text inside the nav pill (PageCounter's span, aria-live stays on it). Not a
 * button. Emerald on white 12.47:1, tabular figures.
 */
export const VW_COUNTER_PILL =
  "min-w-[4.5rem] px-1 text-center text-sm font-semibold whitespace-nowrap text-[#0e3b2e] tabular-nums";

/**
 * Chapter chip on a light surface (contents current marker, desktop stage label). Not a button —
 * for a tappable chip wrap it in a 44 px target. Emerald on mint 10.62:1. Holds user text: put
 * dir="auto" on an inner span; no letter-spacing.
 */
export const VW_CHAPTER_PILL =
  "inline-flex h-7 max-w-full min-w-0 items-center truncate rounded-full bg-[#e6efe9] px-3 text-xs font-semibold text-[#0e3b2e]";

// ---- Cards and sheets -----------------------------------------------------------------------------

/** White card on cream / ivory (share options group, message details). */
export const VW_CARD =
  "rounded-2xl bg-white text-[#1b1b1d] ring-1 ring-[#e9dfca] shadow-[0_14px_32px_-22px_rgb(14_59_46/0.5)]";

/** Sheet backdrop (the full-screen close button behind the panel). */
export const VW_SHEET_BACKDROP = "absolute inset-0 bg-[#0e3b2e]/45";

/**
 * ViewerSheet's panel: ivory, rounded top on phones / all round from sm, bottom safe-area on phones.
 * Add vw-sheet-rise (viewer-motion.css) on this element only — it is a fixed sibling of the stage.
 */
export const VW_SHEET =
  "relative flex max-h-[75dvh] w-full max-w-md flex-col rounded-t-3xl bg-[#faf5ec] pb-[env(safe-area-inset-bottom)] text-[#1b1b1d] shadow-[0_-18px_40px_-24px_rgb(14_59_46/0.55)] outline-none sm:rounded-3xl sm:pb-0 sm:shadow-[0_30px_60px_-30px_rgb(14_59_46/0.6)]";

/** Phone drag handle (decorative span inside a `flex justify-center pt-2 sm:hidden` row). */
export const VW_SHEET_HANDLE = "h-1.5 w-10 rounded-full bg-[#cfc4ad]";

/** Sheet header row: title + close, hairline under it. */
export const VW_SHEET_HEADER = "flex items-center justify-between gap-2 border-b border-[#e9dfca] py-1.5 ps-5 pe-2 sm:py-2";

/** Sheet title (serif, emerald 11.48:1 on ivory). */
export const VW_SHEET_TITLE = "font-display text-lg leading-tight font-semibold text-[#0e3b2e]";

/** Round 44 px close button on ivory / white: emerald 11.48:1. */
export const VW_CLOSE_BTN =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-[#0e3b2e] transition-colors outline-none hover:bg-[#e6efe9] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] motion-reduce:transition-none";

/** Contents row (idle): 44 px, ink on ivory. Use VW_LIST_ROW_ACTIVE instead (not with) for the current chapter. */
export const VW_LIST_ROW =
  "flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-start text-sm text-[#1b1b1d] transition-colors outline-none hover:bg-[#efe7d8] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-inset motion-reduce:transition-none";

/** Current contents row: emerald text on mint 10.62:1, semibold. */
export const VW_LIST_ROW_ACTIVE =
  "flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl bg-[#e6efe9] px-3 py-2 text-start text-sm font-semibold text-[#0e3b2e] transition-colors outline-none hover:bg-[#dbe8e0] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-inset motion-reduce:transition-none";

/** Secondary text in a sheet / card (dates, hints): ink-soft #4a4740 on ivory 8.53:1. */
export const VW_MUTED = "text-sm text-[#4a4740]";

// ---- Calls to action -----------------------------------------------------------------------------

/**
 * The screen's ONE gold action (on a light surface): foil fill, ink 6.44:1 on its darkest stop.
 * 44 px. Emerald focus ring (gold is fill-only on light). No press transform.
 */
export const VW_CTA_GOLD =
  "home-foil-fill inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 font-brand text-sm font-semibold text-[#1b1b1d] shadow-[0_10px_22px_-14px_rgb(0_0_0/0.7),inset_0_1px_0_rgb(255_255_255/0.4)] transition-[filter] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#faf5ec] active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/** Emerald solid action: white on #0e3b2e 12.47:1, 44 px. */
export const VW_CTA_EMERALD =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#0e3b2e] px-5 text-sm font-semibold text-white shadow-[0_10px_22px_-14px_rgb(14_59_46/0.9)] transition-colors outline-none hover:bg-[#145240] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#faf5ec] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/** Emerald outline action on ivory / white: emerald 11.48:1 on ivory, 44 px (2 px border inside the 44). */
export const VW_CTA_EMERALD_OUTLINE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border-2 border-[#0e3b2e] bg-transparent px-5 text-sm font-semibold text-[#0e3b2e] transition-colors outline-none hover:bg-[#e6efe9] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#faf5ec] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/** WhatsApp share: white on #0F7A40 5.41:1 (not #128C4A, 4.31), 44 px. */
export const VW_CTA_WHATSAPP =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#0F7A40] px-5 text-sm font-semibold text-white transition-colors outline-none hover:bg-[#0c6634] focus-visible:ring-2 focus-visible:ring-[#0F7A40] focus-visible:ring-offset-2 focus-visible:ring-offset-[#faf5ec] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

// ---- Footer (free books) -------------------------------------------------------------------------

/**
 * "Made with Photobook — create yours" strip: thin leather, muted cream 5.53:1. Safe-area left/right;
 * the caller adds the bottom inset (it is the last row).
 */
export const VW_FOOTER =
  "home-leather shrink-0 text-center text-xs text-[#d7cdb9] ps-[max(0.75rem,env(safe-area-inset-left))] pe-[max(0.75rem,env(safe-area-inset-right))]";

/** The footer's link: 44 px tall, cream emphasis 7.19:1, gold focus ring. */
export const VW_FOOTER_LINK =
  "inline-flex min-h-11 items-center gap-1 rounded-full px-2 outline-none transition-colors hover:text-[#f2e8d8] focus-visible:ring-2 focus-visible:ring-[#e3c766] motion-reduce:transition-none";

/** The emphasised part of the footer link ("create yours"). */
export const VW_FOOTER_STRONG = "font-semibold text-[#f2e8d8] underline underline-offset-2";

// ---- Message screens (password, expired, unavailable, not found) ---------------------------------

/** Full-bleed leather page centring one card; safe-area on every side. */
export const VW_MESSAGE_SCREEN =
  "home-leather flex min-h-dvh w-full items-center justify-center pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] ps-[max(1rem,env(safe-area-inset-left))] pe-[max(1rem,env(safe-area-inset-right))]";

/** The cream card on the leather (ivory #faf5ec): ink text 15.84:1. Fits 320 px with the screen's 16 px gutters. */
export const VW_MESSAGE_CARD =
  "w-full max-w-md rounded-3xl bg-[#faf5ec] p-6 text-[#1b1b1d] shadow-[0_30px_60px_-30px_rgb(0_0_0/0.65)] ring-1 ring-[#e3c766]/30 sm:p-8";

/** Small caps eyebrow on the cream card (never user text): antique gold #7a5f0e 5.57:1 on ivory. */
export const VW_MESSAGE_EYEBROW = "text-[0.7rem] font-semibold tracking-[0.24em] text-[#7a5f0e] uppercase";

/** Card heading (serif, emerald 11.48:1 on ivory). */
export const VW_MESSAGE_HEADING = "font-display text-2xl leading-tight font-semibold text-[#0e3b2e]";

/** Card body text: ink-soft 8.53:1 on ivory. */
export const VW_MESSAGE_BODY = "text-sm leading-relaxed text-[#4a4740]";
