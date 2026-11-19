// Free storybook preview configuration (Task 9). Pure (env is a parameter), no secrets — the page
// count is also shown in the editor's preview banner (passed down from the server).
//
//   AI_PREVIEW_PAGES      interior pages of a free storybook preview   default 5   (4–6)
//   AI_PREVIEW_MAX_RUNS   live preview generations per book            default 3   (1–10)
//                         = the first preview + 2 regenerations; counted server-side over finished
//                         live preview runs of the book (src/lib/db/agent-runs.ts countPreviewRuns)
//
// Invalid values fall back to the default (never "unlimited").

export const PREVIEW_DEFAULTS = { pages: 5, maxRuns: 3 } as const;
export const PREVIEW_BOUNDS = { pages: [4, 6], maxRuns: [1, 10] } as const;

export type PreviewConfig = { pages: number; maxRuns: number };

type Env = Record<string, string | undefined>;

function intInRange(raw: string | undefined, fallback: number, [min, max]: readonly [number, number]): number {
  const t = (raw ?? "").trim();
  if (!/^\d{1,4}$/.test(t)) return fallback;
  return Math.min(max, Math.max(min, Number(t)));
}

export function readPreviewConfig(env: Env = process.env): PreviewConfig {
  return {
    pages: intInRange(env.AI_PREVIEW_PAGES, PREVIEW_DEFAULTS.pages, PREVIEW_BOUNDS.pages),
    maxRuns: intInRange(env.AI_PREVIEW_MAX_RUNS, PREVIEW_DEFAULTS.maxRuns, PREVIEW_BOUNDS.maxRuns),
  };
}
