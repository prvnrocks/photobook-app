// The book wizard's flow model (M20 T3, D-072; re-derived for the Task 5 order): one continuous
// 7-step wizard on /books/new —
//   1 title, 2 occasion   the pre-book form (client draft). Step-2 Continue creates the book with a
//                         provisional design (default shape + the occasion's style); with a book
//                         (edit mode) it saves title / occasion instead.
//   3 photos              the book exists. Upload only: NO build starts here any more.
//   4 story               optional answers ("What makes this memory special?"); the step saves itself.
//   5 design              page shape + book style (recommended, never forced). Its Continue saves the
//                         design and asks for the first build → 6.
//   6 create (the build), 7 preview → editor.
// Pure and client-safe: no React, no zod, no server imports (only erased type imports), so the
// first-load wizard island can use it. NewBookWizard applies the returned effects / intents:
//   - effect.kind "push" / "replace" → history.pushState / replaceState(url) (G1: never router.push);
//     a push may carry `replaceCurrent` = rewrite the current entry first (created → the step-2 entry
//     becomes the edit URL, so browser Back re-opens THIS book, never an empty create wizard);
//     `preferHistoryBack` = a Back press; the component may use history.back() when the previous
//     entry is that step (keeps the stack tidy).
//   - effect.kind "reload" → location.reload() (URL mode ≠ wizard mode, M19 lesson on stale trees).
//   - effect.kind "navigate" → the one real navigation, to the editor.
//   - intent → server work the component must do (submit steps 1–2, save the design + ask for the
//     build, confirm), then dispatch the follow-up action (created, autoStart, …). The state does not
//     move until then.
// Guardrails (G2): once a photo is picked steps 1–2 are locked (the occasion drives the story
// questions); steps 3–5 stay open — Back / Forward freely — until a build run starts; once a run
// started steps ≤5 are locked; once the build finished step 6 is locked too (a finished run never
// shows the build again). While photos are uploading the wizard stays on step 3 (leaving would cancel
// the upload). A refused Back / popstate / stepper click leaves the state unchanged and replaces the
// URL with the current step. Steps above maxStep can't be entered via popstate / stepper. Tested in
// tests/m20-wizard-flow.test.ts.

import type { AutoStartOutcome } from "@/lib/upload/auto-build-client";
import type { RunLimit } from "@/lib/runs/client";

/** 1 title, 2 occasion, 3 photos, 4 story, 5 design, 6 create, 7 preview. */
export type FlowStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const FLOW_STEP_COUNT = 7;
/** Last step of the pre-book form (the book is created / its title + occasion saved on its Continue). */
export const FLOW_FORM_LAST_STEP = 2;
/** First step that needs the book. */
export const FLOW_PHOTOS_STEP = 3;
export const FLOW_STORY_STEP = 4;
/** The last open step: its Continue saves the design and asks for the first build. */
export const FLOW_DESIGN_STEP = 5;
export const FLOW_BUILD_STEP = 6;
export const FLOW_REVIEW_STEP = 7;

export type FlowMode = { kind: "create" } | { kind: "edit"; bookId: string };

/** Why the build on step 6 stopped (BuildProgress stop states, grouped). */
export type BuildStopReason = "failed" | "user_edited" | "limit" | "signed_out" | "not_found" | "unavailable";

/** Step 5 asked for the build and no run came of it → the step shows why; Continue asks again. */
export type AutoStartError = { kind: "fallback"; limit?: RunLimit };

export type FlowState = {
  mode: FlowMode;
  step: FlowStep;
  /** Highest step reached; popstate / stepper can't go above it. */
  maxStep: FlowStep;
  /** A photo was picked on step 3, or the book already has photos (locks steps 1–2). */
  photosPicked: boolean;
  /** Step 3 only: an upload is running (the wizard stays on step 3 until it settles). */
  uploading: boolean;
  /** The first build run exists / was asked for (locks steps ≤5). */
  runStarted: boolean;
  /** The build finished (locks step 6 too; step 7 = preview). */
  done: boolean;
  /** Step 6 only: the build stopped (the component shows the stop copy + editor link). */
  stop: BuildStopReason | null;
  /** Step 5 only: the build request was refused (limit / signed out / error). */
  autoStartError: AutoStartError | null;
};

export type FlowAction =
  | { type: "continue" }
  | { type: "back" }
  /** Browser back / forward: the step (raw ?step= value) and ?book= of the URL now shown. */
  | { type: "popstate"; step: unknown; bookId?: string | null }
  /** Stepper click. */
  | { type: "goTo"; step: FlowStep }
  /** createBookAction (create) or updateBookSetupAction (edit) succeeded on step 2. */
  | { type: "created"; bookId: string }
  | { type: "photosPicked" }
  /** Step 3: an upload started (busy: true) or settled / stopped (busy: false). */
  | { type: "uploadBusy"; busy: boolean }
  /**
   * Step 5: the answer of POST /api/ai/runs { auto: true } (requestAutoBuildSettled — the one
   * not_ready retry already happened inside it, so `retried` is informational).
   */
  | { type: "autoStart"; outcome: AutoStartOutcome; retried: boolean; activeAtLoad: boolean }
  /**
   * Step 5: the build was asked for and the answer is still on its way → step 6 now; step 6 receives
   * the pending answer and follows it there (M20b: one request = one run).
   */
  | { type: "autoStartPending" }
  /** Step 5 → step 6 without an auto request (too few photos for it): BuildProgress starts the run (G3). */
  | { type: "buildRequested" }
  /** A run exists (BuildProgress started / resumed one, or another tab did). */
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
  /** Step-2 Continue: create the book (create mode) or save title + occasion (edit mode), then dispatch created. */
  | { kind: "submit"; mode: FlowMode }
  /**
   * Step-5 Continue: save the design when it differs from the stored book (updateBookSetupAction),
   * ask for the first build (requestAutoBuildSettled), then dispatch autoStart / autoStartPending /
   * buildRequested.
   */
  | { kind: "startBuild"; bookId: string }
  /** Step 7 Continue: confirm the album (confirmAlbumAction), then dispatch confirm. */
  | { kind: "confirm"; bookId: string };

export type FlowResult = {
  state: FlowState;
  effect: FlowEffect;
  intent?: FlowIntent;
  /** The action was a navigation the guardrails / maxStep refused. */
  refused?: boolean;
};

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
 * The state for a (hard) load. Create mode is clamped to steps 1–2 (no book yet). Edit mode: pass
 * what the server knows (the book has photos, a run exists, the run finished); flags imply each
 * other (done ⇒ runStarted ⇒ photosPicked) and the step is lifted past locked steps.
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
  if (done) step = FLOW_REVIEW_STEP;
  else if (runStarted && step < FLOW_BUILD_STEP) step = FLOW_BUILD_STEP;
  else if (photosPicked && step < FLOW_PHOTOS_STEP) step = FLOW_PHOTOS_STEP;
  // Edit mode: steps 1–2 are answered (the book exists); 3+ are reached via Continue or the load.
  const maxStep = maxOf(step, FLOW_FORM_LAST_STEP);
  return { ...blank({ kind: "edit", bookId: input.bookId }), step, maxStep, photosPicked, runStarted, done };
}

function blank(mode: FlowMode): FlowState {
  return {
    mode,
    step: 1,
    maxStep: 1,
    photosPicked: false,
    uploading: false,
    runStarted: false,
    done: false,
    stop: null,
    autoStartError: null,
  };
}

/** True when a guardrail locks `step` (G2). */
export function isStepLocked(state: FlowState, step: FlowStep): boolean {
  if (state.done && step <= FLOW_BUILD_STEP) return true;
  if (state.runStarted && step <= FLOW_DESIGN_STEP) return true;
  if (state.photosPicked && step <= FLOW_FORM_LAST_STEP) return true;
  return false;
}

/**
 * Steps a browser entry may show: reached, not locked, 3+ only once the book exists, and none but
 * step 3 while its upload runs.
 */
function canShow(state: FlowState, step: FlowStep): boolean {
  if (step > state.maxStep) return false;
  if (step >= FLOW_PHOTOS_STEP && state.mode.kind === "create") return false;
  if (state.uploading && step !== state.step) return false;
  return !isStepLocked(state, step);
}

/**
 * Stepper: may this step be clicked? Not the current one; reached and unlocked; and never forward
 * from the form (steps 1–2) into 3+ — that must go through step-2 Continue so edits are saved.
 */
export function canGoTo(state: FlowState, step: FlowStep): boolean {
  if (step === state.step) return false;
  if (step >= FLOW_PHOTOS_STEP && state.step <= FLOW_FORM_LAST_STEP) return false;
  return canShow(state, step);
}

/** Move to a step: clears per-step flags, raises maxStep. */
function moveTo(state: FlowState, step: FlowStep): FlowState {
  return { ...state, step, maxStep: maxOf(state.maxStep, step), stop: null, autoStartError: null, uploading: false };
}

function refuse(state: FlowState): FlowResult {
  return { state, effect: { kind: "replace", url: urlFor(state) }, refused: true };
}

const bookIdOf = (mode: FlowMode): string | null => (mode.kind === "edit" ? mode.bookId : null);

/** Step 5 → 6 with the run flag set: step 6 owns the (pending) run now, steps ≤5 can't come back. */
function toBuild(state: FlowState): FlowResult {
  const next = moveTo({ ...state, runStarted: true, photosPicked: true }, FLOW_BUILD_STEP);
  return { state: next, effect: { kind: "push", url: urlFor(next) } };
}

// ---- transitions ----------------------------------------------------------------------------------

export function transition(state: FlowState, action: FlowAction): FlowResult {
  switch (action.type) {
    case "continue": {
      const s = state.step;
      const bookId = bookIdOf(state.mode);
      if (s < FLOW_FORM_LAST_STEP) {
        const next = moveTo(state, (s + 1) as FlowStep);
        return { state: next, effect: { kind: "push", url: urlFor(next) } };
      }
      if (s === FLOW_FORM_LAST_STEP) return { state, effect: NONE, intent: { kind: "submit", mode: state.mode } };
      if (!bookId) return { state, effect: NONE };
      // Photos → Story needs a photo and a settled upload; Story → Design is always open (optional step).
      if (s === FLOW_PHOTOS_STEP || s === FLOW_STORY_STEP) {
        if (s === FLOW_PHOTOS_STEP && (!state.photosPicked || state.uploading)) return { state, effect: NONE };
        if (state.runStarted) return { state, effect: NONE };
        const next = moveTo(state, (s + 1) as FlowStep);
        return { state: next, effect: { kind: "push", url: urlFor(next) } };
      }
      if (s === FLOW_DESIGN_STEP && !state.runStarted) {
        return { state, effect: NONE, intent: { kind: "startBuild", bookId } };
      }
      if (s === FLOW_REVIEW_STEP && state.done) return { state, effect: NONE, intent: { kind: "confirm", bookId } };
      return { state, effect: NONE }; // step 6 advances on its own
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
      // An old create-mode entry (step 1 before the book existed) → show it as the edit URL.
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
      const next = moveTo({ ...state, mode }, FLOW_PHOTOS_STEP);
      return {
        state: next,
        effect: { kind: "push", url: urlFor(next), replaceCurrent: urlForStep(mode, FLOW_FORM_LAST_STEP) },
      };
    }

    case "photosPicked": {
      if (state.step !== FLOW_PHOTOS_STEP || state.photosPicked) return { state, effect: NONE };
      return { state: { ...state, photosPicked: true }, effect: NONE };
    }

    case "uploadBusy": {
      if (state.step !== FLOW_PHOTOS_STEP || state.uploading === action.busy) return { state, effect: NONE };
      return { state: { ...state, uploading: action.busy, photosPicked: state.photosPicked || action.busy }, effect: NONE };
    }

    case "autoStart":
      return autoStart(state, action);

    case "autoStartPending":
    case "buildRequested": {
      if (state.step !== FLOW_DESIGN_STEP || state.mode.kind !== "edit" || state.runStarted) return { state, effect: NONE };
      return toBuild(state);
    }

    case "runStarted": {
      if (state.mode.kind !== "edit" || state.step < FLOW_PHOTOS_STEP || state.done) return { state, effect: NONE };
      const flagged: FlowState = { ...state, runStarted: true, photosPicked: true };
      if (state.step === FLOW_BUILD_STEP) return { state: { ...flagged, maxStep: maxOf(state.maxStep, FLOW_BUILD_STEP) }, effect: NONE };
      if (state.step < FLOW_BUILD_STEP) {
        // Another tab / an earlier visit started the build while an open step (3–5) was shown.
        const next = moveTo(flagged, FLOW_BUILD_STEP);
        return { state: next, effect: { kind: "push", url: urlFor(next) } };
      }
      return { state: flagged, effect: NONE };
    }

    case "buildDone": {
      if (state.mode.kind !== "edit" || state.step < FLOW_PHOTOS_STEP) return { state, effect: NONE };
      const next = moveTo({ ...state, runStarted: true, photosPicked: true, done: true }, FLOW_REVIEW_STEP);
      if (state.step === FLOW_REVIEW_STEP) return { state: next, effect: NONE };
      // The build step is transient: replace it, so Back from the preview never re-shows a finished run.
      return { state: next, effect: { kind: "replace", url: urlFor(next) } };
    }

    case "buildStopped": {
      if (state.step !== FLOW_BUILD_STEP) return { state, effect: NONE };
      return { state: { ...state, stop: action.reason }, effect: NONE };
    }

    case "buildResumed": {
      if (state.step !== FLOW_BUILD_STEP || state.stop === null) return { state, effect: NONE };
      return { state: { ...state, stop: null }, effect: NONE };
    }

    case "confirm": {
      const bookId = bookIdOf(state.mode);
      if (state.step !== FLOW_REVIEW_STEP || !bookId) return { state, effect: NONE };
      return { state, effect: { kind: "navigate", target: "editor", href: flowEditorHref(bookId) } };
    }
  }
}

/** useReducer-friendly: the next state only (effects / intents dropped). */
export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  return transition(state, action).state;
}

/**
 * The build request's answer on step 5 (Design) → the wizard's next place (mirrors autoStartNext in
 * auto-build-client, with wizard targets): a run → step 6 — in every AI mode, including a rule run
 * (AI off) that already finished inside the POST: step 6 plays its checklist through, then step 7
 * (M20b); the first run already finished elsewhere → step 7; the user edited → editor (the only
 * editor exit); not_ready (fewer photos than the automatic build wants) → step 6, where the build
 * starts the plain way; limit / signed out / error → stay on 5 with the reason (Continue asks again).
 */
function autoStart(
  state: FlowState,
  action: Extract<FlowAction, { type: "autoStart" }>,
): FlowResult {
  const bookId = bookIdOf(state.mode);
  if (state.step !== FLOW_DESIGN_STEP || !bookId || state.runStarted) return { state, effect: NONE };
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
    case "not_ready":
      return toBuild(state);
    case "not_first": {
      if (action.activeAtLoad) return toBuild(state);
      // The first run already finished (another tab / an earlier visit) → preview it.
      const next = moveTo({ ...state, runStarted: true, photosPicked: true, done: true }, FLOW_REVIEW_STEP);
      return { state: next, effect: { kind: "replace", url: urlFor(next) } };
    }
    case "user_edited":
      return toEditor();
    case "limit":
      return fallback(outcome.limit);
    case "signed_out":
    case "error":
      return fallback();
  }
}
