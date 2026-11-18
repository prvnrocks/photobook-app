"use client";
// The book creation wizard on /books/new — one continuous 7-step wizard (M19 D-071, M20 D-072; Task 5
// order): 1 title → 2 occasion → 3 photos → 4 story → 5 design → 6 create → 7 preview → editor.
//   - The band, stepper, aside (steps 1–6; Preview drops it for full width) and this component stay
//     mounted from step 1 to step 7; steps change in
//     place (document.startViewTransition via runViewTransition, CSS fallback — wizard-motion.css
//     contract: data-step-anim / data-step-dir on the keyed step container). The only real
//     navigation is the final move to the editor (window.location.assign).
//   - Every step change goes through the pure flow model (src/lib/books/wizard-flow.ts): transition()
//     returns the next state + an effect, applied here exactly as T3 specified: "push" (replaceCurrent
//     first, then history.pushState; preferHistoryBack → history.back() when the previous entry is
//     that step), "replace", "reload", "navigate". popstate feeds `popstate` actions, so browser
//     back / forward follow the same guardrails (G2: photos picked → steps 1–2 locked; run → ≤5
//     locked; done → 6 locked). Never router.push / router.refresh here (G1).
//   - Steps 1–2: the draft (title, occasion). New book: mirrored to sessionStorage so a refresh keeps
//     it; entering step 2 with a bad title goes back to step 1; a restored draft offers "Start over".
//     Step-2 Continue submits createBookAction with title + occasion only — the book gets a
//     PROVISIONAL design (default shape + the occasion's style; the real choice is step 5) and the
//     action returns the id + the Photos-step data → `created` → step 3 in place; the step-2 history
//     entry becomes the edit URL so browser Back re-opens THIS book (M19 BUG-2). book_created is sent
//     from here (the one-shot ?_ev flash on the action's `next`).
//     Edit mode (?book=<id>, or after the create): prefilled; step-2 Continue saves title + occasion
//     with updateBookSetupAction → `created` → step 3.
//   - Steps 3–7: WizardDataSteps (one code-split chunk, prefetched on idle from step 2 — G5).
//     3 Photos uploads only (no build). 4 Story keeps its answers in `storyDraft` here (Back / Forward
//     never lose them) and saves itself. 5 Design: `designPick` = the user's own picks, the
//     recommendation is only preselected for a field not picked (src/lib/books/design-choice.ts);
//     its Continue saves the design through updateBookSetupAction when it differs from the stored
//     book, then the chunk asks for the first build → step 6.
//   - Mode guard (replaces the M19 BUG-3 key-by-mode): the page keys this component by a constant, so
//     a server re-render after a server action (revalidatePath re-renders the current URL, now an
//     edit URL) can't remount it mid-flow. If the server sends a different book (or a fresh create
//     wizard via a link) than the one the flow holds, the page is reloaded instead — no answers ever
//     carry over into another book.
// First-load island: no cn / buttonVariants / next/link (the step-1 Back link comes from the server).

import { useActionState, useCallback, useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { createBookAction, updateBookSetupAction } from "@/app/books/actions";
import { initialNewBookFormState, type NewBookField, type NewBookFormState } from "@/app/books/form-state";
import { Notice } from "@/components/app/Notice";
import { WizardNav } from "@/components/wizard/WizardNav";
import { WizardBand } from "@/components/wizard/WizardBand";
import { WizardBody } from "@/components/wizard/WizardBody";
import type { BookSetupField, BookSetupPatch, SetupLockReason, UpdateBookSetupResult } from "@/lib/book/setup";
import {
  designPatch,
  designPickStorageKey,
  initialDesignPick,
  NO_DESIGN_PICK,
  parseDesignPick,
  resolveDesignChoice,
  serializeDesignPick,
  type DesignPick,
  type StoredDesign,
} from "@/lib/books/design-choice";
import type { WizardStepData } from "@/lib/books/wizard-client";
import {
  canGoTo as flowCanGoTo,
  FLOW_FORM_LAST_STEP,
  flowEditorHref,
  initFlowState,
  parseFlowStep,
  transition,
  urlFor,
  type FlowAction,
  type FlowResult,
  type FlowState,
  type FlowStep,
} from "@/lib/books/wizard-flow";
import {
  EMPTY_WIZARD_DRAFT,
  firstMissingStep,
  isAcceptableWizardTitle,
  parseWizardDraft,
  serializeWizardDraft,
  WIZARD_DRAFT_STORAGE_KEY,
  type WizardDraft,
  type WizardFormStep,
} from "@/lib/books/wizard-steps";
import { wasAlbumConfirmedHere } from "@/lib/books/wizard-confirmed";
import { DEFAULT_FORM_FORMAT, defaultStyleFor, isFormDesignStyle } from "@/lib/design/defaults";
import type { DesignRecommendation } from "@/lib/design/recommend";
import { canUseViewTransition, runViewTransition, type StepDirection } from "@/lib/ui/view-transition";
import type { AutoStartOutcome } from "@/lib/upload/auto-build-client";
import { StepOccasion } from "./wizard/StepOccasion";
import { StepTitle } from "./wizard/StepTitle";
import { WizardBookPreview, WizardPreviewAside } from "./wizard/WizardBookPreview";
import { LazyWizardDataSteps, prefetchWizardSteps } from "./wizard/steps/lazy-steps";
// The Photos-step upload stage's CSS rides in this route's stylesheet, not in the lazy steps chunk: an async
// chunk with CSS adds webpack's CSS-chunk loader to the runtime every route ships (+0.6 kB gzip).
import "@/components/upload/upload-motion.css";
import "./wizard/steps/sorting-motion.css";
import "./wizard/steps/review-motion.css";
import type { StoryDraft } from "./wizard/steps/StepStory";
import type { WizardBookFacts, WizardBookStep, WizardStepDataMap } from "./wizard/steps/WizardDataSteps";

export type NewBookWizardMode =
  | { kind: "create" }
  | { kind: "edit"; bookId: string; draft: WizardDraft; designLock: SetupLockReason | null };

export type NewBookWizardProps = {
  /** The step the server resolved (create: 1–2; edit: 1–7 after the gate). */
  initialStep: FlowStep;
  mode: NewBookWizardMode;
  /** Step-1 Back: a server-rendered <Link> to /dashboard. */
  dashboardBack: ReactNode;
  /**
   * Hard load with a book: the server's loadWizardStep data — the Photos-step data for steps 1–5 (it
   * says whether the book has photos), the step's own data for 6 / 7.
   */
  initialData?: WizardStepData | null;
};

/**
 * The form step that asks for each field (server errors jump there). Shape, style, tone and caption
 * language aren't asked on the form (Task 5 / D-072) — an error on one falls back to step 2.
 */
export const FIELD_STEP: Partial<Record<NewBookField, WizardFormStep>> = {
  title: 1,
  occasion: 2,
};

const HEADLINE_ID = "wizard-headline";

const MSG_SAVE_FAILED = "We couldn't save your changes. Please try again.";
const EDIT_ERRORS: Record<Extract<UpdateBookSetupResult, { ok: false }>["error"], string> = {
  unauthenticated: "Please sign in again.",
  not_found: "We couldn't find this book.",
  invalid: "Please check your answers.",
  locked: "This book's setup can't change any more — open it to keep going.",
  conflict: "This book changed a moment ago. Please try again.",
  failed: MSG_SAVE_FAILED,
};

type StepError = { step: FlowStep; message: string; field?: NewBookField };
type StepAnim = { kind: "vt" | "css"; dir: StepDirection };

/** First (lowest-step) field error → where to show it. */
function errorFromFields(
  fieldErrors: Partial<Record<NewBookField, string>> | undefined,
  fallback: string,
): StepError {
  let best: StepError | null = null;
  for (const [field, message] of Object.entries(fieldErrors ?? {}) as [NewBookField, string | undefined][]) {
    const step = FIELD_STEP[field];
    if (!message || step === undefined) continue;
    if (!best || step < best.step) best = { step, message, field };
  }
  return best ?? { step: FLOW_FORM_LAST_STEP, message: fallback };
}

/** Steps a visit may show: a fresh visit (nothing stored) starts at 1; else up to the first missing answer. */
export function allowedStep(target: WizardFormStep, draft: WizardDraft, fresh: boolean): WizardFormStep {
  if (fresh) return 1;
  const missing = firstMissingStep(draft);
  return missing === null || target <= missing ? target : missing;
}

/**
 * Create mode can only see ?book= when the router restored a cached create page for a history entry
 * that we pointed at a created book (the server always renders ?book= in edit mode) → reload it.
 */
export function isCreatedBookEntry(href: string): boolean {
  return new URL(href).searchParams.has("book");
}

/** Full-page navigation, behind an object so DOM tests can observe it (jsdom can't navigate). */
export const wizardWindow = {
  reload(href: string) {
    window.location.replace(href);
  },
  assign(href: string) {
    window.location.assign(href);
  },
  /** Leaves with location.replace: the current (dead) wizard entry leaves the history (M20c). */
  replace(href: string) {
    window.location.replace(href);
  },
};

/** The flow state for the server's answer (hard load / first render). */
export function initialFlow(mode: NewBookWizardMode, step: FlowStep, data?: WizardStepData | null): FlowState {
  if (mode.kind === "create") return initFlowState({ step });
  const d = data && data.bookId === mode.bookId ? data : null;
  return initFlowState({
    bookId: mode.bookId,
    step,
    // The book already has photos (ready or still pending): steps 1–2 are locked.
    photosPicked: d?.step === 3 && d.existing.length > 0,
    runStarted: step === 6 || d?.step === 6,
    done: step === 7 || d?.step === 7,
  });
}

function readUrl(): { step: string | null; book: string | null } {
  const u = new URL(window.location.href);
  return { step: u.searchParams.get("step"), book: u.searchParams.get("book") };
}

/** Our own keys in history.state (Next merges its router state into the same object). */
type WizardHistoryState = { wizardStep?: number; wizardPrev?: number };

function historyState(): WizardHistoryState & Record<string, unknown> {
  const s: unknown = window.history.state;
  return s && typeof s === "object" ? (s as WizardHistoryState & Record<string, unknown>) : {};
}

/** Does the address bar show `state`'s step (and book)? A missing ?step on create counts as step 1. */
export function urlShowsFlow(href: string, state: FlowState): boolean {
  const u = new URL(href, "http://x");
  const book = u.searchParams.get("book");
  const step = parseFlowStep(u.searchParams.get("step")) ?? (state.mode.kind === "create" && book === null ? 1 : null);
  if (step !== state.step) return false;
  return state.mode.kind === "edit" ? book === state.mode.bookId : book === null;
}

/**
 * Follow-up ticks after a popstate at which the wizard re-checks the address bar (M20 polish, bug 6):
 * Next's app router handles the same popstate and, once its restore render commits, may write the
 * entry's URL back over the wizard's corrective replaceState (step 7 shown at ?step=3). Re-asserting
 * in a microtask, the next frame and two short timeouts makes the wizard's URL win; each tick only
 * acts while the flow is unchanged and no newer popstate happened.
 */
export const POPSTATE_REASSERT_MS = [0, 60, 250] as const;

function readStored(): WizardDraft | null {
  try {
    return parseWizardDraft(window.sessionStorage.getItem(WIZARD_DRAFT_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStored(draft: WizardDraft | null) {
  try {
    if (draft) window.sessionStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft(draft));
    else window.sessionStorage.removeItem(WIZARD_DRAFT_STORAGE_KEY);
  } catch {
    // Private mode / storage full: the wizard still works, a refresh just starts over.
  }
}

/**
 * book_created (M9 T14): the server decided it — the one-shot ?_ev flash on the action's `next`, only
 * with analytics on. Both analytics modules load lazily (not in the first load).
 */
function trackCreated(next: string | undefined) {
  if (!next || !next.includes("_ev=")) return;
  let search = "";
  try {
    search = new URL(next, window.location.origin).search;
  } catch {
    return;
  }
  void Promise.all([import("@/lib/analytics/flash"), import("@/lib/analytics/client")])
    .then(([flash, client]) => {
      const ev = flash.flashEvent(search);
      if (ev) client.trackEvent(ev);
    })
    .catch(() => {});
}

function readDesignPick(bookId: string): DesignPick | null {
  try {
    return parseDesignPick(window.sessionStorage.getItem(designPickStorageKey(bookId)));
  } catch {
    return null;
  }
}

function writeDesignPick(bookId: string, pick: DesignPick) {
  try {
    window.sessionStorage.setItem(designPickStorageKey(bookId), serializeDesignPick(pick));
  } catch {
    // Private mode / storage full: the pick still holds for this page's lifetime.
  }
}

const storedDesignOf = (draft: WizardDraft): StoredDesign => ({ format: draft.format, designStyle: draft.designStyle });

function loginHref(): string {
  return `/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`;
}

export function NewBookWizard({ initialStep, mode, dashboardBack, initialData }: NewBookWizardProps) {
  const edit = mode.kind === "edit" ? mode : null;
  const [draft, setDraft] = useState<WizardDraft>(() => edit?.draft ?? EMPTY_WIZARD_DRAFT);
  const [flow, setFlow] = useState<FlowState>(() => initialFlow(mode, initialStep, initialData));
  const flowRef = useRef(flow);
  const [stepData, setStepData] = useState<WizardStepDataMap>(() =>
    initialData && edit && initialData.bookId === edit.bookId ? { [initialData.step]: initialData } : {},
  );
  const [stepError, setStepError] = useState<StepError | null>(null);
  /** The last step change's animation (null until the first change: no enter animation on load). */
  const [anim, setAnim] = useState<StepAnim | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const setPanel = useCallback((el: HTMLElement | null) => {
    panelRef.current = el;
  }, []);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** The user changed something (create): only then is the draft mirrored to sessionStorage. */
  const dirtyRef = useRef(false);
  const focusOnStepRef = useRef(false);
  /** Step 6 data: the run is the automatic first build (ai_build_done { auto }). */
  const autoRef = useRef(false);
  /** M20b: the Design step's build request answer (resolved or pending), followed by step 6. */
  const handoverRef = useRef<Promise<AutoStartOutcome> | null>(null);
  /** Story step: the client copy of the answers (null = not opened in this session → it loads). */
  const [storyDraft, setStoryDraft] = useState<StoryDraft | null>(null);
  /**
   * Design step: the user's own picks (a provisional stored design counts as "not chosen"; a pick
   * remembered for this book in sessionStorage is restored by the mount effect) and the last
   * recommendation.
   */
  const [designPick, setDesignPick] = useState<DesignPick>(() =>
    edit ? initialDesignPick({ stored: storedDesignOf(edit.draft), occasion: edit.draft.occasion }) : NO_DESIGN_PICK,
  );
  const [recommendation, setRecommendation] = useState<DesignRecommendation | null>(null);
  /** What the Photos step told us about the book (limit copy, "enough photos for the automatic build?"). */
  const factsRef = useRef<WizardBookFacts>(
    initialData && edit && initialData.bookId === edit.bookId && initialData.step === 3
      ? { isPaid: initialData.isPaid, dailyCap: initialData.dailyCap, ready: initialData.pendingCount === 0 ? initialData.readyCount : null }
      : { isPaid: false, dailyCap: null, ready: null },
  );

  const [state, formAction, creating] = useActionState<NewBookFormState, FormData>(
    createBookAction,
    initialNewBookFormState,
  );
  const [saving, startSaving] = useTransition();
  const [leaving, setLeaving] = useState(false);
  /** A reload / navigation away was started from a popstate (no URL re-assert after it). */
  const leavingRef = useRef(false);
  /**
   * Create submit in flight or succeeded (M20 review): createBookAction resolves a frame before the
   * success effect moves to step 3, so a second tap / Enter on the still-mounted create form would make
   * an orphan duplicate book. The ref blocks the submit; the state keeps Continue disabled meanwhile.
   * Cleared only when the create fails.
   */
  const createSubmittedRef = useRef(false);
  const [createSubmitted, setCreateSubmitted] = useState(false);
  /** Create mode: steps 1–2 came back from sessionStorage (offer "Start over"). */
  const [restored, setRestored] = useState(false);
  // Create mode remounted on a created book's entry (see isCreatedBookEntry): render nothing but a
  // pending shell while the mount effect reloads. Always false on the server and on hydration.
  const [reopening] = useState(
    () => mode.kind === "create" && typeof window !== "undefined" && isCreatedBookEntry(window.location.href),
  );

  const step = flow.step;
  const editingBookId = flow.mode.kind === "edit" ? flow.mode.bookId : null;
  const stored = storedDesignOf(draft);
  const chosen = resolveDesignChoice({ stored, pick: designPick, recommendation, occasion: draft.occasion });
  const designLocked = edit?.designLock != null && edit.bookId === editingBookId;
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  const designLockedRef = useRef(designLocked);
  designLockedRef.current = designLocked;

  /** Renders a new flow state; a step change runs as a view transition (CSS fallback). */
  const showFlow = useCallback((prev: FlowState, next: FlowState) => {
    if (prev.step === next.step) {
      setFlow(next);
      return;
    }
    const dir: StepDirection = next.step < prev.step ? "back" : "forward";
    const kind = canUseViewTransition() ? "vt" : "css";
    focusOnStepRef.current = true;
    // The old snapshot must carry the step's view-transition-name (wizard-motion.css: [data-step-anim]).
    if (kind === "vt" && panelRef.current) panelRef.current.setAttribute("data-step-anim", "vt");
    runViewTransition(() => {
      setAnim({ kind, dir });
      setFlow(next);
    });
  }, []);

  /** Applies a transition result: history effect first (URL before render), then the new state. */
  const apply = useCallback(
    (prev: FlowState, res: FlowResult) => {
      const next = res.state;
      flowRef.current = next;
      const e = res.effect;
      if (e.kind === "push") {
        const hs = historyState();
        if (e.preferHistoryBack && hs.wizardPrev === next.step && hs.wizardStep === prev.step) {
          window.history.back(); // the popstate that follows finds the state already there
        } else {
          if (e.replaceCurrent) {
            window.history.replaceState({ ...hs, wizardStep: prev.step, wizardPrev: undefined }, "", e.replaceCurrent);
          }
          const data: WizardHistoryState = { wizardStep: next.step, wizardPrev: prev.step };
          window.history.pushState(data, "", e.url);
        }
      } else if (e.kind === "replace") {
        window.history.replaceState({ ...historyState(), wizardStep: next.step, wizardPrev: undefined }, "", e.url);
      } else if (e.kind === "reload") {
        wizardWindow.reload(window.location.href);
        return;
      } else if (e.kind === "navigate") {
        setLeaving(true);
        wizardWindow.assign(e.href);
      }
      if (next !== prev) showFlow(prev, next);
    },
    [showFlow],
  );

  const dispatch = useCallback(
    (action: FlowAction): FlowResult => {
      const prev = flowRef.current;
      const res = transition(prev, action);
      apply(prev, res);
      return res;
    },
    [apply],
  );

  /** Leave the wizard (editor / classic build) — the one kind of real navigation. */
  const leave = useCallback((href: string, opts?: { replace?: boolean }) => {
    setLeaving(true);
    if (opts?.replace) wizardWindow.replace(href);
    else wizardWindow.assign(href);
  }, []);

  // Mount: restore the stored draft (create), bounce a step whose earlier answers are missing, and
  // make the URL match the step the server resolved (edit).
  useEffect(() => {
    if (reopening) {
      wizardWindow.reload(window.location.href);
      return;
    }
    if (mode.kind === "edit") {
      // M20c: a generated book never shows the wizard. Hard loads redirect on the server; this
      // catches the cached tree browser Back restores after "Generate album" (soft navigation) and
      // an "editor" answer in the props — leave with replace, so Back doesn't land here again.
      if (wasAlbumConfirmedHere(mode.bookId) || (initialData?.bookId === mode.bookId && initialData.resolved === "editor")) {
        leavingRef.current = true;
        setLeaving(true);
        wizardWindow.replace(flowEditorHref(mode.bookId));
        return;
      }
      // The user's own design pick from before a refresh (a manual choice always wins).
      const remembered = readDesignPick(mode.bookId);
      if (remembered) {
        setDesignPick(initialDesignPick({ stored: storedDesignOf(mode.draft), occasion: mode.draft.occasion, remembered }));
      }
      const cur = flowRef.current;
      const url = readUrl();
      if (parseFlowStep(url.step) !== cur.step || url.book !== mode.bookId) {
        window.history.replaceState({ ...historyState(), wizardStep: cur.step, wizardPrev: undefined }, "", urlFor(cur));
      }
      return;
    }
    let current = draftRef.current;
    let fresh = false;
    const stored = readStored();
    if (stored) {
      current = stored;
      setDraft(current);
      setRestored(true);
    } else {
      fresh = true;
    }
    const urlStep = parseFlowStep(readUrl().step);
    const asked = (urlStep === null ? 1 : Math.min(urlStep, FLOW_FORM_LAST_STEP)) as WizardFormStep;
    const target = allowedStep(asked, current, fresh);
    const reach = fresh ? target : Math.max(target, firstMissingStep(current) ?? FLOW_FORM_LAST_STEP);
    const next: FlowState = { ...initFlowState({ step: target }), maxStep: reach as FlowStep };
    const prev = flowRef.current;
    flowRef.current = next;
    if (String(target) !== readUrl().step) {
      window.history.replaceState({ ...historyState(), wizardStep: target, wizardPrev: undefined }, "", urlFor(next));
    }
    showFlow(prev, next);
    // mode is fixed for the page's lifetime (mode guard below)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mode guard: a server render (new props: soft navigation, revalidation) whose mode doesn't match the
  // book the flow holds → reload. Compared against the flow's mode (not the previous props), so a soft
  // nav to plain /books/new after an in-place create (props still "create") always reloads.
  const firstPropsRef = useRef(true);
  useEffect(() => {
    if (firstPropsRef.current) {
      firstPropsRef.current = false; // the mount effect handles the first render
      return;
    }
    const fm = flowRef.current.mode;
    if (mode.kind === "edit") {
      if (fm.kind === "edit" && fm.bookId === mode.bookId) return;
    } else if (fm.kind === "create" || readUrl().book !== null) {
      // Create props at an edit URL: a revalidation re-rendered the page at the URL the flow wrote
      // (or a cached create tree for an old step-1 entry the popstate flow already showed as this
      // book's edit URL) → keep.
      return;
    }
    wizardWindow.reload(window.location.href);
    // Props from a server render are new objects each time: any of them changing = a new render.
  }, [mode, initialStep, initialData]);

  // The Photos step's data is only good while that step shows: once it's left (photos were added, a
  // run started, …) drop it, so a later step-3 view refetches (the Uploader's resume list and counts
  // must match the book) and follows the gate. What later steps need from it is kept in factsRef.
  const photosData = stepData[3];
  useEffect(() => {
    if (!photosData) return;
    factsRef.current = {
      isPaid: photosData.isPaid,
      dailyCap: photosData.dailyCap,
      ready: factsRef.current.ready ?? (photosData.pendingCount === 0 && photosData.readyCount > 0 ? photosData.readyCount : null),
    };
    if (flow.step === 3) return;
    setStepData((d) => {
      if (d[3] === undefined) return d;
      const rest = { ...d };
      delete rest[3];
      return rest;
    });
  }, [photosData, flow.step]);

  // Browser back / forward → the flow (guardrails decide; refused → the URL shows the current step).
  // After applying, the URL the flow wants is re-asserted on a few follow-up ticks (see
  // POPSTATE_REASSERT_MS), keeping history.state (Next's router data) and only our keys updated.
  useEffect(() => {
    let popToken = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let raf = 0;
    function reassert(token: number, expected: FlowState) {
      if (token !== popToken || flowRef.current !== expected) return; // a newer pop / step change won
      if (window.location.pathname !== "/books/new") return; // a real navigation away: never pull it back
      if (urlShowsFlow(window.location.href, expected)) return;
      const hs = historyState();
      const keepPrev = hs.wizardStep === expected.step ? hs.wizardPrev : undefined;
      window.history.replaceState({ ...hs, wizardStep: expected.step, wizardPrev: keepPrev }, "", urlFor(expected));
    }
    function scheduleReassert() {
      const token = ++popToken;
      const expected = flowRef.current;
      queueMicrotask(() => reassert(token, expected));
      if (typeof requestAnimationFrame === "function") {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => reassert(token, expected));
      }
      for (const ms of POPSTATE_REASSERT_MS) {
        const t = setTimeout(() => {
          timers.delete(t);
          reassert(token, expected);
        }, ms);
        timers.add(t);
      }
    }
    function onPop() {
      popToken++; // cancels the follow-ups of an earlier pop
      handlePop();
      // A reload / navigation is leaving the page: nothing to keep.
      if (!leavingRef.current) scheduleReassert();
    }
    function handlePop() {
      const url = readUrl();
      const prev = flowRef.current;
      let stepParam: unknown = url.step;
      // Create mode: never past the first missing answer of the draft.
      const parsed = parseFlowStep(url.step);
      if (prev.mode.kind === "create" && parsed !== null && parsed <= FLOW_FORM_LAST_STEP) {
        const allowed = allowedStep(parsed as WizardFormStep, draftRef.current, false);
        if (allowed !== parsed) stepParam = String(allowed);
      }
      const res = transition(prev, { type: "popstate", step: stepParam, bookId: url.book });
      if (res.effect.kind === "reload" || res.effect.kind === "navigate") leavingRef.current = true;
      if (stepParam !== url.step && res.effect.kind === "none") {
        apply(prev, { ...res, effect: { kind: "replace", url: urlFor(res.state) } });
        return;
      }
      apply(prev, res);
    }
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      popToken++;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    };
  }, [apply]);

  // Mirror the new-book draft (create mode only).
  useEffect(() => {
    if (flow.mode.kind === "create" && dirtyRef.current) writeStored(draft);
  }, [draft, flow.mode.kind]);

  // G5: warm the steps 3–7 chunk on idle once the user is on the last form step (its Continue
  // creates the book and shows step 3).
  const warm = step >= 2;
  useEffect(() => {
    if (!warm) return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => prefetchWizardSteps(), { timeout: 3000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(() => prefetchWizardSteps(), 500);
    return () => clearTimeout(t);
  }, [warm]);

  // Move focus to the new step's headline after a step change (keyboard / screen readers); steps 3–7
  // render it once their chunk / data is in.
  useEffect(() => {
    if (!focusOnStepRef.current) return;
    const h = document.getElementById(HEADLINE_ID);
    if (!h) return;
    focusOnStepRef.current = false;
    h.focus();
  }, [step, stepData]);

  // createBookAction succeeded: step 3 in place (the step-2 entry becomes the edit URL — flow effect).
  const createdRef = useRef<NewBookFormState | null>(null);
  useEffect(() => {
    if (!state.ok || !state.bookId || createdRef.current === state) return;
    createdRef.current = state; // once per result, whatever re-runs the effect
    // Only now is the stored draft done with (a failed or thrown action must not lose steps 1–2).
    writeStored(null);
    setRestored(false);
    trackCreated(state.next);
    const bookId = state.bookId;
    const s3 = state.step3 && state.step3.bookId === bookId ? state.step3 : null;
    setStepData(s3 ? { 3: s3 } : {});
    // The book's provisional design (what the server stored): the Design step compares against it.
    const occasion = draftRef.current.occasion;
    setDraft((d) => ({
      ...d,
      format: s3?.format === "A5_PORTRAIT" || s3?.format === "A5_LANDSCAPE" ? s3.format : (DEFAULT_FORM_FORMAT as WizardDraft["format"]),
      designStyle: s3 && isFormDesignStyle(s3.designStyle) ? s3.designStyle : defaultStyleFor(occasion),
    }));
    setDesignPick(NO_DESIGN_PICK);
    setRecommendation(null);
    setStoryDraft(null);
    factsRef.current = { isPaid: s3?.isPaid ?? false, dailyCap: s3?.dailyCap ?? null, ready: null };
    dispatch({ type: "created", bookId });
  }, [state, dispatch]);

  // createBookAction failed: keep the draft, jump to the failed step.
  useEffect(() => {
    if (state === initialNewBookFormState || state.ok) return;
    createSubmittedRef.current = false;
    setCreateSubmitted(false);
    writeStored(draftRef.current);
    const err = errorFromFields(state.fieldErrors, state.error ?? "We couldn't create your book. Please try again.");
    setStepError(err);
    if (err.step !== flowRef.current.step) dispatch({ type: "goTo", step: err.step });
  }, [state, dispatch]);

  function update(patch: Partial<WizardDraft>) {
    dirtyRef.current = true;
    setDraft((d) => ({ ...d, ...patch }));
  }

  function goBack() {
    setStepError(null);
    dispatch({ type: "back" });
  }

  /** Edit mode, step-2 Continue: save title + occasion (the design is step 5's). */
  function saveEdit(bookId: string) {
    const d = draftRef.current;
    if (d.occasion === null) return;
    const patch: BookSetupPatch = {
      title: d.title.trim() === "" ? null : d.title,
      occasion: d.occasion,
      // No captionLang (D-072): the server re-derives it when the title changes.
    };
    setStepError(null);
    startSaving(async () => {
      let res: UpdateBookSetupResult;
      try {
        res = await updateBookSetupAction(bookId, patch);
      } catch {
        res = { ok: false, error: "failed" };
      }
      if (res.ok) {
        setStepData({}); // the setup changed: step 3 reloads its data
        // The occasion drives the story questions and the recommended style: start those afresh.
        setStoryDraft(null);
        setRecommendation(null);
        // The server re-derives nothing about the design here; keep what it stored.
        const setup = res.setup;
        setDraft((cur) => ({
          ...cur,
          format: setup.format === "A5_PORTRAIT" || setup.format === "A5_LANDSCAPE" ? setup.format : cur.format,
          designStyle: isFormDesignStyle(setup.designStyle) ? setup.designStyle : cur.designStyle,
        }));
        dispatch({ type: "created", bookId });
        return;
      }
      if (res.error === "unauthenticated") {
        leave(loginHref());
        return;
      }
      if (res.error === "locked") {
        // The details locked meanwhile (an AI build started): the server gate picks the step.
        leave(`/books/new?book=${encodeURIComponent(bookId)}&step=3`);
        return;
      }
      const err = res.fieldErrors
        ? errorFromFields(res.fieldErrors as Partial<Record<BookSetupField, string>>, EDIT_ERRORS[res.error])
        : { step: FLOW_FORM_LAST_STEP as FlowStep, message: EDIT_ERRORS[res.error] };
      setStepError(err);
      if (err.step !== flowRef.current.step) dispatch({ type: "goTo", step: err.step });
    });
  }

  /**
   * Design step, on Continue: save the chosen shape + style — only when they differ from the stored
   * book (updateBookSetupAction: service-role write + the rule draft re-laid out). true = go on to
   * the build request; false = stay (the error shows on the step) or the wizard is leaving.
   */
  const saveDesign = useCallback(async (): Promise<boolean> => {
    const fm = flowRef.current.mode;
    if (fm.kind !== "edit") return false;
    const d = draftRef.current;
    const patch = designLockedRef.current ? null : designPatch(chosenRef.current, storedDesignOf(d));
    setStepError(null);
    if (!patch) return true;
    let res: UpdateBookSetupResult;
    try {
      res = await updateBookSetupAction(fm.bookId, patch);
    } catch {
      res = { ok: false, error: "failed" };
    }
    if (res.ok) {
      setDraft((cur) => ({ ...cur, format: patch.format, designStyle: patch.designStyle }));
      return true;
    }
    if (res.error === "unauthenticated") {
      leave(loginHref());
      return false;
    }
    if (res.error === "locked") {
      // The setup locked meanwhile (a build started elsewhere): the server gate picks the step.
      leave(`/books/new?book=${encodeURIComponent(fm.bookId)}&step=5`);
      return false;
    }
    setStepError({ step: 5, message: EDIT_ERRORS[res.error] });
    return false;
  }, [leave]);

  function pickDesign(pick: DesignPick) {
    setStepError(null);
    setDesignPick(pick);
    if (editingBookId) writeDesignPick(editingBookId, pick);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    if (step < FLOW_FORM_LAST_STEP) {
      e.preventDefault();
      if (!canContinue) return;
      setStepError(null);
      dispatch({ type: "continue" });
      return;
    }
    const fm = flowRef.current.mode;
    if (fm.kind === "edit") {
      e.preventDefault();
      // The flow already holds a book (a create just succeeded, the form is about to unmount): never
      // a second create — a save only from the edit-mode form itself.
      if (editingBookId === fm.bookId && !saving) saveEdit(fm.bookId);
      return;
    }
    if (createSubmittedRef.current) {
      e.preventDefault(); // a create is in flight / done: no duplicate book
      return;
    }
    createSubmittedRef.current = true;
    setCreateSubmitted(true);
    // Create: the form action runs next (title + occasion; the server gives the book its provisional
    // design). The stored draft stays until it succeeds (success effect).
    setStepError(null);
  }

  /** Create mode: drop a restored draft (e.g. an abandoned one) and start again at step 1. */
  function startOver() {
    writeStored(null);
    dirtyRef.current = false;
    setRestored(false);
    setStepError(null);
    setDraft(EMPTY_WIZARD_DRAFT);
    const prev = flowRef.current;
    const next = initFlowState({ step: 1 });
    flowRef.current = next;
    window.history.replaceState({ ...historyState(), wizardStep: 1, wizardPrev: undefined }, "", urlFor(next));
    showFlow(prev, next);
  }

  const pending = creating || saving || leaving || (createSubmitted && flow.mode.kind === "create");
  const formStep = (step <= FLOW_FORM_LAST_STEP ? step : FLOW_FORM_LAST_STEP) as WizardFormStep;
  const canContinue = formStep === 1 ? isAcceptableWizardTitle(draft.title) : draft.occasion !== null;
  const errorHere = stepError && stepError.step === step ? stepError : null;
  // Live preview (M20 T4): a closed, neutral book until the design is chosen; from the Design step
  // on it wears the chosen shape + style and opens (steps 6–7 keep it).
  const designShown = step >= 5;
  const previewProps = {
    title: draft.title,
    occasion: draft.occasion,
    format: designShown ? chosen.format : null,
    designStyle: designShown ? chosen.designStyle : null,
    open: designShown,
    typing: step === 1,
  };
  const fieldError = (f: NewBookField) => (errorHere?.field === f ? errorHere.message : undefined);
  const animAttrs = {
    "data-step-anim": anim?.kind,
    "data-step-dir": anim?.dir,
  };

  if (reopening) {
    return (
      <div className="flex w-full min-w-0 flex-col" data-testid="new-book-wizard" data-reopening="true" aria-busy="true">
        <p className="text-muted-foreground mt-8 text-center text-sm" role="status">
          Opening your book…
        </p>
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-1 flex-col" data-testid="new-book-wizard" data-step={step} data-mode={flow.mode.kind}>
      <WizardBand
        step={step}
        title={draft.title}
        canGoTo={(n) => !pending && flowCanGoTo(flow, n)}
        onStepClick={(n) => {
          setStepError(null);
          dispatch({ type: "goTo", step: n });
        }}
      />
      {/* Step 7 (Review) drops the preview aside and uses the full library width (summary + captions
          side by side on ≥ xl, a wide photo grid). The content column stays the same element, so the
          step panel isn't remounted. */}
      <WizardBody
        wide={step === 7 ? "full" : true}
        aside={step === 7 ? undefined : <WizardPreviewAside {...previewProps} />}
        asideBelowLg="hide"
      >
        {/* Phones / tablets: the mini preview stays mounted above the (keyed) step form on steps 1–2,
            so it animates between them (shrinks after step 1). */}
        {step <= FLOW_FORM_LAST_STEP ? (
          <WizardBookPreview {...previewProps} size={step === 1 ? "md" : "sm"} className="mb-4 lg:hidden" />
        ) : null}
        {step <= FLOW_FORM_LAST_STEP ? (
          <form
            key={step}
            ref={setPanel}
            action={step === FLOW_FORM_LAST_STEP && !editingBookId ? formAction : undefined}
            onSubmit={onSubmit}
            noValidate
            className="flex w-full min-w-0 flex-col gap-8"
            data-testid="new-book-form"
            {...animAttrs}
          >
            {errorHere ? (
              <Notice tone="error" data-testid="new-book-error">
                <span data-testid="new-book-error-message">{errorHere.message}</span>
              </Notice>
            ) : null}

            {step === 1 ? (
              <StepTitle
                title={draft.title}
                onTitleChange={(title) => update({ title })}
                headlineId={HEADLINE_ID}
                error={fieldError("title")}
              />
            ) : (
              <StepOccasion
                occasion={draft.occasion}
                onOccasion={(occasion) => update({ occasion })}
                headlineId={HEADLINE_ID}
                error={fieldError("occasion")}
              />
            )}

            {step === FLOW_FORM_LAST_STEP && !editingBookId ? (
              <>
                <input type="hidden" name="title" value={draft.title} />
                <input type="hidden" name="occasion" value={draft.occasion ?? ""} />
              </>
            ) : null}

            <WizardNav
              back={step === 1 ? dashboardBack : undefined}
              onBack={step === 1 ? undefined : goBack}
              continueLabel="Continue"
              pendingLabel={step === FLOW_FORM_LAST_STEP ? (editingBookId ? "Saving…" : "Creating your book…") : undefined}
              pending={step === FLOW_FORM_LAST_STEP && pending}
              disabled={!canContinue || pending}
              continueTestId={step === FLOW_FORM_LAST_STEP ? (editingBookId ? "wizard-save" : "create-book") : "wizard-continue"}
              className="mx-auto max-w-[36rem]"
            />
          </form>
        ) : (
          <div
            key={step}
            ref={setPanel}
            className="flex w-full min-w-0 flex-col"
            data-testid="wizard-step-panel"
            data-panel-step={step}
            {...animAttrs}
          >
            {editingBookId ? (
              <LazyWizardDataSteps
                step={step as WizardBookStep}
                bookId={editingBookId}
                stepData={stepData}
                setStepData={setStepData}
                dispatch={dispatch}
                leave={leave}
                leaving={leaving}
                autoRef={autoRef}
                handoverRef={handoverRef}
                headlineId={HEADLINE_ID}
                factsRef={factsRef}
                story={{ occasion: draft.occasion, value: storyDraft, onChange: setStoryDraft }}
                design={{
                  title: draft.title,
                  occasion: draft.occasion,
                  stored,
                  pick: designPick,
                  onPick: pickDesign,
                  recommendation,
                  onRecommendation: setRecommendation,
                  locked: designLocked,
                  error: stepError && stepError.step === 5 ? stepError.message : null,
                  save: saveDesign,
                  buildError: flow.autoStartError,
                }}
              />
            ) : null}
          </div>
        )}
        {restored && flow.mode.kind === "create" && !pending && step <= FLOW_FORM_LAST_STEP ? (
          <button
            type="button"
            onClick={startOver}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background mx-auto mt-4 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-4 text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-offset-2"
            data-testid="wizard-start-over"
          >
            Start over
          </button>
        ) : null}
      </WizardBody>
    </div>
  );
}
