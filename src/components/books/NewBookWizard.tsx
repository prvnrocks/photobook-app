"use client";
// The book creation wizard on /books/new — one continuous 7-step wizard (M19 D-071, M20 D-072):
// 1 title → 2 purpose → 3 shape → 4 style → 5 photos → 6 sorting → 7 review → editor.
//   - The band, stepper, aside (steps 1–6; Review drops it for full width) and this component stay
//     mounted from step 1 to step 7; steps change in
//     place (document.startViewTransition via runViewTransition, CSS fallback — wizard-motion.css
//     contract: data-step-anim / data-step-dir on the keyed step container). The only real
//     navigation is the final move to the editor (window.location.assign).
//   - Every step change goes through the pure flow model (src/lib/books/wizard-flow.ts): transition()
//     returns the next state + an effect, applied here exactly as T3 specified: "push" (replaceCurrent
//     first, then history.pushState; preferHistoryBack → history.back() when the previous entry is
//     that step), "replace", "reload", "navigate". popstate feeds `popstate` actions, so browser
//     back / forward follow the same guardrails (G2: photos picked → steps 1–4 locked; run → ≤5
//     locked; done → 6 locked). Never router.push / router.refresh here (G1).
//   - Steps 1–4: the draft (title, occasion, shape, style). New book: mirrored to sessionStorage so a
//     refresh keeps it; entering a step whose earlier answers are missing goes to the first missing
//     one; a restored draft offers "Start over". Step-4 Continue submits createBookAction (it returns
//     the id + step-5 data) → `created` → step 5 in place; the step-4 history entry becomes the edit
//     URL so browser Back re-opens THIS book (M19 BUG-2). book_created is sent from here (the
//     one-shot ?_ev flash on the action's `next`; no navigation carries it any more).
//     Edit mode (?book=<id>, or after the create): prefilled; Continue saves with
//     updateBookSetupAction → `created` → step 5.
//   - Steps 5–7: WizardDataSteps (one code-split chunk, prefetched on idle from step 3 — G5) loads
//     GET /api/books/<id>/wizard?step=N unless the data is here already (createBookAction's step 5,
//     the server props on a hard load) and renders StepPhotos / StepSorting / StepReview.
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
import type { WizardDataStepNumber, WizardStepData } from "@/lib/books/wizard-client";
import {
  canGoTo as flowCanGoTo,
  FLOW_FORM_LAST_STEP,
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
import { effectiveStyle } from "@/lib/design/defaults";
import { canUseViewTransition, runViewTransition, type StepDirection } from "@/lib/ui/view-transition";
import { StepOccasion } from "./wizard/StepOccasion";
import { StepShape } from "./wizard/StepShape";
import { StepStyle } from "./wizard/StepStyle";
import { StepTitle } from "./wizard/StepTitle";
import { WizardBookPreview, WizardPreviewAside } from "./wizard/WizardBookPreview";
import { LazyWizardDataSteps, prefetchWizardSteps } from "./wizard/steps/lazy-steps";
// The step-5 upload stage's CSS rides in this route's stylesheet, not in the lazy steps chunk: an async
// chunk with CSS adds webpack's CSS-chunk loader to the runtime every route ships (+0.6 kB gzip).
import "@/components/upload/upload-motion.css";
import "./wizard/steps/sorting-motion.css";
import "./wizard/steps/review-motion.css";
import type { WizardStepDataMap } from "./wizard/steps/WizardDataSteps";

export type NewBookWizardMode =
  | { kind: "create" }
  | { kind: "edit"; bookId: string; draft: WizardDraft; designLock: SetupLockReason | null };

export type NewBookWizardProps = {
  /** The step the server resolved (create: 1–4; edit: 1–7 after the gate). */
  initialStep: FlowStep;
  mode: NewBookWizardMode;
  /** Step-1 Back: a server-rendered <Link> to /dashboard. */
  dashboardBack: ReactNode;
  /** Hard load of step 5–7: the server's loadWizardStep data for initialStep. */
  initialData?: WizardStepData | null;
};

/** The step that asks for each field (server errors jump there). Tone has no step → the last one. */
export const FIELD_STEP: Record<NewBookField, WizardFormStep> = {
  title: 1,
  occasion: 2,
  captionLang: 2,
  format: 3,
  designStyle: 4,
  tone: 4,
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

type StepError = { step: WizardFormStep; message: string; field?: NewBookField };
type StepAnim = { kind: "vt" | "css"; dir: StepDirection };

/** First (lowest-step) field error → where to show it. */
function errorFromFields(
  fieldErrors: Partial<Record<NewBookField, string>> | undefined,
  fallback: string,
): StepError {
  let best: StepError | null = null;
  for (const [field, message] of Object.entries(fieldErrors ?? {}) as [NewBookField, string | undefined][]) {
    if (!message || !(field in FIELD_STEP)) continue;
    const step = FIELD_STEP[field];
    if (!best || step < best.step) best = { step, message, field };
  }
  return best ?? { step: 4, message: fallback };
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
};

/** The flow state for the server's answer (hard load / first render). */
export function initialFlow(mode: NewBookWizardMode, step: FlowStep, data?: WizardStepData | null): FlowState {
  if (mode.kind === "create") return initFlowState({ step });
  const dataStep = data && data.bookId === mode.bookId ? data.step : null;
  return initFlowState({
    bookId: mode.bookId,
    step,
    runStarted: step === 6 || dataStep === 6,
    done: step === 7 || dataStep === 7,
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

  const [state, formAction, creating] = useActionState<NewBookFormState, FormData>(
    createBookAction,
    initialNewBookFormState,
  );
  const [saving, startSaving] = useTransition();
  const [leaving, setLeaving] = useState(false);
  /** Create mode: steps 1–4 came back from sessionStorage (offer "Start over"). */
  const [restored, setRestored] = useState(false);
  // Create mode remounted on a created book's entry (see isCreatedBookEntry): render nothing but a
  // pending shell while the mount effect reloads. Always false on the server and on hydration.
  const [reopening] = useState(
    () => mode.kind === "create" && typeof window !== "undefined" && isCreatedBookEntry(window.location.href),
  );

  const step = flow.step;
  const editingBookId = flow.mode.kind === "edit" ? flow.mode.bookId : null;
  const style = effectiveStyle(draft.designStyle, draft.occasion);
  const designLocked = edit?.designLock != null && edit.bookId === editingBookId;

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
  const leave = useCallback((href: string) => {
    setLeaving(true);
    wizardWindow.assign(href);
  }, []);

  // Mount: restore the stored draft (create), bounce a step whose earlier answers are missing, and
  // make the URL match the step the server resolved (edit).
  useEffect(() => {
    if (reopening) {
      wizardWindow.reload(window.location.href);
      return;
    }
    if (mode.kind === "edit") {
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
      current = { ...stored, captionLang: stored.captionLang ?? null };
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

  // Mode guard: the server sent another book / a fresh create wizard than the flow holds → reload.
  const propKey = mode.kind === "edit" ? `edit:${mode.bookId}` : "create";
  const propKeyRef = useRef(propKey);
  useEffect(() => {
    if (propKeyRef.current === propKey) return;
    propKeyRef.current = propKey;
    const fm = flowRef.current.mode;
    if (mode.kind === "edit") {
      if (fm.kind === "edit" && fm.bookId === mode.bookId) return;
    } else if (fm.kind === "create" || readUrl().book !== null) {
      // A cached create tree restored for an old step 1–3 entry: the popstate flow already showed it
      // as this book's edit URL.
      return;
    }
    wizardWindow.reload(window.location.href);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propKey]);

  // Browser back / forward → the flow (guardrails decide; refused → the URL shows the current step).
  useEffect(() => {
    function onPop() {
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
      if (stepParam !== url.step && res.effect.kind === "none") {
        apply(prev, { ...res, effect: { kind: "replace", url: urlFor(res.state) } });
        return;
      }
      apply(prev, res);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [apply]);

  // Mirror the new-book draft (create mode only).
  useEffect(() => {
    if (flow.mode.kind === "create" && dirtyRef.current) writeStored(draft);
  }, [draft, flow.mode.kind]);

  // G5: warm the step 5–7 chunks on idle once the user is two steps in.
  const warm = step >= 3;
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

  // Move focus to the new step's headline after a step change (keyboard / screen readers); steps 5–7
  // render it once their chunk / data is in.
  useEffect(() => {
    if (!focusOnStepRef.current) return;
    const h = document.getElementById(HEADLINE_ID);
    if (!h) return;
    focusOnStepRef.current = false;
    h.focus();
  }, [step, stepData]);

  // createBookAction succeeded: step 5 in place (the step-4 entry becomes the edit URL — flow effect).
  const createdRef = useRef<NewBookFormState | null>(null);
  useEffect(() => {
    if (!state.ok || !state.bookId || createdRef.current === state) return;
    createdRef.current = state; // once per result, whatever re-runs the effect
    // Only now is the stored draft done with (a failed or thrown action must not lose steps 1–4).
    writeStored(null);
    setRestored(false);
    trackCreated(state.next);
    const bookId = state.bookId;
    setStepData(state.step5 && state.step5.bookId === bookId ? { 5: state.step5 } : {});
    dispatch({ type: "created", bookId });
  }, [state, dispatch]);

  // createBookAction failed: keep the draft, jump to the failed step.
  useEffect(() => {
    if (state === initialNewBookFormState || state.ok) return;
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

  function saveEdit(bookId: string) {
    const d = draftRef.current;
    if (d.occasion === null) return;
    const patch: BookSetupPatch = {
      title: d.title.trim() === "" ? null : d.title,
      occasion: d.occasion,
      // No captionLang (D-072): the server re-derives it when the title changes.
    };
    if (!designLocked && d.format) {
      patch.format = d.format;
      patch.designStyle = effectiveStyle(d.designStyle, d.occasion);
    }
    setStepError(null);
    startSaving(async () => {
      let res: UpdateBookSetupResult;
      try {
        res = await updateBookSetupAction(bookId, patch);
      } catch {
        res = { ok: false, error: "failed" };
      }
      if (res.ok) {
        setStepData({}); // the setup changed: step 5 reloads its data
        dispatch({ type: "created", bookId });
        return;
      }
      if (res.error === "unauthenticated") {
        leave(loginHref());
        return;
      }
      if (res.error === "locked") {
        // The details locked meanwhile (an AI build started): the server gate picks the step.
        leave(`/books/new?book=${encodeURIComponent(bookId)}&step=5`);
        return;
      }
      const err = res.fieldErrors
        ? errorFromFields(res.fieldErrors as Partial<Record<BookSetupField, string>>, EDIT_ERRORS[res.error])
        : { step: 4 as WizardFormStep, message: EDIT_ERRORS[res.error] };
      setStepError(err);
      if (err.step !== flowRef.current.step) dispatch({ type: "goTo", step: err.step });
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    if (step < FLOW_FORM_LAST_STEP) {
      e.preventDefault();
      if (!canContinue) return;
      setStepError(null);
      dispatch({ type: "continue" });
      return;
    }
    if (editingBookId) {
      e.preventDefault();
      saveEdit(editingBookId);
      return;
    }
    // Create: the form action runs next. The stored draft stays until it succeeds (success effect).
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

  const pending = creating || saving || leaving;
  const formStep = (step <= FLOW_FORM_LAST_STEP ? step : FLOW_FORM_LAST_STEP) as WizardFormStep;
  const canContinue =
    formStep === 1
      ? isAcceptableWizardTitle(draft.title)
      : formStep === 2
        ? draft.occasion !== null
        : formStep === 3
          ? draft.format !== null
          : draft.occasion !== null && draft.format !== null;
  const errorHere = stepError && stepError.step === step ? stepError : null;
  // Live preview (M20 T4): the style tints / opens the book from step 4 on; steps 5–7 keep it open.
  const previewProps = {
    title: draft.title,
    occasion: draft.occasion,
    format: draft.format,
    designStyle: step >= 4 ? style : draft.designStyle,
    open: step >= 4,
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
        {/* Phones / tablets: the mini preview stays mounted above the (keyed) step form on steps 1–4,
            so it animates between steps (shrinks after step 1, morphs on a shape change, opens on 4). */}
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
            ) : step === 2 ? (
              <StepOccasion
                occasion={draft.occasion}
                onOccasion={(occasion) => update({ occasion })}
                headlineId={HEADLINE_ID}
                error={fieldError("occasion") ?? fieldError("captionLang")}
              />
            ) : step === 3 ? (
              <StepShape
                format={draft.format}
                onFormat={(format) => update({ format })}
                headlineId={HEADLINE_ID}
                locked={designLocked}
                error={fieldError("format")}
                title={draft.title}
                occasion={draft.occasion}
              />
            ) : (
              <StepStyle
                designStyle={style}
                format={draft.format ?? "A5_PORTRAIT"}
                onStyle={(designStyle) => update({ designStyle })}
                headlineId={HEADLINE_ID}
                locked={designLocked}
                error={fieldError("designStyle") ?? fieldError("tone")}
              />
            )}

            {step === FLOW_FORM_LAST_STEP && !editingBookId ? (
              <>
                <input type="hidden" name="title" value={draft.title} />
                <input type="hidden" name="occasion" value={draft.occasion ?? ""} />
                <input type="hidden" name="format" value={draft.format ?? ""} />
                <input type="hidden" name="designStyle" value={style} />
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
                step={step as WizardDataStepNumber}
                bookId={editingBookId}
                stepData={stepData}
                setStepData={setStepData}
                dispatch={dispatch}
                leave={leave}
                leaving={leaving}
                autoRef={autoRef}
                headlineId={HEADLINE_ID}
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
