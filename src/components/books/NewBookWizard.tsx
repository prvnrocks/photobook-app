"use client";
// Book creation wizard steps 1–4 on /books/new (M19 T3/T4/T8, D-071).
//   - The step lives in the URL (?step=1..4). Continue / Back change it with window.history.pushState
//     (no router.push: the route is force-dynamic with a loading.tsx — no server round trip per step);
//     popstate drives the step, so browser back / forward work. Step label + progress render here.
//   - New book: the draft is mirrored to sessionStorage (WIZARD_DRAFT_STORAGE_KEY) so a refresh keeps
//     the choices; entering a step whose earlier answers are missing goes to the first missing step
//     (a visit with no stored draft starts at step 1). A restored draft shows a "Start over" button
//     (clears it, back to step 1). The stored draft is only cleared once the create succeeds.
//     Step-4 Continue submits hidden fields to createBookAction (tone is picked by the server). It
//     returns the new id: the current history
//     entry is replaced with the edit URL (/books/new?book=<id>&step=4) and we push
//     /books/<id>/upload (= step 5), so browser Back re-opens THIS book, never an empty wizard
//     (M19 BUG-2: duplicate drafts). If the router restores the cached create-mode page for that
//     entry, the mount sees ?book= in create mode and reloads it from the server (edit mode, or the
//     editor when the details are locked).
//   - Edit (T8, ?book=<id>): prefilled from the book (sessionStorage unused); step-4 Continue saves
//     with updateBookSetupAction and goes to /books/<id>/upload.
// First-load island: no cn / buttonVariants / next/link (the step-1 Back link comes from the server).

import { useRouter } from "next/navigation";
import { useActionState, useCallback, useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { createBookAction, updateBookSetupAction } from "@/app/books/actions";
import { initialNewBookFormState, type NewBookField, type NewBookFormState } from "@/app/books/form-state";
import { Notice } from "@/components/app/Notice";
import { WizardNav } from "@/components/wizard/WizardNav";
import { WizardBand } from "@/components/wizard/WizardBand";
import { WizardBody } from "@/components/wizard/WizardBody";
import type { CaptionLang } from "@/lib/book/options";
import type { BookSetupField, BookSetupPatch, SetupLockReason, UpdateBookSetupResult } from "@/lib/book/setup";
import {
  EMPTY_WIZARD_DRAFT,
  firstMissingStep,
  isAcceptableWizardTitle,
  parseFormStep,
  parseWizardDraft,
  serializeWizardDraft,
  WIZARD_DRAFT_STORAGE_KEY,
  wizardBackHref,
  type WizardDraft,
  type WizardFormStep,
} from "@/lib/books/wizard-steps";
import { effectiveStyle } from "@/lib/design/defaults";
import { StepOccasion } from "./wizard/StepOccasion";
import { StepShape } from "./wizard/StepShape";
import { StepStyle } from "./wizard/StepStyle";
import { StepTitle } from "./wizard/StepTitle";

export type NewBookWizardMode =
  | { kind: "create"; initialLang: CaptionLang }
  | { kind: "edit"; bookId: string; draft: WizardDraft; designLock: SetupLockReason | null };

export type NewBookWizardProps = {
  /** ?step= as the server parsed it. */
  initialStep: WizardFormStep;
  mode: NewBookWizardMode;
  /** Step-1 Back: a server-rendered <Link> to /dashboard. */
  dashboardBack: ReactNode;
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
};

function urlForStep(step: WizardFormStep): string {
  const u = new URL(window.location.href);
  u.searchParams.set("step", String(step));
  return `${u.pathname}${u.search}${u.hash}`;
}

function readStepFromUrl(): WizardFormStep {
  return parseFormStep(new URL(window.location.href).searchParams.get("step"));
}

/** Our own keys in history.state (Next merges its router state into the same object). */
type WizardHistoryState = { wizardStep?: number; wizardPrev?: number };

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

export function NewBookWizard({ initialStep, mode, dashboardBack }: NewBookWizardProps) {
  const edit = mode.kind === "edit" ? mode : null;
  const router = useRouter();
  const [draft, setDraft] = useState<WizardDraft>(() => edit?.draft ?? EMPTY_WIZARD_DRAFT);
  const [step, setStep] = useState<WizardFormStep>(initialStep);
  const [stepError, setStepError] = useState<StepError | null>(null);
  /** Direction of the last step change (null until the first change: no enter animation on load). */
  const [stepDir, setStepDir] = useState<"forward" | "back" | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const stepRef = useRef(step);
  stepRef.current = step;
  /** The user changed something (create): only then is the draft mirrored to sessionStorage. */
  const dirtyRef = useRef(false);
  const focusOnStepRef = useRef(false);

  const [state, formAction, creating] = useActionState<NewBookFormState, FormData>(
    createBookAction,
    initialNewBookFormState,
  );
  const [saving, startSaving] = useTransition();
  const [leaving, setLeaving] = useState(false);
  /** Create mode: steps 1–4 came back from sessionStorage (offer "Start over"). */
  const [restored, setRestored] = useState(false);
  // Create mode remounted on a created book's entry (see isCreatedBookEntry): render nothing but a
  // pending shell while the mount effect reloads. Always false on the server and on hydration (the
  // server renders ?book= in edit mode), so no mismatch.
  const [reopening] = useState(
    () => mode.kind === "create" && typeof window !== "undefined" && isCreatedBookEntry(window.location.href),
  );

  const captionLang: CaptionLang = draft.captionLang ?? (mode.kind === "create" ? mode.initialLang : "en");
  const style = effectiveStyle(draft.designStyle, draft.occasion);
  const designLocked = edit?.designLock != null;

  /** Show a step: push (Continue / Back / error jump) or replace (redirects). */
  const showStep = useCallback((next: WizardFormStep, how: "push" | "replace") => {
    const from = stepRef.current;
    const data: WizardHistoryState = { wizardStep: next, wizardPrev: how === "push" ? from : undefined };
    if (how === "push") window.history.pushState(data, "", urlForStep(next));
    else window.history.replaceState({ ...(window.history.state ?? {}), ...data }, "", urlForStep(next));
    if (next !== from) {
      focusOnStepRef.current = true;
      setStepDir(next < from ? "back" : "forward");
    }
    setStep(next);
  }, []);

  // Mount: restore the stored draft (create) and bounce a step whose earlier answers are missing.
  useEffect(() => {
    if (reopening) {
      wizardWindow.reload(window.location.href);
      return;
    }
    let current = draftRef.current;
    let fresh = false;
    if (mode.kind === "create") {
      const stored = readStored();
      if (stored) {
        current = { ...stored, captionLang: stored.captionLang ?? null };
        setDraft(current);
        setRestored(true);
      } else {
        fresh = true;
      }
    }
    const target = allowedStep(readStepFromUrl(), current, fresh);
    if (target !== stepRef.current || target !== readStepFromUrl()) showStep(target, "replace");
    // mode is fixed for the page's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser back / forward.
  useEffect(() => {
    function onPop() {
      const urlStep = readStepFromUrl();
      const target = allowedStep(urlStep, draftRef.current, false);
      if (target !== urlStep) window.history.replaceState(window.history.state, "", urlForStep(target));
      if (target !== stepRef.current) {
        focusOnStepRef.current = true;
        setStepDir(target < stepRef.current ? "back" : "forward");
      }
      setStep(target);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Mirror the new-book draft (never in edit mode).
  useEffect(() => {
    if (mode.kind === "create" && dirtyRef.current) writeStored(draft);
  }, [draft, mode.kind]);

  // Move focus to the new step's headline after a step change (keyboard / screen readers).
  useEffect(() => {
    if (!focusOnStepRef.current) return;
    focusOnStepRef.current = false;
    document.getElementById(HEADLINE_ID)?.focus();
  }, [step]);

  // createBookAction succeeded: point this history entry at the new book's edit URL, then go to step 5.
  const createdRef = useRef<NewBookFormState | null>(null);
  useEffect(() => {
    if (!state.ok || !state.bookId || !state.next || createdRef.current === state) return;
    createdRef.current = state; // once per result, whatever re-runs the effect
    setLeaving(true);
    // Only now is the stored draft done with (a failed or thrown action must not lose steps 1–4).
    writeStored(null);
    setRestored(false);
    window.history.replaceState(
      { ...(window.history.state ?? {}), wizardStep: 4, wizardPrev: undefined },
      "",
      wizardBackHref(state.bookId),
    );
    router.push(state.next);
  }, [state, router]);

  // createBookAction failed: keep the draft, jump to the failed step.
  useEffect(() => {
    if (state === initialNewBookFormState || state.ok) return;
    writeStored(draftRef.current);
    const err = errorFromFields(state.fieldErrors, state.error ?? "We couldn't create your book. Please try again.");
    setStepError(err);
    if (err.step !== stepRef.current) showStep(err.step, "push");
  }, [state, showStep]);

  function update(patch: Partial<WizardDraft>) {
    dirtyRef.current = true;
    setDraft((d) => ({ ...d, ...patch }));
  }

  function goBack() {
    if (step === 1) return;
    const prev = (step - 1) as WizardFormStep;
    const hs = (window.history.state ?? {}) as WizardHistoryState;
    // Came here with Continue from the previous step → a real history back keeps the stack tidy.
    if (hs.wizardPrev === prev && hs.wizardStep === step) window.history.back();
    else showStep(prev, "replace");
  }

  function saveEdit(bookId: string) {
    const d = draftRef.current;
    if (d.occasion === null) return;
    const patch: BookSetupPatch = {
      title: d.title.trim() === "" ? null : d.title,
      occasion: d.occasion,
      captionLang,
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
        setLeaving(true);
        router.push(`/books/${bookId}/upload`);
        return;
      }
      if (res.error === "unauthenticated") {
        window.location.assign(`/login?next=${encodeURIComponent(urlForStep(4))}`);
        return;
      }
      if (res.error === "locked") {
        // The details locked meanwhile (an AI build started): the editor is the way forward.
        setLeaving(true);
        router.push(`/books/${bookId}/edit`);
        return;
      }
      const err = res.fieldErrors
        ? errorFromFields(res.fieldErrors as Partial<Record<BookSetupField, string>>, EDIT_ERRORS[res.error])
        : { step: 4 as WizardFormStep, message: EDIT_ERRORS[res.error] };
      setStepError(err);
      if (err.step !== stepRef.current) showStep(err.step, "push");
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    if (step < 4) {
      e.preventDefault();
      if (!canContinue) return;
      setStepError(null);
      showStep((step + 1) as WizardFormStep, "push");
      return;
    }
    if (edit) {
      e.preventDefault();
      saveEdit(edit.bookId);
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
    showStep(1, "replace");
  }

  const pending = creating || saving || leaving || state.ok;
  const canContinue =
    step === 1
      ? isAcceptableWizardTitle(draft.title)
      : step === 2
        ? draft.occasion !== null
        : step === 3
          ? draft.format !== null
          : draft.occasion !== null && draft.format !== null;
  const errorHere = stepError && stepError.step === step ? stepError : null;
  const fieldError = (f: NewBookField) => (errorHere?.field === f ? errorHere.message : undefined);

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
    <div className="flex w-full min-w-0 flex-1 flex-col" data-testid="new-book-wizard" data-step={step} data-mode={mode.kind}>
      <WizardBand
        step={step}
        title={draft.title}
        canGoTo={(n) => n < step && !pending}
        onStepClick={(n) => {
          setStepError(null);
          showStep(n as WizardFormStep, "push");
        }}
      />
      <WizardBody wide>
      <form
        key={step}
        action={step === 4 && !edit ? formAction : undefined}
        onSubmit={onSubmit}
        noValidate
        className={`flex w-full min-w-0 flex-col gap-8 ${step === 1 ? "mx-auto max-w-[28rem]" : ""}`}
        data-testid="new-book-form"
        data-step-anim={stepDir ? "css" : undefined}
        data-step-dir={stepDir ?? undefined}
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
            captionLang={captionLang}
            onOccasion={(occasion) => update({ occasion })}
            onCaptionLang={(lang) => update({ captionLang: lang })}
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

        {step === 4 && !edit ? (
          <>
            <input type="hidden" name="title" value={draft.title} />
            <input type="hidden" name="occasion" value={draft.occasion ?? ""} />
            <input type="hidden" name="captionLang" value={captionLang} />
            <input type="hidden" name="format" value={draft.format ?? ""} />
            <input type="hidden" name="designStyle" value={style} />
          </>
        ) : null}

        <WizardNav
          back={step === 1 ? dashboardBack : undefined}
          onBack={step === 1 ? undefined : goBack}
          continueLabel="Continue"
          pendingLabel={step === 4 ? (edit ? "Saving…" : "Creating your book…") : undefined}
          pending={step === 4 && pending}
          disabled={!canContinue || pending}
          continueTestId={step === 4 ? (edit ? "wizard-save" : "create-book") : "wizard-continue"}
          className="mx-auto max-w-[28rem]"
        />
      </form>
      {restored && !edit && !pending ? (
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
