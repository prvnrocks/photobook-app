// Settings screen class recipes (M24, D-076) shared by the server page and the client islands
// (EmailRemindersToggle, SettingsClearButton, DeleteAccount). Plain strings in a plain module (no
// "use client", no cn, no buttonVariants) — zero runtime cost. Values follow the share page recipes
// (share-classes.ts) but are copied, not imported, so the share tables never ride along in the
// settings bundle (lesson M21: a shared recipe module ships every export). Server-only recipes live in
// settings-page-classes.ts.
//
// Contrast (tests/m24-settings.test.tsx recomputes the pairs):
//   cards: emerald #0e3b2e on white 12.47; destructive #b42318 on white 6.57.
//   switch track (graphic, ≥ 3:1 on the white card): on #0e3b2e 12.47, off #8c8576 ≥ 3.5.

/** Ivory card on the page body. */
export const SETTINGS_CARD =
  "flex min-w-0 flex-col gap-4 rounded-[1.75rem] border border-[#e9dfca] bg-card p-5 shadow-[0_18px_40px_-28px_rgb(14_59_46/0.45)] sm:p-7";

/** Card header row: icon chip + heading block. */
export const SETTINGS_CARD_HEAD = "flex min-w-0 items-start gap-3 sm:gap-4";

/** Card heading (serif, emerald). */
export const SETTINGS_CARD_HEADING = "font-display text-lg leading-tight font-semibold text-[#0e3b2e] sm:text-xl";

/** Round emerald icon chip leading a card header (decorative). */
export const SETTINGS_ICON_CHIP =
  "flex size-10 shrink-0 items-center justify-center rounded-full bg-[#e6efe9] text-[#0e3b2e] ring-1 ring-[#0e3b2e]/10";

/** Secondary action: emerald outline pill, 44 px. */
export const SETTINGS_CTA_EMERALD =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-[#0e3b2e]/30 bg-white px-5 text-sm font-semibold text-[#0e3b2e] transition-colors outline-none hover:border-[#0e3b2e]/60 hover:bg-[#f3f7f4] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/** Solid danger pill: white on #b42318 6.57:1, 44 px. */
export const SETTINGS_CTA_DANGER =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-destructive px-5 text-sm font-semibold text-white transition-colors outline-none hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/**
 * Delete account button, full alternatives (cx doesn't merge): a quiet outline while the word isn't
 * typed (the button is disabled), solid red once it is.
 */
export const SETTINGS_DELETE_BUTTON_IDLE =
  "inline-flex min-h-11 w-full cursor-not-allowed items-center justify-center gap-2 rounded-full border border-destructive-border bg-white px-6 text-base font-semibold text-destructive/60 outline-none sm:w-auto sm:self-start";
export const SETTINGS_DELETE_BUTTON_READY =
  "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-destructive px-6 text-base font-semibold text-white shadow-[0_12px_24px_-16px_rgb(180_35_24/0.9)] transition-colors outline-none hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-wait disabled:opacity-70 motion-reduce:transition-none sm:w-auto sm:self-start";

/** Delete account card: quiet until DELETE is typed, then red-tinted (full alternatives). */
export const SETTINGS_DANGER_CARD_QUIET =
  "flex min-w-0 flex-col gap-3 rounded-[1.75rem] border border-[#e9dfca] bg-card p-5 transition-colors motion-reduce:transition-none sm:p-7";
export const SETTINGS_DANGER_CARD_ARMED =
  "flex min-w-0 flex-col gap-3 rounded-[1.75rem] border border-destructive-border bg-destructive-soft/60 p-5 transition-colors motion-reduce:transition-none sm:p-7";

/** Confirm text input (ltr), 44 px, 16 px text (no iOS zoom), red focus. */
export const SETTINGS_DANGER_INPUT =
  "h-11 w-full min-w-0 rounded-full border border-[#e2d7c1] bg-[#faf6ee] px-4 text-base text-foreground outline-none focus-visible:border-destructive focus-visible:ring-2 focus-visible:ring-destructive/30 sm:max-w-sm";

/**
 * Email reminders switch track + thumb, full alternatives. Off track #8c8576 (muted, ≥ 3:1 on
 * white), on track emerald #0e3b2e. The thumb slides; no movement under reduced motion.
 */
export const SETTINGS_SWITCH_TRACK_ON =
  "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full bg-[#0e3b2e] transition-colors motion-reduce:transition-none";
export const SETTINGS_SWITCH_TRACK_OFF =
  "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full bg-[#8c8576] transition-colors motion-reduce:transition-none";
export const SETTINGS_SWITCH_THUMB_ON =
  "inline-block size-6 translate-x-[1.375rem] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform motion-reduce:transition-none rtl:-translate-x-[1.375rem]";
export const SETTINGS_SWITCH_THUMB_OFF =
  "inline-block size-6 translate-x-0.5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform motion-reduce:transition-none rtl:-translate-x-0.5";

/** The switch button: 44 px target, emerald focus ring. */
export const SETTINGS_SWITCH_BUTTON =
  "flex min-h-11 shrink-0 items-center gap-2 rounded-full px-1 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-60";
