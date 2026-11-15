"use client";
// Wizard step 6 "Sorting your photos" (M20 T6/T7, D-072), shown in place inside /books/new.
// <BuildProgress variant="wizard"> runs the build; the user's photos (<PhotoFan>, data.fanUrls) move
// with the run state the server reports (fan → shuffle into moment piles → ready), beside the
// three-row checklist on ≥ lg. Motion: sorting-motion.css (imported by NewBookWizard).
// When the run finishes: a short "Your book is ready to review" moment (READY_MS) while step 7's data
// is prefetched (fetchWizardStep(bookId, 7)), then onDone(step7Data?) — the wizard hands that data to
// step 7 so it opens without a loading line. Stop states → onStopped (buildStopped); the card itself
// (Open my book / Try again) is drawn by BuildProgress.
// G3: BuildProgress resumes `activeRunId`; only without one (fallback "Make my book now" / a run
// read error) does it POST a build, and the server answers 409 already_running for a queued run.

import { useCallback, useEffect, useRef } from "react";
import { BuildProgress } from "@/components/review/BuildProgress";
import { PhotoFan } from "@/components/review/PhotoFan";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { fetchWizardStep, type WizardStep6Data, type WizardStep7Data } from "@/lib/books/wizard-client";
import type { BuildStopReason } from "@/lib/books/wizard-flow";
import { wizardHeadline } from "@/lib/books/wizard-steps";

/** The "ready" moment before step 7 (the stack + badge animation runs ~1.2 s). */
export const READY_MS = 1_400;
/** Same moment with reduced motion: long enough to read the line. */
export const READY_MS_REDUCED = 800;
/** Wait at most this long (after the ready moment) for step 7's data; later → step 7 loads it itself. */
export const PREFETCH_WAIT_MS = 2_500;

export type StepSortingProps = {
  data: WizardStep6Data;
  /** id of the step headline (focused after a step change). */
  headlineId: string;
  /** The build finished → the wizard dispatches buildDone (step 7, by replace). `step7` = prefetched data, if it arrived. */
  onDone: (step7?: WizardStep7Data) => void;
  /** A stop state (failed / limit / user_edited / …) → the wizard dispatches buildStopped. */
  onStopped?: (reason: BuildStopReason) => void;
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

export function StepSorting({ data, headlineId, onDone, onStopped }: StepSortingProps) {
  const bookId = data.bookId;
  const finishingRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const finish = useCallback(() => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    const ctrl = new AbortController();
    // Step 7 data for a finished run (the gate resolves 7); anything else → step 7 fetches itself.
    const step7 = fetchWizardStep(bookId, 7, { signal: ctrl.signal })
      .then((r) => (r.ok && r.data.resolved === 7 ? r.data : undefined))
      .catch(() => undefined);
    const ready = wait(prefersReducedMotion() ? READY_MS_REDUCED : READY_MS);
    void ready
      .then(() => Promise.race([step7, wait(PREFETCH_WAIT_MS).then(() => undefined)]))
      .then((d) => {
        if (!d) ctrl.abort();
        if (aliveRef.current) onDoneRef.current(d);
      });
  }, [bookId]);

  return (
    <div className="flex w-full min-w-0 flex-col" data-testid="wizard-step-sorting">
      <WizardHeadline id={headlineId} focusable>
        {wizardHeadline(6)}
      </WizardHeadline>
      <div className="mt-4 flex min-w-0 flex-col sm:mt-6">
        <BuildProgress
          bookId={bookId}
          activeRunId={data.activeRunId}
          trigger={data.trigger}
          isPaid={data.isPaid}
          dailyCap={data.dailyCap}
          auto={data.auto}
          aiOn={data.aiOn}
          variant="wizard"
          preview={<PhotoFan urls={data.fanUrls} />}
          onDone={finish}
          onStop={onStopped}
        />
      </div>
    </div>
  );
}
