// Story Planner / Narrative Writer configuration from environment variables. Pure (env is a parameter).
//
//   AI_STORY_MODEL          model id for planning, writing and rewriting   default AI_MODEL (Opus, the stronger model)
//   AI_STORY_TIMEOUT_MS     hard timeout of one plan / chapter request      default 90000 (10000–180000)
//   AI_STORY_MAX_RETRIES    retries of 429 / 5xx / timeouts                 default 2 (0–4)
//
// A block rewrite always uses AGENT_TIMEOUT_MS.rewriter (15 s): the editor waits for it.
// Only models in PHOTO_MODELS are accepted (the transport sends `effort` and server-side refusal
// fallbacks, and every model there has a price in PRICING so the stored cost is real). Anything
// else falls back to the default and is reported in `modelFallback`.

import { PHOTO_MODELS, type PhotoModel } from "@/lib/ai/photo-intelligence/config";

export const STORY_MODELS = PHOTO_MODELS;
export type StoryModel = PhotoModel;
/**
 * Task 9: narrative writing (plan, chapters, rewrites, page intent) keeps the STRONGER model by
 * default — the same id as AI_MODEL (Opus) — while photo descriptions default to a smaller one. Configurable with
 * AI_STORY_MODEL.
 */
export const DEFAULT_STORY_MODEL: StoryModel = "claude-opus-5-5"; // = AI_MODEL (tests/ai/task9-metering.test.ts)

export const STORY_AI_DEFAULTS = { timeoutMs: 90_000, retries: 2 } as const;
const BOUNDS = { timeoutMs: [10_000, 180_000], retries: [0, 4] } as const;

export type StoryAiConfig = {
  model: StoryModel;
  /** True when AI_STORY_MODEL was set to something not in STORY_MODELS. */
  modelFallback: boolean;
  timeoutMs: number;
  retries: number;
};

type Env = Record<string, string | undefined>;

function intInRange(raw: string | undefined, fallback: number, [min, max]: readonly [number, number]): number {
  const t = (raw ?? "").trim();
  if (!/^\d{1,7}$/.test(t)) return fallback;
  return Math.min(max, Math.max(min, Number(t)));
}

export function readStoryAiConfig(env: Env = process.env): StoryAiConfig {
  const wanted = (env.AI_STORY_MODEL ?? "").trim();
  const known = (STORY_MODELS as readonly string[]).includes(wanted);
  return {
    model: known ? (wanted as StoryModel) : DEFAULT_STORY_MODEL,
    modelFallback: wanted !== "" && !known,
    timeoutMs: intInRange(env.AI_STORY_TIMEOUT_MS, STORY_AI_DEFAULTS.timeoutMs, BOUNDS.timeoutMs),
    retries: intInRange(env.AI_STORY_MAX_RETRIES, STORY_AI_DEFAULTS.retries, BOUNDS.retries),
  };
}
