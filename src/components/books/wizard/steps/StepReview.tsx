"use client";
// Wizard step 7 "Review your book" (M20 T6, D-072), shown in place inside /books/new. Placeholder so
// the flow works end to end: "AI kept X of Y", the title, and the gold "Generate album" (→ editor,
// the wizard's one real navigation). T8 fills it (cover, chapters, ReviewGrid toggles, caption
// previews, updateAlbumAction if unsynced → confirmAlbumAction).

import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { WizardNav } from "@/components/wizard/WizardNav";
import { wizardHeadline } from "@/lib/books/wizard-steps";
import type { WizardStep7Data } from "@/lib/books/wizard-client";

export type StepReviewProps = {
  data: WizardStep7Data;
  /** id of the step headline (focused after a step change). */
  headlineId: string;
  /** "Generate album": the wizard dispatches confirm → the editor. */
  onConfirm: () => void;
  /** The wizard is leaving for the editor. */
  confirming?: boolean;
};

export function StepReview({ data, headlineId, onConfirm, confirming = false }: StepReviewProps) {
  const { kept, total } = data.counts;
  return (
    <div className="mx-auto flex w-full max-w-[40rem] min-w-0 flex-col gap-6" data-testid="wizard-step-review">
      <div className="flex flex-col gap-2">
        <WizardHeadline id={headlineId} focusable>
          {wizardHeadline(7)}
        </WizardHeadline>
        <p className="text-center type-small text-muted-foreground">
          <span dir="auto" className="break-words" data-testid="review-book-title">
            {data.title}
          </span>
        </p>
      </div>
      <section className="rounded-2xl border border-border bg-card p-4 text-center shadow-card sm:p-6" data-testid="review-summary">
        <p className="type-h2 text-foreground" data-testid="review-kept">
          {data.aiUsed ? `AI kept ${kept} of ${total} photos` : `${kept} of ${total} photos in your book`}
        </p>
        {data.building ? (
          <p className="mt-2 type-small text-muted-foreground" role="status">
            Your book is still being made…
          </p>
        ) : null}
      </section>
      <WizardNav
        continueType="button"
        onContinue={onConfirm}
        continueLabel="Generate album"
        pendingLabel="Opening your book…"
        pending={confirming}
        disabled={data.building}
        continueTestId="wizard-generate"
        className="mx-auto max-w-[36rem]"
      />
    </div>
  );
}
