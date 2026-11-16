// Login form class recipes (M25, D-077): the emerald leather / cream / gold language of the viewer's
// message screens (viewer-classes.ts) applied to the /login sign-in card.
// Plain strings in a plain module: no "use client", no imports (no cn, no buttonVariants, no
// next/link), so LoginForm's first-load island pays nothing for them (lessons M17–M24). Join with cx.
// Only LoginForm's recipes live here — the server page keeps its own classes inline, so nothing
// page-only ships to the client.
//
// Rules baked into these strings (M25 guardrails, .agentos/runs/m25.md):
// - 44 px+ targets: every button and field is h-12 (48 px).
// - The card is #fffdf8 (set in src/app/login/page.tsx). Text contrast ≥ 4.5:1 and the field
//   hairline ≥ 3:1 — every pair is listed and recomputed in tests/m25-login.test.tsx.
// - One gold per state: LG_CTA_GOLD is the email step's "Email me a sign-in link" and the code step's
//   "Sign in with code" (never both on screen). Google and Resend are the emerald outline.
// - Motion: colour / filter / box-shadow transitions only, each with motion-reduce:transition-none;
//   no transforms.
// - Alternating recipes are complete strings: use one OR the other, never both (cx doesn't merge
//   conflicting utilities) — LG_INPUT vs LG_CODE_INPUT.

/** Field label: ink 16.92:1 on the card. */
export const LG_LABEL = "text-sm font-semibold text-[#1b1b1d]";

/**
 * Email field: ivory #faf5ec, ink text, #8c8270 hairline (non-text ≥ 3:1), placeholder #6b665c (5.25:1),
 * emerald focus ring, red border when aria-invalid. 48 px, 16 px text (no iOS zoom).
 */
export const LG_INPUT =
  "h-12 w-full min-w-0 rounded-xl border border-[#8c8270] bg-[#faf5ec] px-4 text-base text-[#1b1b1d] outline-none placeholder:text-[#6b665c] transition-[box-shadow,border-color] focus-visible:border-[#0e3b2e] focus-visible:ring-[3px] focus-visible:ring-[#0e3b2e]/30 aria-invalid:border-[#b42318] motion-reduce:transition-none";

/** The 6-digit code field: LG_INPUT's look, centred mono digits. Use instead of (not with) LG_INPUT. */
export const LG_CODE_INPUT =
  "h-12 w-full min-w-0 rounded-xl border border-[#8c8270] bg-[#faf5ec] px-4 text-center font-mono text-lg tracking-[0.3em] text-[#1b1b1d] outline-none transition-[box-shadow,border-color] focus-visible:border-[#0e3b2e] focus-visible:ring-[3px] focus-visible:ring-[#0e3b2e]/30 aria-invalid:border-[#b42318] motion-reduce:transition-none";

/**
 * The state's ONE gold action: foil fill, ink 6.44:1 on its darkest stop, emerald focus ring offset
 * on the card (gold is fill-only on light). Full width, 48 px. No press transform.
 */
export const LG_CTA_GOLD =
  "home-foil-fill inline-flex h-12 w-full items-center justify-center gap-2 rounded-full px-5 font-brand text-base font-semibold text-[#1b1b1d] shadow-[0_12px_24px_-14px_rgb(0_0_0/0.65),inset_0_1px_0_rgb(255_255_255/0.4)] transition-[filter] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#fffdf8] active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/** Emerald outline action (Google, Resend): emerald 12.27:1 on the card, hover mint. Full width, 48 px. */
export const LG_CTA_OUTLINE =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border-2 border-[#0e3b2e] bg-transparent px-5 text-base font-semibold text-[#0e3b2e] transition-colors outline-none hover:bg-[#e6efe9] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#fffdf8] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

/** Quiet text action ("Use a different email"): emerald, mint on hover, 48 px. */
export const LG_CTA_GHOST =
  "inline-flex h-12 w-full items-center justify-center rounded-full px-4 text-base font-semibold text-[#0e3b2e] transition-colors outline-none hover:bg-[#e6efe9] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2 focus-visible:ring-offset-[#fffdf8] motion-reduce:transition-none";

/** "or" divider row (aria-hidden): ink-soft 9.11:1 on the card. */
export const LG_DIVIDER = "flex items-center gap-3 text-sm text-[#4a4740]";

/** The divider's hairlines (decorative). */
export const LG_DIVIDER_LINE = "h-px flex-1 bg-[#e3d8c3]";

/** Small help text (WhatsApp hint): ink-soft 9.11:1 on the card. */
export const LG_HINT = "text-xs leading-relaxed text-[#4a4740]";

/** "Check your email" soft card: mint, emerald hairline; ink text 14.65:1 on mint. */
export const LG_SENT_CARD = "flex items-start gap-3 rounded-2xl border border-[#c5dccd] bg-[#e6efe9] p-4 text-[#1b1b1d]";

/** The sent card's icon (decorative): emerald. */
export const LG_SENT_ICON = "mt-0.5 size-5 shrink-0 text-[#0e3b2e]";
