"use client";
// Steps 3–7 of the /books/new wizard (M20 T6, D-072; Task 5 order) in one code-split chunk (G5: none
// of this is in the route's first load; NewBookWizard prefetches it on idle from step 2):
//   3 Photos (StepPhotos), 4 Story (StepStory), 5 Design (StepDesign), 6 Create (Task 8:
//   StepStoryGeneration — "Your memories are becoming a story."; StepSorting only for a book whose
//   active job is an old album build), 7 Preview (StepReview — books made by the old album flow).
// Steps 3, 6 and 7 load their data from GET /api/books/<id>/wizard?step=N when the wizard doesn't hold
// it yet (createBookAction's step-3 data and hard-load server props arrive pre-filled) and follow the
// server gate when the book has moved on (another tab: 3 → 6 / 7, editor, classic build). Steps 4 and
// 5 need no such data: they work from the book's setup the wizard holds and their own server actions.
// Never navigates itself except through `leave` (editor / classic build / login; the gate's "editor"
// replaces the wizard entry — M20c).
// Task 8: the automatic first draft is asked for HERE, when the Design step is left (never on the
// Photos step): the design is saved first (only when it differs), then POST /api/ai/story-runs
// (startStory, one request per tap). A started job's view is handed to step 6
// (`storyHandoverRef`) so it shows the job at once; already_running → step 6 follows the job the
// server reports; a refused start stays on step 5 with the reason (Continue asks again); an edited
// album → the editor. One click = one request (the button is busy meanwhile) and the server keeps
// one job per book whatever the client does. Finished → the editor directly (replace).

import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { Notice } from "@/components/app/Notice";
import { WIZARD_BACK_CLASS } from "@/components/wizard/WizardNav";
import type { Occasion } from "@/lib/book/options";
import type { DesignPick, StoredDesign } from "@/lib/books/design-choice";
import { fetchWizardStep, type WizardDataByStep, type WizardDataStepNumber } from "@/lib/books/wizard-client";
import { flowEditorHref, type AutoStartError, type FlowAction } from "@/lib/books/wizard-flow";
import type { DesignRecommendation } from "@/lib/design/recommend";
import { limitCopy } from "@/lib/runs/stage-copy";
import { startStory, storyStartErrorCopy, type StoryStartOutcome } from "@/lib/storybook/run/client";
import type { StoryRunView } from "@/lib/storybook/run/progress";
import type { AutoStartOutcome } from "@/lib/upload/auto-build-client";
import { StepDesign } from "./StepDesign";
import { StepPhotos } from "./StepPhotos";
import { StepReview } from "./StepReview";
import { StepSorting } from "./StepSorting";
import { StepStoryGeneration } from "./StepStoryGeneration";
import { StepStory, type StoryDraft } from "./StepStory";

export type WizardStepDataMap = { [S in WizardDataStepNumber]?: WizardDataByStep[S] };

/** The steps that need the book (3 Photos … 7 Preview). */
export type WizardBookStep = 3 | 4 | 5 | 6 | 7;

/** What the Story step needs from the wizard (its client copy lives there, across Back / Forward). */
export type WizardStoryProps = {
  occasion: Occasion | null;
  value: StoryDraft | null;
  onChange: (value: StoryDraft) => void;
};

/** What the Design step needs from the wizard. */
export type WizardDesignProps = {
  title: string;
  occasion: Occasion | null;
  stored: StoredDesign;
  pick: DesignPick;
  onPick: (pick: DesignPick) => void;
  recommendation: DesignRecommendation | null;
  onRecommendation: (recommendation: DesignRecommendation) => void;
  locked: boolean;
  /** The design couldn't be saved (shown on the step). */
  error: string | null;
  /** Saves the design when it differs from the stored book. false = stay (error shown / leaving). */
  save: () => Promise<boolean>;
  /** The flow's "no run came of it" state (limit / signed out / error). */
  buildError: AutoStartError | null;
};

/** Facts about the book the wizard remembers from the Photos step (null = not known in this session). */
export type WizardBookFacts = { isPaid: boolean; dailyCap: number | null; ready: number | null };

export type WizardDataStepsProps = {
  step: WizardBookStep;
  bookId: string;
  stepData: WizardStepDataMap;
  setStepData: Dispatch<SetStateAction<WizardStepDataMap>>;
  /** Flow actions (wizard-flow transition + effects, applied by NewBookWizard). */
  dispatch: (action: FlowAction) => unknown;
  /** Leave the wizard (full navigation; `replace` drops the current history entry). */
  leave: (href: string, opts?: { replace?: boolean }) => void;
  /** The wizard is leaving for the editor. */
  leaving: boolean;
  /** Step 6 data with ?auto=1 when the auto start began the run (ai_build_done { auto }). */
  autoRef: MutableRefObject<boolean>;
  /** M20b: the build request's answer for step 6 (null = none: step 6 resumes / starts as before). */
  handoverRef: MutableRefObject<Promise<AutoStartOutcome> | null>;
  headlineId: string;
  story: WizardStoryProps;
  design: WizardDesignProps;
  factsRef: MutableRefObject<WizardBookFacts>;
  /**
   * Task 8: the started job's first view, handed from the Design step to step 6. Owned by the wizard
   * (this component remounts per step). Absent → a local ref (tests).
   */
  storyHandoverRef?: MutableRefObject<StoryRunView | null>;
  /** Test seam: the storybook start request (defaults to startStory, one attempt per tap). */
  requestStory?: (bookId: string) => Promise<StoryStartOutcome>;
};

/** One attempt per tap (the button is busy meanwhile; a failure shows its reason and Continue asks again). */
const defaultRequestStory = (bookId: string) => startStory(bookId);

/**
 * How long the Design step waits for the build request's answer before moving on to step 6 with the
 * pending answer (same idea as the upload stage's HANDOVER_GRACE_MS).
 */
export const DESIGN_HANDOVER_GRACE_MS = 1_000;

export const BUILD_START_FAILED = "We couldn't start your book. Check your connection and try again.";

/** The Design step's line for a refused build request. */
export function buildErrorCopy(error: AutoStartError | null, facts: WizardBookFacts): string | null {
  if (!error) return null;
  if (!error.limit) return BUILD_START_FAILED;
  if (error.limit === "daily_builds" && facts.dailyCap === null) return "You've used today's AI builds — try again tomorrow.";
  return limitCopy(error.limit, facts.isPaid, facts.dailyCap ?? 0);
}

const isDataStep = (step: WizardBookStep): step is WizardDataStepNumber => step === 3 || step === 6 || step === 7;

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
  handoverRef,
  headlineId,
  story,
  design,
  factsRef,
  requestStory = defaultRequestStory,
  storyHandoverRef: storyHandoverProp,
}: WizardDataStepsProps) {
  const [loadError, setLoadError] = useState<keyof typeof LOAD_ERRORS | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const dataStep = isDataStep(step) ? step : null;
  const haveData = dataStep === null || stepData[dataStep] !== undefined;
  /** Design step: saving / asking for the build. */
  const [starting, setStarting] = useState(false);
  /** Design step: why the story could not start (null = no problem). */
  const [startError, setStartError] = useState<string | null>(null);
  /** The started job's first view, handed to step 6 (Task 8). */
  const localStoryHandover = useRef<StoryRunView | null>(null);
  const storyHandoverRef = storyHandoverProp ?? localStoryHandover;
  const startingRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (dataStep === null || haveData) return;
    const ctrl = new AbortController();
    setLoadError(null);
    void fetchWizardStep(bookId, dataStep, { auto: dataStep === 6 && autoRef.current, signal: ctrl.signal }).then((res) => {
      if (ctrl.signal.aborted) return;
      if (!res.ok) {
        if (res.error === "signed_out") leave(loginHref());
        else setLoadError(res.error);
        return;
      }
      const r = res.data.resolved;
      // M20c: replace — this wizard entry is dead for the book (user-edited or confirmed), so Back
      // from the editor must not land here again (no history loop).
      if (r === "editor") return leave(flowEditorHref(bookId), { replace: true });
      if (r === "classic") return leave(`/books/${bookId}/build`);
      // M20b: step 6 holding the build request's answer plays that run through (the gate may already say 7).
      const handedOver = dataStep === 6 && handoverRef.current !== null;
      if (r !== dataStep && !handedOver) {
        // Another tab / an earlier visit moved the book on (G3): follow the gate.
        if (dataStep === 3 && r === 6) return void dispatch({ type: "runStarted" });
        if (dataStep < 7 && r === 7) return void dispatch({ type: "buildDone" });
      }
      setStepData((d) => ({ ...d, [dataStep]: res.data }));
    });
    return () => ctrl.abort();
  }, [dataStep, bookId, haveData, reloadToken, autoRef, handoverRef, dispatch, leave, setStepData]);

  /**
   * Design → Create (Task 8): save the design (when it differs), then start the storybook job — the
   * only place the wizard does (never on the Photos step).
   */
  async function startBuild() {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setStartError(null);
    const done = () => {
      startingRef.current = false;
      if (aliveRef.current) setStarting(false);
    };
    let saved = false;
    try {
      saved = await design.save();
    } catch {
      saved = false;
    }
    if (!saved) return done();
    let out: StoryStartOutcome;
    try {
      out = await requestStory(bookId);
    } catch {
      out = { kind: "network" };
    }
    if (out.kind === "started" || out.kind === "already_running") {
      storyHandoverRef.current = out.kind === "started" ? out.view : null;
      autoRef.current = false;
      handoverRef.current = null;
      dispatch({ type: "buildRequested" });
      // The user stepped back while the request was out: the job exists all the same → step 6.
      dispatch({ type: "runStarted" });
      return done();
    }
    if (out.kind === "user_edited") {
      dispatch({ type: "autoStart", outcome: { kind: "user_edited" }, retried: true, activeAtLoad: false });
      return done();
    }
    if (out.kind === "signed_out") {
      done();
      return leave(loginHref());
    }
    if (aliveRef.current) setStartError(storyStartErrorCopy(out));
    done();
  }

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

  const s3 = stepData[3];
  const s6 = stepData[6];
  const s7 = stepData[7];
  if (step === 3 && s3) {
    return (
      <StepPhotos
        data={s3}
        headlineId={headlineId}
        onBack={() => dispatch({ type: "back" })}
        onPhotosPicked={() => dispatch({ type: "photosPicked" })}
        onBusyChange={(busy) => dispatch({ type: "uploadBusy", busy })}
        onContinue={(ready) => {
          factsRef.current = { ...factsRef.current, ready };
          // A return visit with photos already in the book: they lock steps 1–2 just the same.
          dispatch({ type: "photosPicked" });
          dispatch({ type: "continue" });
        }}
      />
    );
  }
  if (step === 4) {
    return (
      <StepStory
        bookId={bookId}
        occasion={story.occasion}
        headlineId={headlineId}
        value={story.value}
        onChange={story.onChange}
        onBack={() => dispatch({ type: "back" })}
        onContinue={() => dispatch({ type: "continue" })}
      />
    );
  }
  if (step === 5) {
    return (
      <StepDesign
        bookId={bookId}
        headlineId={headlineId}
        title={design.title}
        occasion={design.occasion}
        stored={design.stored}
        pick={design.pick}
        onPick={design.onPick}
        recommendation={design.recommendation}
        onRecommendation={design.onRecommendation}
        locked={design.locked}
        error={design.error}
        buildError={startError ?? buildErrorCopy(design.buildError, factsRef.current)}
        pending={starting || leaving}
        onBack={() => dispatch({ type: "back" })}
        onContinue={() => void startBuild()}
      />
    );
  }
  if (step === 6 && s6 && ((s6.story ?? null) !== null || !s6.activeRunId)) {
    return (
      <StepStoryGeneration
        data={s6}
        headlineId={headlineId}
        handover={storyHandoverRef.current && storyHandoverRef.current.runId !== s6.story?.runId ? storyHandoverRef.current : null}
        onDone={() => {
          storyHandoverRef.current = null;
          // Task 8 (req. 7): the finished storybook opens in the editor; the wizard entry is replaced
          // (the gate sends this book to the editor from now on).
          leave(flowEditorHref(bookId), { replace: true });
        }}
        onOpenBook={s6.hasDoc ? () => leave(flowEditorHref(bookId), { replace: true }) : undefined}
      />
    );
  }
  if (step === 6 && s6) {
    return (
      <StepSorting
        data={s6}
        headlineId={headlineId}
        handover={handoverRef.current}
        onDone={(s7data) => {
          handoverRef.current = null; // played through: a later step-6 view follows the gate again
          // M20 T7: step 7's data prefetched during the "ready" moment → step 7 opens without a fetch.
          if (s7data && s7data.step === 7 && s7data.bookId === bookId) setStepData((d) => ({ ...d, 7: s7data }));
          dispatch({ type: "buildDone" });
        }}
        onStopped={(reason) => dispatch({ type: "buildStopped", reason })}
        onResumed={() => dispatch({ type: "buildResumed" })}
      />
    );
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
