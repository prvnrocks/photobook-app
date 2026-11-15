// Share page recipes used only by server-rendered parts (M21; split out of share-classes.ts in T5):
// the ShareBand status chip tones, the band's back link, the preview's "Open flipbook" link and the
// body container. Kept apart from share-classes.ts (the client islands' recipes) so the chip tables
// never ride along in the share page's client bundle. Plain strings, no "use client", no cn.
//
// Status chip tones sit on the emerald leather band. Each chip has a solid background, so its text
// contrast doesn't depend on where the leather's noise/glow lands; the text also clears 4.5:1 on the
// leather's lightest point #1f5443 should the chip background ever be dropped. Measured
// (tests/share-band.test.tsx recomputes every pair):
//   draft    #d7cdb9 on #143f33  7.45   (on #1f5443 5.53)
//   live     #9ee6bd on #0f3a2d  8.72   (on #1f5443 6.03)
//   expiring #f3c969 on #2f2a14  9.14   (on #1f5443 5.55)
//   expired  same amber as expiring
//   paid     #1b1b1d on foil fill, darkest stop #bf9a23 6.44 (lightest #ddc163 9.73)

export type ShareChipKind = "draft" | "live" | "expiring" | "expired" | "paid";

export const SHARE_CHIP_KINDS: readonly ShareChipKind[] = ["draft", "live", "expiring", "expired", "paid"];

/** The leather's lightest point (globals.css home-leather glow over #0e3b2e). */
export const SHARE_LEATHER_LIGHTEST = "#1f5443";

/**
 * Colour data behind each chip, so tests can check contrast numerically. `bg` is the darkest stop
 * the text ever sits on for the foil (worst case); `dot` is the leading status dot (graphic ≥ 3:1).
 */
export const SHARE_CHIP_TONES: Record<ShareChipKind, { text: string; bg: string; dot: string }> = {
  draft: { text: "#d7cdb9", bg: "#143f33", dot: "#9fb3a6" },
  live: { text: "#9ee6bd", bg: "#0f3a2d", dot: "#7fd6a6" },
  expiring: { text: "#f3c969", bg: "#2f2a14", dot: "#f3c969" },
  expired: { text: "#f3c969", bg: "#2f2a14", dot: "#f3c969" },
  paid: { text: "#1b1b1d", bg: "#bf9a23", dot: "#1b1b1d" },
};

/** Shared chip shape: one line, 32 px tall (not a target — chips are status, never buttons). */
export const SHARE_CHIP_BASE =
  "inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-full border px-3 text-sm leading-none font-semibold whitespace-nowrap";

/** Per-kind colours (literal classes so Tailwind sees them). Hex values mirror SHARE_CHIP_TONES. */
export const SHARE_CHIP_TONE: Record<ShareChipKind, string> = {
  draft: "border-[#9fb3a6]/45 bg-[#143f33] text-[#d7cdb9]",
  live: "border-[#7fd6a6]/50 bg-[#0f3a2d] text-[#9ee6bd]",
  expiring: "border-[#f3c969]/50 bg-[#2f2a14] text-[#f3c969]",
  expired: "border-[#f3c969]/50 bg-[#2f2a14] text-[#f3c969]",
  paid: "home-foil-fill border-[#f0dc94]/60 text-[#1b1b1d] shadow-[inset_0_1px_0_rgb(255_255_255/0.35)]",
};

export const SHARE_CHIP_DOT: Record<ShareChipKind, string> = {
  draft: "bg-[#9fb3a6]",
  live: "bg-[#7fd6a6]",
  expiring: "bg-[#f3c969]",
  expired: "bg-[#f3c969]",
  paid: "bg-[#1b1b1d]",
};

/** "Back to editor" on the leather band: cream-muted text, 44 px target, cream focus ring. */
export const SHARE_BACK_LINK =
  "-ms-2 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-[#d7cdb9] outline-none hover:text-[#f2e8d8] focus-visible:ring-2 focus-visible:ring-[#f2e8d8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e3b2e]";

/** "Open flipbook" on the preview tile: emerald text link with a 44 px target. */
export const SHARE_OPEN_LINK =
  "inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-[#0e3b2e] underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-2";

/** Width + gutters of the share page body: the My books container. */
export const SHARE_BODY = "mx-auto w-full max-w-library px-gutter sm:px-6 lg:px-10";

/**
 * Chip colour for a shareStatus() result (src/lib/publish/status.ts, M21 T1), typed structurally so
 * this module stays import-free. Its `kind` adds "changes" (unpublished edits — picks the action
 * card); the chip then keeps the book's standing, which its chip text tells: "Paid · permanent" →
 * paid, "Expires in N days" → expiring, otherwise live.
 */
export function shareChipKind(status: { kind: string; chip: string }): ShareChipKind {
  if (status.kind === "changes") {
    if (status.chip.startsWith("Paid")) return "paid";
    if (status.chip.startsWith("Expires")) return "expiring";
    return "live";
  }
  return (SHARE_CHIP_KINDS as readonly string[]).includes(status.kind) ? (status.kind as ShareChipKind) : "draft";
}
