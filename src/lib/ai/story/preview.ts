// Free storybook preview selection (Task 9) — pure.
//
// A preview is the first chapter(s) of the FULL plan: whole chapters are taken in order while they
// fit in `pages` interior pages; when that gives fewer than PREVIEW_MIN_PAGES, the next chapter's
// first pages fill up to `pages`. The closing page is never part of a preview. Only the chapters
// touched are written (one model call each); the rest of the plan is kept for the paid book, so
// completing it after payment writes the remaining chapters without re-analysing or re-planning.

import type { StoryPlan } from "./plan";

export const PREVIEW_MIN_PAGES = 4;
export const PREVIEW_MAX_PAGES = 6;

export type PreviewSelection = {
  /** Skeleton page ids of the preview, in book order. */
  pageIds: string[];
  /** Write groups (chapter ids) the preview needs, in order. Never "closing". */
  groups: string[];
};

export function previewSelection(plan: Pick<StoryPlan, "chapters" | "skeleton">, pages: number): PreviewSelection {
  const max = Math.min(PREVIEW_MAX_PAGES, Math.max(1, Math.floor(Number.isFinite(pages) ? pages : PREVIEW_MIN_PAGES)));
  const min = Math.min(PREVIEW_MIN_PAGES, max);
  const interior = plan.skeleton.pages.filter((p) => p.kind !== "closing" && p.kind !== "cover");
  const pageIds: string[] = [];
  const groups: string[] = [];
  for (const ch of plan.chapters) {
    const own = interior.filter((p) => p.chapterId === ch.id);
    if (own.length === 0) continue;
    if (pageIds.length + own.length <= max) {
      pageIds.push(...own.map((p) => p.id));
      groups.push(ch.id);
      if (pageIds.length === max) break;
      continue;
    }
    if (pageIds.length < min || groups.length === 0) {
      pageIds.push(...own.slice(0, max - pageIds.length).map((p) => p.id));
      groups.push(ch.id);
    }
    break;
  }
  return { pageIds, groups };
}
