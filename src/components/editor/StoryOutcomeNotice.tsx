"use client";
// Task 8: one honest line under the editor band after a storybook was generated with fallbacks —
// "Made without AI: …", "Some chapters have no text yet …" (src/lib/storybook/run/progress.ts
// outcomeCopy). Nothing is shown when everything used AI. Dismissible; the dismissal is remembered
// per job for this browser session, so it doesn't come back on every load.

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { outcomeCopy, type StoryRunView } from "@/lib/storybook/run/progress";

const KEY = (runId: string) => `story-outcome-dismissed:${runId}`;

export function StoryOutcomeNotice({ view }: { view: StoryRunView }) {
  const copy = view.state === "done" ? outcomeCopy(view.progress.outcome) : null;
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      setDismissed(window.sessionStorage.getItem(KEY(view.runId)) === "1");
    } catch {
      setDismissed(false);
    }
  }, [view.runId]);
  if (!copy || dismissed) return null;
  return (
    <div className="flex items-start gap-2 border-b border-border bg-secondary px-4 py-2" role="status" data-testid="story-outcome-notice">
      <p className="type-small min-w-0 flex-1 text-foreground">{copy}</p>
      <button
        type="button"
        className="-my-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(true);
          try {
            window.sessionStorage.setItem(KEY(view.runId), "1");
          } catch {
            /* private mode: dismissed for this view only */
          }
        }}
        data-testid="story-outcome-dismiss"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
