"use client";
// Wizard step 5 "Add your photos" (M20 T6, D-072), shown in place inside /books/new: the headline, the
// book title (dir="auto") and <Uploader variant="wizard"> with the T5 upload stage. Nothing here
// navigates — Back, the auto-start answer and "Make my book now" go to the wizard's flow
// (src/lib/books/wizard-flow.ts) through the callbacks. Loaded with next/dynamic (not in the
// /books/new first load); NewBookWizard prefetches the chunk on idle from step 3.

import { Uploader } from "@/components/upload/Uploader";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { wizardHeadline } from "@/lib/books/wizard-steps";
import type { WizardStep5Data } from "@/lib/books/wizard-client";
import type { AutoStartOutcome } from "@/lib/upload/auto-build-client";

export type StepPhotosProps = {
  data: WizardStep5Data;
  /** id of the step headline (focused after a step change). */
  headlineId: string;
  /** Back to step 4 (edit mode); shown until the first photo is picked. */
  onBack: () => void;
  onPhotosPicked: () => void;
  /** The automatic first build answered with a "move on" outcome (after the success burst). */
  onAdvance: (outcome: AutoStartOutcome) => void;
  /** M20b: the success burst ended before the answer → step 6 now, with the pending answer. */
  onAdvancePending: (answer: Promise<AutoStartOutcome>) => void;
  /** Fallback "Make my book now" → step 6, where the build starts. */
  onBuildNow: () => void;
};

export function StepPhotos({ data, headlineId, onBack, onPhotosPicked, onAdvance, onAdvancePending, onBuildNow }: StepPhotosProps) {
  return (
    <div className="mx-auto flex w-full max-w-[40rem] min-w-0 flex-col lg:mx-0" data-testid="wizard-step-photos">
      <WizardHeadline id={headlineId} focusable align="start-lg">
        {wizardHeadline(5)}
      </WizardHeadline>
      <p className="mt-2 text-center type-small text-muted-foreground lg:text-start">
        <span dir="auto" className="break-words" data-testid="upload-book-title">
          {data.title}
        </span>
      </p>
      <div className="mt-6 flex min-w-0 flex-col">
        <Uploader
          bookId={data.bookId}
          userId={data.userId}
          isPaid={data.isPaid}
          existing={data.existing}
          maxUpload={data.maxUpload}
          readyCount={data.readyCount}
          pendingCount={data.pendingCount}
          hasDoc={data.hasDoc}
          firstRun={data.firstRun}
          dailyCap={data.dailyCap}
          aiOn={data.aiOn}
          variant="wizard"
          onBack={onBack}
          onPhotosPicked={onPhotosPicked}
          onAdvance={onAdvance}
          onAdvancePending={onAdvancePending}
          onBuildNow={onBuildNow}
        />
      </div>
    </div>
  );
}
