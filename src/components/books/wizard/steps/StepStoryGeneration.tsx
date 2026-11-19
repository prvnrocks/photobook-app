"use client";
// Wizard step 6 (Task 8): "Your memories are becoming a story." — the automatic first draft. Runs
// the book's storybook generation job (useStoryRun) and shows its four real stages (StoryProgress).
// The Design step's Continue starts the job and hands its answer over; a refresh re-attaches to the
// job the server reports in the step-6 data (`data.story`); without any job this step starts one
// (the server answers already_running for a second start, so repeated loads never make two).
// Finished → straight into the editor (step 7 Preview is only for books made by the old album flow).
// Stopped / failed → the plain reason + Try again (a new job that continues from where it stopped).

import { useEffect, useRef } from "react";
import { WizardHeadline } from "@/components/wizard/WizardHeadline";
import { WIZARD_SECONDARY_CLASS } from "@/components/wizard/WizardNav";
import { StoryProgress } from "@/components/story/StoryProgress";
import { useStoryRun, type StoryRunApi } from "@/components/story/useStoryRun";
import type { WizardStep6Data } from "@/lib/books/wizard-client";
import { STORY_HEADLINE, type StoryRunView } from "@/lib/storybook/run/progress";

/** Pause on "Your story is ready" before the editor opens (long enough to read; reduced motion too). */
export const STORY_READY_MS = 900;

export type StepStoryGenerationProps = {
  data: WizardStep6Data;
  headlineId: string;
  /** The finished job → open the editor (the wizard replaces its own entry). */
  onDone: () => void;
  /** The Design step's start answer (null = none: follow `data.story` or start here). */
  handover?: StoryRunView | null;
  /** Open the editor now (offered when a stopped job's book already has pages). */
  onOpenBook?: () => void;
  /** Test seam. */
  api?: StoryRunApi;
};

export function StepStoryGeneration({ data, headlineId, onDone, handover = null, onOpenBook, api }: StepStoryGenerationProps) {
  const initial = handover ?? data.story;
  const { phase, busy, stop, tryAgain } = useStoryRun({ bookId: data.bookId, initial, autoStart: true, api });
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  const doneRef = useRef(false);
  useEffect(() => {
    if (phase.kind !== "done" || doneRef.current) return;
    doneRef.current = true;
    const t = setTimeout(() => onDoneRef.current(), STORY_READY_MS);
    return () => clearTimeout(t);
  }, [phase.kind]);

  const bookLink = onOpenBook ? (
    <button type="button" className={WIZARD_SECONDARY_CLASS} onClick={onOpenBook} data-testid="story-open-book">
      Open my book
    </button>
  ) : null;

  return (
    <div className="flex w-full min-w-0 flex-col" data-testid="wizard-step-story-generation">
      <WizardHeadline id={headlineId} focusable align="start-lg">
        {STORY_HEADLINE}
      </WizardHeadline>
      <p className="mt-2 text-center text-base text-muted-foreground lg:text-start" data-testid="story-intro">
        We&rsquo;re making the first draft of your book from your photos. You can change everything afterwards.
      </p>
      <div className="mt-5 flex min-w-0 flex-col sm:mt-6">
        <StoryProgress phase={phase} busy={busy} onStop={stop} onTryAgain={tryAgain} bookLink={phase.kind === "stopped" || phase.kind === "error" ? bookLink : null} />
      </div>
    </div>
  );
}
