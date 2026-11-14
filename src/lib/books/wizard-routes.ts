// Which screens wear the creation-wizard chrome (M19 T6/T7, D-071). Pure: no React, no server
// imports — shared by the upload/build pages and their tests.

import { docOrigin } from "@/lib/book/replaceable";
import type { SetupLockReason } from "@/lib/book/setup";
import type { FirstRunState } from "@/lib/upload/auto-build-client";

/**
 * Step 5 ("Add your photos") = a fresh book: no AI run yet and its setup still editable (the old
 * setup card's rule). Adding photos to a built / edited book keeps the classic chrome.
 */
export function isWizardUpload(firstRun: FirstRunState, detailsLock: SetupLockReason | null): boolean {
  return firstRun === "none" && detailsLock === null;
}

/** Step 5 Back: re-opens steps 1–4 for this book (the /books/new edit mode). Defined in wizard-steps. */
export { wizardBackHref } from "./wizard-steps";

/**
 * Step 6 ("Sorting your photos") = the first AI build: not a rebuild, AI on, and the album is
 * neither user-edited nor already AI-made (docOrigin; an unparsable doc counts as edited).
 * Rebuilds and AI-off keep the classic build screen.
 */
export function isWizardBuild(input: { trigger: "build" | "rebuild"; aiOn: boolean; doc: unknown }): boolean {
  if (input.trigger === "rebuild" || !input.aiOn) return false;
  const origin = docOrigin(input.doc);
  return !origin.userEdited && origin.generator !== "ai";
}
