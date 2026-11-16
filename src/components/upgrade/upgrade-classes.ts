// Upgrade return page recipes (M26, D-078) for the UpgradeStatusPoller island: cream status card,
// seals, benefit cards and the pills. Plain strings in a plain module (no "use client", no cn, no
// buttonVariants) — zero runtime cost. Values follow the share page recipes (share-classes.ts) but
// are copied, not imported, so the share tables never ride along in this route's bundle (lesson M21).
// The leather band / page recipes live in upgrade-page-classes.ts (server only); UpgradeButton's and
// the cancelled notice's looks live in upgrade-button-classes.ts (they ship on other routes).
//
// Contrast (tests/m26-upgrade.test.tsx recomputes every pair in UPGRADE_CONTRAST):
//   card #fffcf6: heading emerald #0e3b2e 12.2, body #4a4740 9.0.
//   benefit card #faf6ee: ink #1b1b1d 16.1; check #f2e8d8 on emerald #0e3b2e 10.4 (graphic).
//   gold pill: ink #1b1b1d on the foil's darkest stop #bf9a23 6.44.
//   emerald pills: white on #0e3b2e 12.5; emerald on white 12.5.
//   seals: pale gold #e3c766 on emerald 7.5; ink on the gold seal's darkest stop #b8962a 6.09;
//   calm seal emerald on #efe6d4 10.6; warm seal #8a5a12 on #fbf2e2 6.0.

/** The cream status card, centred on the cream body. Clips the paid celebration (never widens the page). */
export const UP_CARD =
  "relative isolate flex w-full min-w-0 flex-col items-center gap-4 overflow-hidden rounded-[1.75rem] border border-[#e9dfca] bg-[#fffcf6] px-5 pt-7 pb-6 text-center shadow-[0_18px_40px_-28px_rgb(14_59_46/0.45)] sm:px-8 sm:pt-9 sm:pb-8";

/** Small caps line above the heading (never user text): antique gold on the card. */

/** The state heading (h1, serif emerald). */
export const UP_HEADING = "font-display text-[1.6rem] leading-tight font-semibold text-[#0e3b2e] sm:text-[1.9rem]";

/** Body copy on the card. */
export const UP_BODY = "max-w-sm text-[0.95rem] leading-relaxed text-[#4a4740] sm:text-base";

/** Seal wrapper (positions the ring + burst around the disc). Decorative. */
export const UP_SEAL_WRAP = "relative flex size-20 shrink-0 items-center justify-center";

/** Confirming: emerald disc, pale gold icon (the gold ring around it turns; static with reduced motion). */
export const UP_SEAL_CONFIRMING =
  "relative flex size-16 items-center justify-center rounded-full bg-[#0e3b2e] text-[#e3c766] shadow-[0_10px_22px_-14px_rgb(14_59_46/0.9),inset_0_0_0_1px_rgb(227_199_102/0.35)]";

/** Paid: the round gold foil seal with an ink check. */
export const UP_SEAL_PAID =
  "home-seal relative flex size-16 items-center justify-center rounded-full text-[#1b1b1d] shadow-[0_12px_24px_-14px_rgb(122_95_14/0.9),inset_0_1px_0_rgb(255_255_255/0.5)]";

/** Calm states (timeout, signed out, not found): cream disc, emerald icon. */
export const UP_SEAL_CALM =
  "flex size-16 items-center justify-center rounded-full bg-[#efe6d4] text-[#0e3b2e] ring-1 ring-[#0e3b2e]/10";

/** Payment problems (failed, support): soft amber disc, warm icon — calm, not alarming red. */
export const UP_SEAL_WARM =
  "flex size-16 items-center justify-center rounded-full bg-[#fbf2e2] text-[#8a5a12] ring-1 ring-[#ebcf9a]";

/** Benefits grid (the four upgrade perks as small cards): two columns from 360 px. */
export const UP_BENEFITS = "grid w-full grid-cols-1 gap-2 text-start min-[360px]:grid-cols-2 sm:gap-3";

/** One benefit card. */
export const UP_BENEFIT =
  "flex min-w-0 items-start gap-2.5 rounded-2xl border border-[#e9dfca] bg-[#faf6ee] p-3 text-sm leading-snug font-medium text-[#1b1b1d]";

/** Round emerald check leading a benefit (decorative). */
export const UP_BENEFIT_CHECK =
  "flex size-6 shrink-0 items-center justify-center rounded-full bg-[#0e3b2e] text-[#f2e8d8]";

/** Action stack under the copy. */
export const UP_ACTIONS = "mt-1 flex w-full flex-col gap-2.5";

/** The state's one gold call to action (paid only): foil pill, 48 px / 56 px from sm. */
export const UP_CTA_GOLD =
  "home-foil-fill inline-flex min-h-12 w-full items-center justify-center gap-2.5 rounded-full px-6 py-2 text-center font-brand text-base font-semibold text-[#1b1b1d] shadow-[0_14px_28px_-16px_rgb(14_59_46/0.8),inset_0_1px_0_rgb(255_255_255/0.4)] transition-[filter,transform] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-[3px] focus-visible:ring-offset-[#fffcf6] active:translate-y-px motion-reduce:transition-none sm:min-h-14 sm:text-lg";

/** Solid emerald pill (the main action of every non-paid state), 48 px. */
export const UP_CTA_EMERALD =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#0e3b2e] px-6 py-2 text-center text-base font-semibold text-white transition-colors outline-none hover:bg-[#145240] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#fffcf6] motion-reduce:transition-none";

/** Emerald outline pill (secondary actions), 48 px. */
export const UP_CTA_OUTLINE =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-[#0e3b2e]/30 bg-white px-6 py-2 text-center text-base font-semibold text-[#0e3b2e] transition-colors outline-none hover:border-[#0e3b2e]/60 hover:bg-[#f3f7f4] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#fffcf6] motion-reduce:transition-none";

/** Support reference well (monospace book id, wraps at 320 px). */
export const UP_REF =
  "w-full rounded-xl border border-[#e9dfca] bg-[#faf6ee] px-3 py-2 font-mono text-xs break-all text-[#4a4740]";

/** Colour pairs behind the recipes above, for the contrast test. [fg, bg, min ratio]. */
export const UPGRADE_CONTRAST: ReadonlyArray<readonly [string, string, string, number]> = [
  ["heading", "#0e3b2e", "#fffcf6", 4.5],
  ["body", "#4a4740", "#fffcf6", 4.5],
  ["benefit text", "#1b1b1d", "#faf6ee", 4.5],
  ["benefit check (graphic)", "#f2e8d8", "#0e3b2e", 3],
  ["gold pill ink", "#1b1b1d", "#bf9a23", 4.5],
  ["emerald pill", "#ffffff", "#0e3b2e", 4.5],
  ["outline pill", "#0e3b2e", "#ffffff", 4.5],
  ["confirming seal icon (graphic)", "#e3c766", "#0e3b2e", 3],
  ["paid seal icon (graphic)", "#1b1b1d", "#b8962a", 3],
  ["calm seal icon (graphic)", "#0e3b2e", "#efe6d4", 3],
  ["warm seal icon (graphic)", "#8a5a12", "#fbf2e2", 3],
  ["support reference", "#4a4740", "#faf6ee", 4.5],
];
