// Task 9: what the editor says about a free storybook PREVIEW (pure; tested in node).
//
//   locked    the newest storybook job made the preview and the book has no full entitlement →
//             "This is a 5-page preview. Unlock the full book — AED 39" (opens the upgrade sheet;
//             the Stripe webhook is the only thing that unlocks it)
//   complete  the preview was made, and the book now has a full entitlement (paid / granted) →
//             "Complete my book" starts the continuation job (same plan, no re-analysis)
//   null      anything else (classic album, a full storybook, a job still running or failed)

import { UPGRADE } from "@/lib/pricing";
import type { StoryRunView } from "@/lib/storybook/run/progress";

export type StoryPreviewState = { kind: "locked"; pages: number } | { kind: "complete" } | null;

export function storyPreviewState(story: { latest: StoryRunView | null; tier?: "preview" | "full" } | undefined): StoryPreviewState {
  const latest = story?.latest;
  if (!latest || latest.state !== "done" || !latest.progress.preview) return null;
  if (story?.tier === "full") return { kind: "complete" };
  return { kind: "locked", pages: latest.progress.preview.pages };
}

export function storyPreviewCopy(state: Exclude<StoryPreviewState, null>): { text: string; cta: string } {
  if (state.kind === "complete") return { text: "Your book is unlocked. We'll write the rest of your story from the same plan.", cta: "Complete my book" };
  return { text: `This is a ${state.pages}-page preview.`, cta: `Unlock the full book — ${UPGRADE.label}` };
}
