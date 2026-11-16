// Upgrade return page recipes used only by server-rendered parts (M26, D-078): the compact leather
// band (back link, eyebrow, book title) and the cream body. Kept apart from upgrade-classes.ts (the
// poller island's recipes) so these strings never ride along in the client bundle. Plain strings.
// Contrast on the leather's lightest point #1f5443: cream #f2e8d8 7.19, cream-muted #d7cdb9 5.53,
// pale gold #e3c766 5.25 (tests/m26-upgrade.test.tsx recomputes them via UPGRADE_BAND_CONTRAST).

/** Library width + gutters (same as LIBRARY_CONTAINER / SETTINGS_CONTAINER). */
export const UPGRADE_CONTAINER = "mx-auto w-full max-w-library px-gutter sm:px-6 lg:px-10";

/** Cream body under the band: the status card centred, phone safe area at the foot. */
export const UPGRADE_BODY = "flex justify-center pt-6 pb-[calc(2.5rem+env(safe-area-inset-bottom))] sm:pt-10 lg:pt-12";

/** Column holding the status card. */
export const UPGRADE_COLUMN = "w-full max-w-lg min-w-0";

/** Band back link (cream-muted, 44 px, cream focus ring). */
export const UPGRADE_BAND_BACK =
  "-ms-2 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-[#d7cdb9] outline-none hover:text-[#f2e8d8] focus-visible:ring-2 focus-visible:ring-[#f2e8d8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e3b2e]";

/** Load-error retry link (server page): solid emerald pill, 48 px. */
export const UPGRADE_RETRY =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#0e3b2e] px-6 text-base font-semibold text-white transition-colors outline-none hover:bg-[#145240] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#fffcf6] motion-reduce:transition-none";

/** [name, fg, bg, min] on the leather's lightest point. */
export const UPGRADE_BAND_CONTRAST: ReadonlyArray<readonly [string, string, string, number]> = [
  ["band title cream", "#f2e8d8", "#1f5443", 4.5],
  ["band back link cream-muted", "#d7cdb9", "#1f5443", 4.5],
  ["band eyebrow pale gold", "#e3c766", "#1f5443", 4.5],
];
