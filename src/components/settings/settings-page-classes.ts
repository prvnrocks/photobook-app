// Settings page recipes used only by server-rendered parts (M24, D-076): page container + columns,
// leather band (back link, email chip), section nav, definition-list well, danger zone wrapper and the
// foot link. Kept apart from settings-classes.ts (the client islands' recipes) so these strings never
// ride along in the settings client bundle. Plain strings, no "use client", no cn.
// Contrast on the leather's lightest point #1f5443: cream #f2e8d8 7.19, cream-muted #d7cdb9 5.53,
// pale gold #e3c766 5.25; the email chip's text on its solid #143f33 fill ≥ 7.4.

/** Library width + gutters (same as LIBRARY_CONTAINER / SHARE_BODY). */
export const SETTINGS_CONTAINER = "mx-auto w-full max-w-library px-gutter sm:px-6 lg:px-10";

/** Body: stacked on phones; ≥ lg a sticky section nav + the cards column. */
export const SETTINGS_COLUMNS =
  "pt-6 pb-16 sm:pt-8 lg:grid lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:items-start lg:gap-10 xl:gap-14";

/** The cards column (capped so lines stay readable on wide screens). */
export const SETTINGS_CONTENT = "flex min-w-0 max-w-4xl flex-col gap-4 sm:gap-5";

/** Anchor targets clear the sticky 56 px app header. */
export const SETTINGS_ANCHOR = "min-w-0 scroll-mt-20";

/** Cream well holding a definition list (account details, what the AI learned). */
export const SETTINGS_WELL = "min-w-0 rounded-2xl border border-[#e9dfca] bg-[#faf6ee] px-4 sm:px-5";

/** One dt/dd row inside SETTINGS_WELL (stacked on phones, label column from sm). */
export const SETTINGS_ROW = "flex min-w-0 flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-6";
export const SETTINGS_DT = "shrink-0 text-sm text-muted-foreground sm:w-44";
export const SETTINGS_DD = "min-w-0 text-base font-medium text-foreground";

/** Value chips inside a row (names, things to avoid). */
export const SETTINGS_VALUE_CHIP =
  "max-w-full rounded-full border border-[#0e3b2e]/15 bg-white px-2.5 py-0.5 text-sm break-words text-[#0e3b2e]";

/** Danger zone wrapper: dashed rule + small red label, set apart from the regular settings. */
export const SETTINGS_DANGER_ZONE = "mt-4 border-t border-dashed border-destructive-border pt-5 sm:mt-6 sm:pt-6";
export const SETTINGS_DANGER_LABEL = "mb-3 text-xs font-semibold tracking-[0.18em] text-destructive uppercase";

/** Section nav (≥ lg): sticky card of anchor links, 44 px rows. Hidden on phones (short page). */
export const SETTINGS_NAV =
  "sticky top-20 hidden rounded-[1.75rem] border border-[#e9dfca] bg-card p-3 shadow-[0_18px_40px_-28px_rgb(14_59_46/0.45)] lg:block";
export const SETTINGS_NAV_LINK =
  "flex min-h-11 items-center gap-3 rounded-full px-3 text-sm font-medium text-[#0e3b2e] outline-none hover:bg-[#f3f7f4] focus-visible:ring-2 focus-visible:ring-[#0e3b2e]";
export const SETTINGS_NAV_LINK_DANGER =
  "flex min-h-11 items-center gap-3 rounded-full px-3 text-sm font-medium text-destructive outline-none hover:bg-destructive-soft focus-visible:ring-2 focus-visible:ring-destructive";

/** "Back to my books" at the foot: quiet emerald text link, 44 px. */
export const SETTINGS_FOOT_LINK =
  "mt-2 inline-flex min-h-11 items-center gap-2 self-start rounded-full px-3 text-sm font-semibold text-[#0e3b2e] underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Leather band back link (cream-muted, 44 px, cream focus ring). */
export const SETTINGS_BAND_BACK =
  "-ms-2 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-[#d7cdb9] outline-none hover:text-[#f2e8d8] focus-visible:ring-2 focus-visible:ring-[#f2e8d8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e3b2e]";

/** Signed-in email chip on the leather: wraps for long addresses (never widens the page). */
export const SETTINGS_EMAIL_CHIP =
  "inline-flex max-w-full min-w-0 flex-wrap items-baseline gap-x-1.5 rounded-2xl border border-[#9fb3a6]/45 bg-[#143f33] px-3.5 py-1.5 text-sm text-[#d7cdb9]";
