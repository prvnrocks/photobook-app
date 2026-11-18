"use client";
// Wizard step 3 "Add your photos" (M20 T6, D-072; Task 5 order), shown in place inside /books/new: the
// headline, the book title (dir="auto") and <Uploader variant="wizard"> with the T5 upload stage.
// Nothing here navigates and — since Task 5 — nothing here starts a build: when the photos are in,
// "Continue" goes on to the Story step (the first build is requested when the Design step is left).
// Back, Continue and the upload's busy state go to the wizard's flow (src/lib/books/wizard-flow.ts)
// through the callbacks. In the lazy steps chunk (not in the /books/new first load).

import { Uploader } from "@/components/upload/Uploader";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { wizardHeadline } from "@/lib/books/wizard-steps";
import type { WizardStep3Data } from "@/lib/books/wizard-client";

export type StepPhotosProps = {
  data: WizardStep3Data;
  /** id of the step headline (focused after a step change). */
  headlineId: string;
  /** Back to step 2 (edit mode); shown until the first photo is picked. */
  onBack: () => void;
  onPhotosPicked: () => void;
  /** "Continue" (the book has photos and the upload settled) → the Story step. `ready` = photos in the book. */
  onContinue: (ready: number) => void;
  /** An upload / finalize started (true) or settled (false): the wizard stays on this step meanwhile. */
  onBusyChange?: (busy: boolean) => void;
};

export function StepPhotos({ data, headlineId, onBack, onPhotosPicked, onContinue, onBusyChange }: StepPhotosProps) {
  return (
    <div className="mx-auto flex w-full max-w-[40rem] min-w-0 flex-col lg:mx-0" data-testid="wizard-step-photos">
      <WizardHeadline id={headlineId} focusable align="start-lg">
        {wizardHeadline(3)}
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
          onContinue={onContinue}
          onBusyChange={onBusyChange}
        />
      </div>
    </div>
  );
}
