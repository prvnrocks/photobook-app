"use client";
// Wizard step 6 "Sorting your photos" (M20 T6, D-072), shown in place inside /books/new. For now it
// renders the M19 <BuildProgress variant="wizard"> (photo fan + truthful checklist) with `onDone`, so
// a finished build moves the wizard to step 7 instead of replacing the URL with the editor. T7
// polishes it (stop states → onStopped, PhotoFan shuffle, sorting-motion.css, step-7 prefetch).
// G3: BuildProgress resumes `activeRunId`; only without one (fallback "Make my book now" / a run
// read error) does it POST a build, and the server answers 409 already_running for a queued run.

import { BuildProgress } from "@/components/review/BuildProgress";
import { PhotoFan } from "@/components/review/PhotoFan";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import type { BuildStopReason } from "@/lib/books/wizard-flow";
import { wizardHeadline } from "@/lib/books/wizard-steps";
import type { WizardStep6Data } from "@/lib/books/wizard-client";

export type StepSortingProps = {
  data: WizardStep6Data;
  /** id of the step headline (focused after a step change). */
  headlineId: string;
  /** The build finished → the wizard dispatches buildDone (step 7, by replace). */
  onDone: () => void;
  /** T7: a stop state (failed / limit / user_edited / …) → the wizard dispatches buildStopped. Not wired yet. */
  onStopped?: (reason: BuildStopReason) => void;
};

export function StepSorting({ data, headlineId, onDone }: StepSortingProps) {
  return (
    <div className="mx-auto flex w-full max-w-[40rem] min-w-0 flex-col" data-testid="wizard-step-sorting">
      <WizardHeadline id={headlineId} focusable>
        {wizardHeadline(6)}
      </WizardHeadline>
      <div className="mt-4 flex min-w-0 flex-col">
        <BuildProgress
          bookId={data.bookId}
          activeRunId={data.activeRunId}
          trigger={data.trigger}
          isPaid={data.isPaid}
          dailyCap={data.dailyCap}
          auto={data.auto}
          aiOn={data.aiOn}
          variant="wizard"
          preview={<PhotoFan urls={data.fanUrls} />}
          onDone={onDone}
        />
      </div>
    </div>
  );
}
