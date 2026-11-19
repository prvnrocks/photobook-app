"use client";
// Task 9: the free storybook preview line under the editor band (375 px first: one short sentence
// and one button, wrapping under each other on a phone).
//   locked   "This is a 5-page preview." + "Unlock the full book — AED 39" → the existing upgrade
//            sheet / Stripe Checkout (paid status only ever comes from the webhook)
//   complete "Your book is unlocked…" + "Complete my book" → the storybook job again, which continues
//            from the preview's plan and chapters (src/lib/ai/story/run.ts continueCursor)

import { Sparkles } from "lucide-react";
import { storyPreviewCopy, type StoryPreviewState } from "@/lib/editor/story-preview";

export function StoryPreviewBanner({ state, onUnlock, onComplete, disabled }: { state: Exclude<StoryPreviewState, null>; onUnlock: () => void; onComplete: () => void; disabled?: boolean }) {
  const copy = storyPreviewCopy(state);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-[#fbf6ea] px-4 py-2" role="status" data-testid="story-preview-banner" data-state={state.kind}>
      <p className="type-small min-w-0 flex-1 basis-48 text-foreground">{copy.text}</p>
      <button
        type="button"
        onClick={state.kind === "complete" ? onComplete : onUnlock}
        disabled={disabled}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-[#0E3B2E] px-4 text-sm font-semibold text-white hover:bg-[#0b2f25] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
        data-testid={state.kind === "complete" ? "story-complete-button" : "story-unlock-button"}
      >
        <Sparkles className="size-4" aria-hidden="true" />
        {copy.cta}
      </button>
    </div>
  );
}
