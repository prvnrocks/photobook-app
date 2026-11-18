// Photo Intelligence configuration from environment variables. Pure (env is a parameter).
//
//   AI_PHOTO_MODEL          model id for photo analysis   default AI_MODEL
//   AI_PHOTO_CONCURRENCY    parallel analyses per call    default 4   (1–8)
//   AI_PHOTO_TIMEOUT_MS     hard timeout of one request   default 30000 (5000–120000)
//   AI_PHOTO_MAX_RETRIES    retries of 429 / 5xx / timeouts default 2 (0–4)
//
// Only models in PHOTO_MODELS are accepted: the transport sends `effort` and server-side refusal
// fallbacks, which not every model takes, and every model here has a price in PRICING so the
// stored cost is real. Anything else falls back to AI_MODEL (reported in `modelFallback`).
//
// Data terms: requests go to the Anthropic API with the project's API key (commercial terms —
// inputs and outputs are not used to train models unless the customer opts in). Nothing here
// enables any data-sharing or feedback feature.

export const DEFAULT_PHOTO_MODEL = "claude-opus-5-5";
export const PHOTO_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"] as const;
export type PhotoModel = (typeof PHOTO_MODELS)[number];

export const PHOTO_AI_DEFAULTS = { concurrency: 4, timeoutMs: 30_000, retries: 2 } as const;
const BOUNDS = { concurrency: [1, 8], timeoutMs: [5_000, 120_000], retries: [0, 4] } as const;

export type PhotoAiConfig = {
  model: PhotoModel;
  /** True when AI_PHOTO_MODEL was set to something not in PHOTO_MODELS. */
  modelFallback: boolean;
  concurrency: number;
  timeoutMs: number;
  retries: number;
};

type Env = Record<string, string | undefined>;

function intInRange(raw: string | undefined, fallback: number, [min, max]: readonly [number, number]): number {
  const t = (raw ?? "").trim();
  if (!/^\d{1,7}$/.test(t)) return fallback;
  return Math.min(max, Math.max(min, Number(t)));
}

export function readPhotoAiConfig(env: Env = process.env): PhotoAiConfig {
  const wanted = (env.AI_PHOTO_MODEL ?? "").trim();
  const known = (PHOTO_MODELS as readonly string[]).includes(wanted);
  return {
    model: known ? (wanted as PhotoModel) : DEFAULT_PHOTO_MODEL,
    modelFallback: wanted !== "" && !known,
    concurrency: intInRange(env.AI_PHOTO_CONCURRENCY, PHOTO_AI_DEFAULTS.concurrency, BOUNDS.concurrency),
    timeoutMs: intInRange(env.AI_PHOTO_TIMEOUT_MS, PHOTO_AI_DEFAULTS.timeoutMs, BOUNDS.timeoutMs),
    retries: intInRange(env.AI_PHOTO_MAX_RETRIES, PHOTO_AI_DEFAULTS.retries, BOUNDS.retries),
  };
}
