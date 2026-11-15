// Share page class recipes (M21 T2). Plain strings in a plain module (no "use client", no cn, no
// buttonVariants): the server page, the loading skeleton and the client islands import it at zero
// runtime cost (lessons 2026-11-11 / 2026-11-14).
//
// Band / page-only recipes (status chip tones, back link, "Open flipbook", body container) live in
// share-page-classes.ts so they stay out of the client bundle.
// Pills: ink #1b1b1d on the foil fill ≥ 6.44; emerald #0e3b2e on white 12.47.

/** Ivory card on the page body (matches the wizard review card). */
export const SHARE_CARD =
  "rounded-[1.75rem] border border-[#e9dfca] bg-card p-4 shadow-[0_18px_40px_-28px_rgb(14_59_46/0.45)] sm:p-7";

/** The screen's one gold call to action (pill, 48 px tall on phones, 56 px from sm). */
export const SHARE_CTA_GOLD =
  "home-foil-fill inline-flex min-h-12 items-center justify-center gap-2.5 rounded-full px-7 font-brand text-base font-semibold text-[#1b1b1d] shadow-[0_14px_28px_-16px_rgb(14_59_46/0.8),inset_0_1px_0_rgb(255_255_255/0.4)] transition-[filter,transform] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-[3px] focus-visible:ring-offset-[#f2e8d8] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none sm:min-h-14 sm:px-9 sm:text-lg";

/** Secondary action: emerald outline pill on ivory, 44 px. */
export const SHARE_CTA_EMERALD =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-[#0e3b2e]/30 bg-white px-5 text-sm font-semibold text-[#0e3b2e] transition-colors outline-none hover:border-[#0e3b2e]/60 hover:bg-[#f3f7f4] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f2e8d8] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/**
 * "Send on WhatsApp" on the share link card (M21 T3): WhatsApp's own deep green, the same
 * #0F7A40 the viewer uses (white text 5.41:1; #128C4A would be only 4.31:1), as a pill that matches
 * the gold CTA's shape. 48 px on phones, 56 px from sm.
 */
export const SHARE_CTA_WHATSAPP =
  "inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-full bg-[#0F7A40] text-white px-6 text-base font-semibold shadow-[0_14px_28px_-16px_rgb(14_59_46/0.8)] transition-colors outline-none hover:bg-[#0B6635] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-[3px] focus-visible:ring-offset-card motion-reduce:transition-none sm:h-14 sm:text-lg";

/** Read-only link field on the share link card (ltr URL, 44 px, monospace, ivory well). */
export const SHARE_LINK_FIELD =
  "h-11 w-full min-w-0 flex-1 truncate rounded-full border border-[#e9dfca] bg-[#faf6ee] px-4 font-mono text-sm text-foreground outline-none focus-visible:border-[#0e3b2e] focus-visible:ring-2 focus-visible:ring-[#0e3b2e]/40";

/** Round status badge on the primary card (foil check when live — hops on the celebration). */
export const SHARE_BADGE = "flex size-11 shrink-0 items-center justify-center rounded-full";

// ---- Secondary cards + page shell (M21 T4 / T5) ------------------------------------------------

/** Small caps line above a card heading (token accent-text, ≥ 4.5:1 on card / ivory). */
export const SHARE_EYEBROW = "text-[0.7rem] font-semibold tracking-[0.24em] text-accent-text uppercase";

/** Card heading (serif, emerald) — secondary cards. */
export const SHARE_CARD_HEADING = "font-display text-lg leading-tight font-semibold text-[#0e3b2e] sm:text-xl";

/** Round emerald icon chip leading a card header (graphic, decorative). */
export const SHARE_ICON_CHIP =
  "flex size-10 shrink-0 items-center justify-center rounded-full bg-[#e6efe9] text-[#0e3b2e] ring-1 ring-[#0e3b2e]/10";

/** Solid emerald pill (password Save): white on #0e3b2e 12.47:1, 44 px. */
export const SHARE_CTA_EMERALD_SOLID =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#0e3b2e] px-5 text-sm font-semibold text-white transition-colors outline-none hover:bg-[#145240] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/** Quiet danger text button (remove password, unpublish): destructive #b42318 on white 6.57:1, 44 px. */
export const SHARE_CTA_DANGER_QUIET =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold text-destructive transition-colors outline-none hover:bg-destructive-soft focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/** Solid danger pill (confirm Unpublish): white on #b42318 6.57:1, 44 px. */
export const SHARE_CTA_DANGER_SOLID =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-destructive px-5 text-sm font-semibold text-white transition-colors outline-none hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/** Text input in the share cards (password): ivory well, 44 px, 16 px text (no iOS zoom). */
export const SHARE_INPUT =
  "h-11 min-w-0 flex-1 rounded-full border border-[#e9dfca] bg-[#faf6ee] px-4 text-base text-foreground outline-none focus-visible:border-[#0e3b2e] focus-visible:ring-2 focus-visible:ring-[#0e3b2e]/40 aria-invalid:border-destructive";

/** Round 44 px icon button beside SHARE_INPUT (show / hide password). */
export const SHARE_ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full border border-[#e9dfca] bg-white text-[#0e3b2e] outline-none hover:bg-[#f3f7f4] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-card";

/**
 * Two columns from lg (preview aside + cards). Grid columns as data here so the skeleton
 * (loading.tsx) and the panel line up exactly.
 */
export const SHARE_COLUMNS = "lg:grid lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)] lg:items-start lg:gap-10 xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] xl:gap-14";

/** Space kept under the cards on phones so the end of the page clears the sticky bar. */
export const SHARE_BAR_SPACER = "h-[calc(5.5rem+env(safe-area-inset-bottom))] lg:hidden";

/** The gold Upgrade pill: SHARE_CTA_GOLD with phone padding px-5 so "Upgrade this book — AED 39" fits one line at 375. */
export const SHARE_UPGRADE_CLASS = `${SHARE_CTA_GOLD.replace(" px-7 ", " px-5 ")} w-full py-2 text-center whitespace-normal sm:w-auto sm:self-start`;

/** PdfDownload's share-page look (passed as a prop by share-slots, so the editor's PDF tool ships none of this). */
export const PDF_SHARE_LOOK = {
  primary: `${SHARE_CTA_EMERALD_SOLID} w-full py-2 whitespace-normal sm:w-auto sm:self-start`,
  outline: `${SHARE_CTA_EMERALD} w-full sm:w-auto sm:self-start`,
  well: "rounded-2xl border border-[#e9dfca] bg-[#faf6ee]",
};
