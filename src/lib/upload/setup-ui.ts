// Upload-screen setup card rules (M13 T6, D-070). Pure: no React, no server imports.
//   - Feel (tone) and style follow the occasion until the user picks one (D-068). A stored value
//     that differs from the occasion's default (a remembered tone, an earlier pick) counts as picked.
//   - A shape/style change is only sent while the design is unlocked — the server refuses the whole
//     patch otherwise.
//   - Lock copy says why a control can't change any more.

import { DEFAULT_TONE, TONE_LABELS, type Occasion } from "@/lib/book/options";
import type { BookSetup, BookSetupPatch, SetupLockReason } from "@/lib/book/setup";
import { DESIGN_STYLE_LABELS, defaultStyleFor, FORMAT_SHORT_LABELS } from "@/lib/design/defaults";

export type SetupLocks = {
  /** Occasion / feel / caption language / title. */
  details: SetupLockReason | null;
  /** Page shape / style. */
  design: SetupLockReason | null;
};

export type SetupFollow = { manualTone: boolean; manualStyle: boolean };

export function initialFollow(setup: BookSetup): SetupFollow {
  return {
    manualTone: setup.tone !== DEFAULT_TONE[setup.occasion],
    manualStyle: setup.designStyle !== defaultStyleFor(setup.occasion),
  };
}

/** The patch for an occasion tap: occasion + the defaults that still follow it. */
export function occasionPatch(occasion: Occasion, follow: SetupFollow, locks: SetupLocks): BookSetupPatch {
  const patch: BookSetupPatch = { occasion };
  if (!follow.manualTone) patch.tone = DEFAULT_TONE[occasion];
  if (!follow.manualStyle && locks.design === null) patch.designStyle = defaultStyleFor(occasion);
  return patch;
}

/** Drops shape/style from a patch (retry after a user_edited design lock). */
export function withoutDesign(patch: BookSetupPatch): BookSetupPatch {
  const rest = { ...patch };
  delete rest.format;
  delete rest.designStyle;
  return rest;
}

export function hasFields(patch: BookSetupPatch): boolean {
  return Object.values(patch).some((v) => v !== undefined);
}

export const LOCK_COPY: Record<SetupLockReason, string> = {
  ai_started: "Your book is being made with these choices. You can still change the title, photos and captions in the editor.",
  user_edited: "Page shape and style are fixed because you've edited the book.",
};

/** Plain-English language names for the summary line (the chips show the native names). */
const LANG_WORDS = { en: "English", ar: "Arabic" } as const;

/** "Modern style · Portrait · English captions · Minimal feel". */
export function setupSummary(setup: BookSetup): string {
  return [
    `${DESIGN_STYLE_LABELS[setup.designStyle]} style`,
    FORMAT_SHORT_LABELS[setup.format],
    `${LANG_WORDS[setup.captionLang]} captions`,
    `${TONE_LABELS[setup.tone]} feel`,
  ].join(" · ");
}
