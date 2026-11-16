// UpgradeButton default looks + the "Payment cancelled" notice (M26, D-078). These two components ship
// on other routes (share page, editor, /b), so their recipes live here rather than in
// upgrade-classes.ts (lesson M21: a shared recipe module ships every export). Plain strings.
// Callers that pass className (share PlanCard, viewer ExpiredBook, editor UpgradeSheet) are unaffected.
//
// Contrast: white on emerald #0e3b2e 12.5; emerald on white 12.5; notice ink #1b1b1d on amber cream
// #fbf2e2 15.5, warm icon #8a5a12 on its chip #f6e3bf 5.1 (graphic ≥ 3).

/** Solid emerald pill (variants primary / viewer), wraps on narrow screens, 48 px. */
export const UPGRADE_BUTTON_PRIMARY =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#0e3b2e] px-5 py-2 text-center text-base font-semibold whitespace-normal text-white transition-colors outline-none hover:bg-[#145240] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/** Emerald outline pill (variant outline), wraps, 44 px. */
export const UPGRADE_BUTTON_OUTLINE =
  "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-[#0e3b2e]/30 bg-white px-4 py-2 text-center text-sm font-semibold whitespace-normal text-[#0e3b2e] transition-colors outline-none hover:border-[#0e3b2e]/60 hover:bg-[#f3f7f4] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/** Cancelled notice: soft amber-cream card in the share page's card shape. */
export const UPGRADE_CANCELLED_BOX =
  "flex w-full min-w-0 items-center gap-3 rounded-[1.25rem] border border-[#ebcf9a] bg-[#fbf2e2] py-1.5 ps-3 pe-1.5 text-sm text-[#1b1b1d] shadow-[0_14px_30px_-24px_rgb(14_59_46/0.55)]";

/** Round amber chip holding the notice icon (decorative). */
export const UPGRADE_CANCELLED_ICON = "flex size-8 shrink-0 items-center justify-center rounded-full bg-[#f6e3bf] text-[#8a5a12]";

/** Dismiss: 44 px round, emerald focus ring. */
export const UPGRADE_CANCELLED_DISMISS =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-[#1b1b1d]/75 outline-none hover:bg-[#ebcf9a]/45 hover:text-[#1b1b1d] focus-visible:ring-2 focus-visible:ring-[#0e3b2e]";
