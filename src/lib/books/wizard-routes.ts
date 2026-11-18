// Which entry points lead into the creation wizard (M19 T6/T7 D-071; M20 T9 D-072; Task 5 order).
// Pure: no React, no server imports — shared by the upload/build pages, createBookAction and their tests.
// Steps 3–7 live inside /books/new (?book=<id>&step=3…7: 3 Photos, 4 Story, 5 Design, 6 Create,
// 7 Preview); /books/[id]/upload and /books/[id]/build redirect fresh books there
// (uploadEntryRedirect / buildEntryRedirect) and keep the classic screens for everything else.

import { docOrigin } from "@/lib/book/replaceable";
import type { SetupLockReason } from "@/lib/book/setup";
import type { FirstRunState } from "@/lib/upload/auto-build-client";
import { resolveWizardStep } from "./wizard-gate";

/**
 * Step 3 ("Add your photos") = a fresh book: no AI run yet and its setup still editable (the old
 * setup card's rule). Adding photos to a built / edited book keeps the classic chrome.
 */
export function isWizardUpload(firstRun: FirstRunState, detailsLock: SetupLockReason | null): boolean {
  return firstRun === "none" && detailsLock === null;
}

/**
 * Step 6 ("Sorting your photos") = the first build: not a rebuild, and the album is neither
 * user-edited nor already AI-made (docOrigin; an unparsable doc counts as edited). M20b: AI on or
 * off — with AI off the first build is the rule build and runs in the wizard too. Rebuilds keep the
 * classic build screen. `aiOn` is informational (kept for callers).
 */
export function isWizardBuild(input: { trigger: "build" | "rebuild"; aiOn?: boolean; doc: unknown }): boolean {
  if (input.trigger === "rebuild") return false;
  const origin = docOrigin(input.doc);
  return !origin.userEdited && origin.generator !== "ai";
}

/** The wizard's in-place steps for an existing book (3 Photos, 4 Story, 5 Design, 6 Create, 7 Preview). */
export type WizardEntryStep = 3 | 4 | 5 | 6 | 7;

/** /books/new?book=<id>&step=3…7 (+ &auto=1: the design step started the automatic first build). */
export function wizardStepHref(bookId: string, step: WizardEntryStep, opts: { auto?: boolean } = {}): string {
  return `/books/new?book=${encodeURIComponent(bookId)}&step=${step}${opts.auto ? "&auto=1" : ""}`;
}

/**
 * /books/[id]/upload: a fresh wizard book → step 3 inside the wizard; null = classic upload screen.
 * A confirmed book (M20c: "Generate album" ran) always keeps the classic screen ("add more photos").
 */
export function uploadEntryRedirect(input: {
  bookId: string;
  firstRun: FirstRunState;
  detailsLock: SetupLockReason | null;
  /** books.album_confirmed_at is set. */
  albumConfirmed: boolean;
}): string | null {
  if (input.albumConfirmed) return null;
  return isWizardUpload(input.firstRun, input.detailsLock) ? wizardStepHref(input.bookId, 3) : null;
}

/** Everything /books/[id]/build knows when deciding (the reads mirror loadWizardStep(6)). */
export type BuildEntryInput = {
  bookId: string;
  /** ?trigger=rebuild ("Try AI again") → "rebuild"; anything else → "build". */
  trigger: "build" | "rebuild";
  /** ?auto=1 — the wizard started the automatic first build. */
  auto: boolean;
  /** resolveAiMode() !== "off". */
  aiOn: boolean;
  /** books.doc. */
  doc: unknown;
  /** detailsLockReason({ hasRun, doc }) with hasRun = runExists || active. */
  detailsLock: SetupLockReason | null;
  /** albumEditedByUser(books.doc) (editor save, user caption / background). */
  userEdited: boolean;
  /** The active-run read succeeded (false = unknown, ≠ "no run"). */
  activeReadOk: boolean;
  /** The active build run, when the read succeeded and one exists. */
  active: { trigger: "build" | "rebuild" } | null;
  /** hasAnyRunForBook — null when that read failed. */
  runExists: boolean | null;
  /** books.album_confirmed_at is set (M20c): the gate answers "editor" → never the wizard. */
  albumConfirmed: boolean;
};

/** Where /books/[id]/build goes: a wizard step URL, the editor, or render the classic screen. */
export type BuildEntryTarget = { kind: "wizard"; href: string } | { kind: "editor" } | { kind: "classic" };

/**
 * /books/[id]/build entry (M20 T9, D-072). First match wins:
 *  1. rebuild (?trigger=rebuild, "Try AI again") or a running rebuild → never the wizard: a finished
 *     ?auto=1 link opens the editor (M13 rule), otherwise the classic screen. M20b: AI off is no
 *     longer here — a first rule build goes through the wizard's steps 6 / 7 like an AI build.
 *  2. ?auto=1 and confirmed "no active run" (the automatic first build already ended): the gate's
 *     Review (7) → wizard step 7, anything else → the editor (as before M20).
 *  3. not a fresh first build (isWizardBuild: AI-made / edited album) → classic.
 *  4. the gate for step 6 (same inputs as loadWizardStep(6)) answers 6 → wizard step 6 (&auto=1 kept);
 *     any other answer (7 / editor / classic) → classic, exactly as before M20.
 * M20c: a confirmed book makes the gate answer "editor" → 2. the editor, 4. classic — never the wizard.
 *
 * No loop with /books/new: its gate answers "classic" (→ /books/<id>/build, no query) only for a
 * running rebuild — rule 1 here — and for the same reads rule 4 only redirects when the gate answers
 * 6, which /books/new then renders.
 */
export function buildEntryRedirect(input: BuildEntryInput): BuildEntryTarget {
  const finishedAuto = input.auto && input.activeReadOk && input.active === null;
  if (input.trigger === "rebuild" || input.active?.trigger === "rebuild") {
    return finishedAuto ? { kind: "editor" } : { kind: "classic" };
  }
  const target = resolveWizardStep({
    requested: finishedAuto ? 7 : 6,
    hasRun: input.runExists === true || input.active !== null,
    active: input.active !== null,
    activeTrigger: input.active?.trigger ?? null,
    readError: !input.activeReadOk || input.runExists === null,
    detailsLock: input.detailsLock,
    docOrigin: { generator: docOrigin(input.doc).generator, userEdited: input.userEdited },
    albumConfirmed: input.albumConfirmed,
    aiOn: input.aiOn,
  });
  if (finishedAuto) {
    return target === 7 ? { kind: "wizard", href: wizardStepHref(input.bookId, 7) } : { kind: "editor" };
  }
  if (!isWizardBuild({ trigger: input.trigger, aiOn: input.aiOn, doc: input.doc })) return { kind: "classic" };
  if (target === 6) return { kind: "wizard", href: wizardStepHref(input.bookId, 6, { auto: input.auto }) };
  return { kind: "classic" };
}

/**
 * M20 T1 (G2 + G3): which step a hard load may show. Lives in the dependency-free ./wizard-gate
 * (client islands import it from there — this module pulls in docOrigin / zod).
 */
export {
  albumConfirmedOf,
  resolveWizardStep,
  type WizardDetailsLock,
  type WizardGateInput,
  type WizardRequestStep,
  type WizardTarget,
} from "./wizard-gate";
