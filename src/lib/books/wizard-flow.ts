// The book wizard's flow model (M20 T3, D-072): one continuous 7-step wizard on /books/new
// (1 title, 2 purpose, 3 shape, 4 style, 5 photos, 6 sorting, 7 review → editor).
// Pure and client-safe: no React, no zod, no server imports (only erased type imports), so the
// first-load wizard island can use it. NewBookWizard applies the returned effects / intents:
//   - effect.kind "push" / "replace" → history.pushState / replaceState(url) (G1: never router.push);
//     a push may carry `replaceCurrent` = rewrite the current entry first (created → step-4 entry
//     becomes the edit URL, so browser Back re-opens THIS book, never an empty create wizard);
//     `preferHistoryBack` = a Back press; the component may use history.back() when the previous
//     entry is that step (keeps the stack tidy).
//   - effect.kind "reload" → location.reload() (URL mode ≠ wizard mode, M19 lesson on stale trees).
//   - effect.kind "navigate" → the one real navigation, to the editor.
//   - intent → server work the component must do (submit steps 1–4, ask for the auto build, …),
//     then dispatch the follow-up action (created, autoStart, …). The state does not move until then.
// Guardrails (G2): once a photo is picked steps 1–4 are locked; once a run started steps ≤5 are
// locked; once the build finished step 6 is locked too (a finished run never shows sorting again).
// A refused Back / popstate / stepper click leaves the state unchanged and replaces the URL with the
// current step. Steps above maxStep can't be entered via popstate / stepper. Tested in
// tests/m20-wizard-flow.test.ts.

import type { AutoStartOutcome } from "@/lib/upload/auto-build-client";
import type { RunLimit } from "@/lib/runs/client";

/** 1 title, 2 purpose, 3 shape, 4 style, 5 photos, 6 sorting, 7 review. */
export type FlowStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const FLOW_STEP_COUNT = 7;
/** Last step of the book form (the book is created / saved on its Continue). */
export const FLOW_FORM_LAST_STEP = 4;

export type FlowMode = { kind: "create" } | { kind: "edit"; bookId: string };

/** Why the build on step 6 stopped (BuildProgress stop states, grouped). */
export type BuildStopReason = "failed" | "user_edited" | "limit" | "signed_out" | "not_found" | "unavailable";

/** Step 5 couldn't start the build automatically → show the "Make my book now" fallback. */
export type AutoStartError = { kind: "fallback"; limit?: RunLimit };

export type FlowState = {
  mode: FlowMode;
  step: FlowStep;
  /** Highest step reached; popstate / stepper can't go above it. */
  maxStep: FlowStep;
  /** A photo was picked on step 5 (locks steps 1–4). */
  photosPicked: boolean;
  /** The first build run exists (locks steps ≤5). */
  runStarted: boolean;
  /** The build finished (locks step 6 too; step 7 = review). */
  done: boolean;
  /** Step 6 only: the build stopped (the component shows the stop copy + editor link). */
  stop: BuildStopReason | null;
  /** Step 5 only: auto start failed → fallback button. */
  autoStartError: AutoStartError | null;
};

export type FlowAction =
  | { type: "continue" }
  | { type: "back" }
  /** Browser back / forward: the step (raw ?step= value) and ?book= of the URL now shown. */
  | { type: "popstate"; step: unknown; bookId?: string | null }
  /** Stepper click. */
  | { type: "goTo"; step: FlowStep }
  /** createBookAction (create) or updateBookSetupAction (edit) succeeded on step 4. */
  | { type: "created"; bookId: string }
  | { type: "photosPicked" }
  /** Uploads + finalize on step 5 settled (ready to ask for the auto build). */
  | { type: "uploadsSettled" }
  /** The answer of POST /api/ai/runs { auto: true } (requestAutoBuild). */
  | { type: "autoStart"; outcome: AutoStartOutcome; retried: boolean; activeAtLoad: boolean }
  /**
   * M20b: the upload success moment ended while the auto-start answer was still on its way → step 6
   * now (step 5 never shows sorting); step 6 receives the pending answer and follows it there.
   */
  | { type: "autoStartPending" }
  /** Fallback "Make my book now" on step 5 → step 6, where BuildProgress starts the run (G3). */
  | { type: "buildRequested" }
  /** BuildProgress has a run (started or resumed). */
  | { type: "runStarted" }
  | { type: "buildDone" }
  | { type: "buildStopped"; reason: BuildStopReason }
  /** Step 6: the build runs again after a stop ("Try again" / auto-resume) → clears the stop flag. */
  | { type: "buildResumed" }
  /** confirmAlbumAction succeeded on step 7. */
  | { type: "confirm" };

export type FlowEffect =
  | { kind: "none" }
  | { kind: "push"; url: string; replaceCurrent?: string; preferHistoryBack?: boolean }
  | { kind: "replace"; url: string }
  | { kind: "reload" }
  | { kind: "navigate"; target: "editor"; href: string };

export type FlowIntent =
  /** Step-4 Continue: create the book (create mode) or save its setup (edit mode), then dispatch created. */
  | { kind: "submit"; mode: FlowMode }
  /** Step 5: ask for the automatic build (requestAutoBuild), then dispatch autoStart. */
  | { kind: "autoStart"; bookId: string }
  /** not_ready: ask once more after `afterMs`, then dispatch autoStart with retried: true. */
  | { kind: "retryAutoStart"; bookId: string; afterMs: number }
  /** Step 7 Continue: confirm the album (confirmAlbumAction), then dispatch confirm. */
  | { kind: "confirm"; bookId: string };

export type FlowResult = {
  state: FlowState;
  effect: FlowEffect;
  intent?: FlowIntent;
  /** The action was a navigation the guardrails / maxStep refused. */
  refused?: boolean;
};

/** Mirrors NOT_READY_RETRY_MS in auto-build-client (kept local: that module isn't type-only). */
export const AUTO_START_RETRY_MS = 3_000;

const NONE: FlowEffect = { kind: "none" };

// ---- URLs -----------------------------------------------------------------------------------------

export function urlForStep(mode: FlowMode, step: FlowStep): string {
  if (mode.kind === "create") return `/books/new?step=${step}`;
  return `/books/new?book=${encodeURIComponent(mode.bookId)}&step=${step}`;
}

/** "/books/new?step=N" (create) or "/books/new?book=<id>&step=N" (edit). */
export function urlFor(state: FlowState): string {
  return urlForStep(state.mode, state.step);
}

export function flowEditorHref(bookId: string): string {
  return `/books/${bookId}/edit`;
}

/** A ?step= value → 1..7, or null (exact "1"–"7" / integer only; first value of an array). */
export function parseFlowStep(raw: unknown): FlowStep | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= FLOW_STEP_COUNT) return v as FlowStep;
  if (typeof v === "string" && /^[1-7]$/.test(v)) return Number(v) as FlowStep;
  return null;
}

// ---- state ----------------------------------------------------------------------------------------

const maxOf = (a: FlowStep, b: FlowStep): FlowStep => (a >= b ? a : b);

/**
 * The state for a (hard) load. Create mode is clamped to steps 1–4 (no book yet). Edit mode with
 * step 5–7: pass what the server knows (photos already uploaded, run exists, run finished); flags
 * imply each other (done ⇒ runStarted ⇒ step ≥ 6) and the step is lifted past locked steps.
 */
export function initFlowState(input: {
  bookId?: string | null;
  step: FlowStep;
  photosPicked?: boolean;
  runStarted?: boolean;
  done?: boolean;
}): FlowState {
  if (!input.bookId) {
    const step = (input.step > FLOW_FORM_LAST_STEP ? FLOW_FORM_LAST_STEP : input.step) as FlowStep;
    return { ...blank({ kind: "create" }), step, maxStep: step };
  }
  const done = !!input.done;
  const runStarted = done || !!input.runStarted;
  const photosPicked = runStarted || !!input.photosPicked;
  let step = input.step;
  if (done) step = 7;
  else if (runStarted && step < 6) step = 6;
  else if (photosPicked && step < 5) step = 5;
  // Edit mode: steps 1–4 are answered (the book exists); 5 is reached via Continue (save) or load.
  const maxStep = maxOf(step, step >= 5 ? step : FLOW_FORM_LAST_STEP);
  return { ...blank({ kind: "edit", bookId: input.bookId }), step, maxStep, photosPicked, runStarted, done };
}

function blank(mode: FlowMode): FlowState {
  return {
    mode,
    step: 1,
    maxStep: 1,
    photosPicked: false,
    runStarted: false,
    done: false,
    stop: null,
    autoStartError: null,
  };
}

/** True when a guardrail locks `step` (G2). */
export function isStepLocked(state: FlowState, step: FlowStep): boolean {
  if (state.done && step <= 6) return true;
  if (state.runStarted && step <= 5) return true;
  if (state.photosPicked && step <= 4) return true;
  return false;
}

/** Steps a browser entry may show: reached, not locked, and 5+ only once the book exists. */
function canShow(state: FlowState, step: FlowStep): boolean {
  if (step > state.maxStep) return false;
  if (step >= 5 && state.mode.kind === "create") return false;
  return !isStepLocked(state, step);
}

/**
 * Stepper: may this step be clicked? Not the current one; reached and unlocked; and never forward
 * from the form (steps 1–4) into 5+ — that must go through step-4 Continue so edits are saved.
 */
export function canGoTo(state: FlowState, step: FlowStep): boolean {
  if (step === state.step) return false;
  if (step >= 5 && state.step <= FLOW_FORM_LAST_STEP) return false;
  return canShow(state, step);
}

/** Move to a step: clears per-step flags, raises maxStep. */
function moveTo(state: FlowState, step: FlowStep): FlowState {
  return { ...state, step, maxStep: maxOf(state.maxStep, step), stop: null, autoStartError: null };
}

function refuse(state: FlowState): FlowResult {
  return { state, effect: { kind: "replace", url: urlFor(state) }, refused: true };
}

const bookIdOf = (mode: FlowMode): string | null => (mode.kind === "edit" ? mode.bookId : null);

// ---- transitions ----------------------------------------------------------------------------------

export function transition(state: FlowState, action: FlowAction): FlowResult {
  switch (action.type) {
    case "continue": {
      const s = state.step;
      if (s < FLOW_FORM_LAST_STEP) {
        const next = moveTo(state, (s + 1) as FlowStep);
        return { state: next, effect: { kind: "push", url: urlFor(next) } };
      }
      if (s === FLOW_FORM_LAST_STEP) return { state, effect: NONE, intent: { kind: "submit", mode: state.mode } };
      const bookId = bookIdOf(state.mode);
      if (s === 5 && bookId && state.photosPicked && !state.runStarted) {
        return { state, effect: NONE, intent: { kind: "autoStart", bookId } };
      }
      if (s === 7 && bookId && state.done) return { state, effect: NONE, intent: { kind: "confirm", bookId } };
      return { state, effect: NONE }; // step 6 advances on its own; step 5 needs photos
    }

    case "back": {
      if (state.step === 1) return { state, effect: NONE }; // step 1 Back is a server-rendered link
      const prev = (state.step - 1) as FlowStep;
      if (!canShow(state, prev)) return refuse(state);
      const next = moveTo(state, prev);
      return { state: next, effect: { kind: "push", url: urlFor(next), preferHistoryBack: true } };
    }

    case "popstate": {
      const urlBook = action.bookId ?? null;
      const ours = bookIdOf(state.mode);
      // The URL names another book, or a book while we're still creating: a stale tree → reload.
      if (urlBook !== null && urlBook !== ours) return { state, effect: { kind: "reload" } };
      const step = parseFlowStep(action.step);
      if (step === null || !canShow(state, step)) return refuse(state);
      const next = step === state.step ? state : moveTo(state, step);
      // An old create-mode entry (steps 1–3 before the book existed) → show it as the edit URL.
      const effect: FlowEffect = urlBook === ours ? NONE : { kind: "replace", url: urlFor(next) };
      return { state: next, effect };
    }

    case "goTo": {
      if (action.step === state.step) return { state, effect: NONE };
      if (!canGoTo(state, action.step)) return refuse(state);
      const next = moveTo(state, action.step);
      return { state: next, effect: { kind: "push", url: urlFor(next) } };
    }

    case "created": {
      if (state.step > FLOW_FORM_LAST_STEP) return { state, effect: NONE }; // late / duplicate answer
      const mode: FlowMode = { kind: "edit", bookId: action.bookId };
      const next = moveTo({ ...state, mode }, 5);
      return {
        state: next,
        effect: { kind: "push", url: urlFor(next), replaceCurrent: urlForStep(mode, FLOW_FORM_LAST_STEP) },
      };
    }

    case "photosPicked": {
      if (state.step !== 5 || state.photosPicked) return { state, effect: NONE };
      return { state: { ...state, photosPicked: true }, effect: NONE };
    }

    case "uploadsSettled": {
      const bookId = bookIdOf(state.mode);
      if (state.step !== 5 || !bookId || !state.photosPicked || state.runStarted) return { state, effect: NONE };
      return { state: { ...state, autoStartError: null }, effect: NONE, intent: { kind: "autoStart", bookId } };
    }

    case "autoStart":
      return autoStart(state, action);

    case "autoStartPending": {
      if (state.step !== 5 || state.mode.kind !== "edit" || state.runStarted) return { state, effect: NONE };
      // Same lock as buildRequested: step 6 owns the (pending) run now, step 5 can't come back.
      const next = moveTo({ ...state, runStarted: true, photosPicked: true }, 6);
      return { state: next, effect: { kind: "push", url: urlFor(next) } };
    }

    case "buildRequested": {
      if (state.step !== 5 || state.mode.kind !== "edit") return { state, effect: NONE };
      // Step 6 always starts or resumes a run (G3), so step 5 locks now: Back / the stepper can't
      // return to a stale step 5 (and a second "Make my book now" → 409) while the run is starting.
      const next = moveTo({ ...state, runStarted: true, photosPicked: true }, 6);
      return { state: next, effect: { kind: "push", url: urlFor(next) } };
    }

    case "runStarted": {
      if (state.mode.kind !== "edit" || state.step < 5 || state.done) return { state, effect: NONE };
      const flagged: FlowState = { ...state, runStarted: true, photosPicked: true };
      if (state.step === 6) return { state: { ...flagged, maxStep: maxOf(state.maxStep, 6) }, effect: NONE };
      if (state.step === 5) {
        const next = moveTo(flagged, 6);
        return { state: next, effect: { kind: "push", url: urlFor(next) } };
      }
      return { state: flagged, effect: NONE };
    }

    case "buildDone": {
      if (state.mode.kind !== "edit" || state.step < 5) return { state, effect: NONE };
      const next = moveTo({ ...state, runStarted: true, photosPicked: true, done: true }, 7);
      if (state.step === 7) return { state: next, effect: NONE };
      // Sorting is transient: replace it, so Back from review never re-shows a finished run.
      return { state: next, effect: { kind: "replace", url: urlFor(next) } };
    }

    case "buildStopped": {
      if (state.step !== 6) return { state, effect: NONE };
      return { state: { ...state, stop: action.reason }, effect: NONE };
    }

    case "buildResumed": {
      if (state.step !== 6 || state.stop === null) return { state, effect: NONE };
      return { state: { ...state, stop: null }, effect: NONE };
    }

    case "confirm": {
      const bookId = bookIdOf(state.mode);
      if (state.step !== 7 || !bookId) return { state, effect: NONE };
      return { state, effect: { kind: "navigate", target: "editor", href: flowEditorHref(bookId) } };
    }
  }
}

/** useReducer-friendly: the next state only (effects / intents dropped). */
export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  return transition(state, action).state;
}

/**
 * The auto-start answer on step 5 → the wizard's next place (mirrors autoStartNext in
 * auto-build-client, with wizard targets): a run → step 6 — in every AI mode, including a rule run
 * (AI off) that already finished inside the POST: step 6 plays its sorting checklist through, then
 * step 7 Review (M20b; the editor jump is gone); the first run already finished elsewhere → step 7;
 * the user edited → editor (the only editor exit); not_ready → retry once, then the fallback;
 * limit / signed out / error → stay on 5 with the fallback.
 */
function autoStart(
  state: FlowState,
  action: Extract<FlowAction, { type: "autoStart" }>,
): FlowResult {
  const bookId = bookIdOf(state.mode);
  if (state.step !== 5 || !bookId || state.runStarted) return { state, effect: NONE };
  const toSorting = (): FlowResult => {
    const next = moveTo({ ...state, runStarted: true, photosPicked: true }, 6);
    return { state: next, effect: { kind: "push", url: urlFor(next) } };
  };
  const toEditor = (): FlowResult => ({
    state,
    effect: { kind: "navigate", target: "editor", href: flowEditorHref(bookId) },
  });
  const fallback = (limit?: RunLimit): FlowResult => ({
    state: { ...state, autoStartError: limit ? { kind: "fallback", limit } : { kind: "fallback" } },
    effect: NONE,
  });
  const { outcome } = action;
  switch (outcome.kind) {
    case "started":
    case "already_running":
      return toSorting();
    case "not_first": {
      if (action.activeAtLoad) return toSorting();
      // The first run already finished (another tab / an earlier visit) → review it.
      const next = moveTo({ ...state, runStarted: true, photosPicked: true, done: true }, 7);
      return { state: next, effect: { kind: "replace", url: urlFor(next) } };
    }
    case "user_edited":
      return toEditor();
    case "not_ready":
      return action.retried
        ? fallback()
        : { state, effect: NONE, intent: { kind: "retryAutoStart", bookId, afterMs: AUTO_START_RETRY_MS } };
    case "limit":
      return fallback(outcome.limit);
    case "signed_out":
    case "error":
      return fallback();
  }
}
