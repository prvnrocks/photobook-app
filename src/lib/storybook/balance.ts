// Photo / narrative balance of a storybook (target 65 / 35). Pure functions.
//
// The measure is PAGE AREA: every inner page counts once, and its `narrativeShare` says how much
// of it is text. The cover is not counted (it is always a photo). Page Composition uses
// `balanceOf` to steer the plan; the Critic uses `isBalanced` to decide whether to repair.

import { STORY_BALANCE } from "./schemas";
import type { StoryPage, Storybook } from "./types";

export type StoryBalance = {
  pages: number;
  photoShare: number;
  narrativeShare: number;
  /** narrativeShare − target (positive = too much text). */
  drift: number;
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export function balanceOf(
  pages: readonly Pick<StoryPage, "kind" | "narrativeShare">[],
  target: { narrativeShare: number } = STORY_BALANCE,
): StoryBalance {
  const inner = pages.filter((p) => p.kind !== "cover");
  if (inner.length === 0) return { pages: 0, photoShare: 0, narrativeShare: 0, drift: round4(-target.narrativeShare) };
  const narrative = inner.reduce((sum, p) => sum + p.narrativeShare, 0) / inner.length;
  return {
    pages: inner.length,
    photoShare: round4(1 - narrative),
    narrativeShare: round4(narrative),
    drift: round4(narrative - target.narrativeShare),
  };
}

export function isBalanced(b: StoryBalance, tolerance: number = STORY_BALANCE.tolerance): boolean {
  return b.pages > 0 && Math.abs(b.drift) <= tolerance + 1e-9;
}

export function storybookBalance(s: Pick<Storybook, "pages" | "target">): StoryBalance {
  return balanceOf(s.pages, s.target);
}

/**
 * How many of `pageCount` inner pages' worth of area should be narrative to hit the target —
 * the planning budget handed to the Story Planner (e.g. 20 pages → 7).
 */
export function narrativePageBudget(pageCount: number, narrativeShare: number = STORY_BALANCE.narrativeShare): number {
  if (!Number.isFinite(pageCount) || pageCount <= 0) return 0;
  return Math.round(pageCount * narrativeShare);
}
