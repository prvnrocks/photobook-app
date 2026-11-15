"use client";
// Steps 5–7 of the /books/new wizard (M20 T6, D-072) in one code-split chunk (G5: none of this is in
// the route's first load; NewBookWizard prefetches it on idle from step 3). Loads the step's data
// from GET /api/books/<id>/wizard?step=N when the wizard doesn't hold it yet (createBookAction's
// step-5 data and hard-load server props arrive pre-filled), follows the server gate when the book
// has moved on (another tab: 5 → 6 / 7, editor, classic build), and renders StepPhotos /
// StepSorting / StepReview wired to the flow. Never navigates itself except through `leave`
// (editor / classic build / login).

import { useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { Notice } from "@/components/app/Notice";
import { WIZARD_BACK_CLASS } from "@/components/wizard/WizardNav";
import { fetchWizardStep, type WizardDataByStep, type WizardDataStepNumber } from "@/lib/books/wizard-client";
import { flowEditorHref, type FlowAction } from "@/lib/books/wizard-flow";
import type { AutoStartOutcome } from "@/lib/upload/auto-build-client";
import { StepPhotos } from "./StepPhotos";
import { StepReview } from "./StepReview";
import { StepSorting } from "./StepSorting";

export type WizardStepDataMap = { [S in WizardDataStepNumber]?: WizardDataByStep[S] };

export type WizardDataStepsProps = {
  step: WizardDataStepNumber;
  bookId: string;
  stepData: WizardStepDataMap;
  setStepData: Dispatch<SetStateAction<WizardStepDataMap>>;
  /** Flow actions (wizard-flow transition + effects, applied by NewBookWizard). */
  dispatch: (action: FlowAction) => unknown;
  /** Leave the wizard (full navigation). */
  leave: (href: string) => void;
  /** The wizard is leaving for the editor. */
  leaving: boolean;
  /** Step 6 data with ?auto=1 when the auto start began the run (ai_build_done { auto }). */
  autoRef: MutableRefObject<boolean>;
  headlineId: string;
};

const LOAD_ERRORS = {
  not_found: "We couldn't find this book.",
  unavailable: "This is taking longer than usual. Please try again in a moment.",
  failed: "We couldn't load this step. Check your connection and try again.",
} as const;

function loginHref(): string {
  return `/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`;
}

export function WizardDataSteps({
  step,
  bookId,
  stepData,
  setStepData,
  dispatch,
  leave,
  leaving,
  autoRef,
  headlineId,
}: WizardDataStepsProps) {
  const [loadError, setLoadError] = useState<keyof typeof LOAD_ERRORS | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const haveData = stepData[step] !== undefined;

  useEffect(() => {
    if (haveData) return;
    const ctrl = new AbortController();
    setLoadError(null);
    void fetchWizardStep(bookId, step, { auto: step === 6 && autoRef.current, signal: ctrl.signal }).then((res) => {
      if (ctrl.signal.aborted) return;
      if (!res.ok) {
        if (res.error === "signed_out") leave(loginHref());
        else setLoadError(res.error);
        return;
      }
      const r = res.data.resolved;
      if (r === "editor") return leave(flowEditorHref(bookId));
      if (r === "classic") return leave(`/books/${bookId}/build`);
      if (r !== step) {
        // Another tab / an earlier visit moved the book on (G3): follow the gate.
        if (step === 5 && r === 6) return void dispatch({ type: "runStarted" });
        if (step < 7 && r === 7) return void dispatch({ type: "buildDone" });
      }
      setStepData((d) => ({ ...d, [step]: res.data }));
    });
    return () => ctrl.abort();
  }, [step, bookId, haveData, reloadToken, autoRef, dispatch, leave, setStepData]);

  if (loadError && !haveData) {
    return (
      <Notice
        tone="error"
        data-testid="wizard-step-error"
        action={
          <button type="button" onClick={() => setReloadToken((t) => t + 1)} className={WIZARD_BACK_CLASS} data-testid="wizard-step-retry">
            Try again
          </button>
        }
      >
        {LOAD_ERRORS[loadError]}
      </Notice>
    );
  }

  const s5 = stepData[5];
  const s6 = stepData[6];
  const s7 = stepData[7];
  if (step === 5 && s5) {
    return (
      <StepPhotos
        data={s5}
        headlineId={headlineId}
        onBack={() => dispatch({ type: "back" })}
        onPhotosPicked={() => dispatch({ type: "photosPicked" })}
        onAdvance={(outcome: AutoStartOutcome) => {
          autoRef.current = outcome.kind === "started";
          dispatch({ type: "autoStart", outcome, retried: true, activeAtLoad: s5.firstRun === "active" });
        }}
        onBuildNow={() => dispatch({ type: "buildRequested" })}
      />
    );
  }
  if (step === 6 && s6) {
    return <StepSorting data={s6} headlineId={headlineId} onDone={() => dispatch({ type: "buildDone" })} />;
  }
  if (step === 7 && s7) {
    return <StepReview data={s7} headlineId={headlineId} onConfirm={() => dispatch({ type: "confirm" })} confirming={leaving} />;
  }
  return (
    <p className="mt-10 text-center text-sm text-muted-foreground" role="status" data-testid="wizard-step-loading">
      Loading…
    </p>
  );
}
