import "server-only";

// Anthropic client + model/pricing/mode configuration for the in-product AI pipeline.
// Server-only: the API key is read here and nowhere else (tests/boundaries.test.ts enforces it).

import Anthropic from "@anthropic-ai/sdk";

/** Default model for every agent step. Steps may override per request (AgentRequest.model). */
export const AI_MODEL = "claude-opus-5-5";

/** USD per million tokens. Cache write = 5-minute TTL (1.25x input). Keyed by model id. */
export const PRICING: Readonly<
  Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/**
 * Effort per agent (Opus 5.5 always thinks; depth is controlled by output_config.effort).
 * Always sent explicitly — the model default is "medium".
 */
export const EFFORT = {
  curator: "low",
  storyteller: "medium",
  caption_writer: "medium",
  /** Caption Writer repair round = caption rewrites (CLAUDE.md: rewrites use effort low). */
  caption_repair: "low",
  critic: "medium",
  rewriter: "low",
  memory_keeper: "low",
} as const;

/** Parallel Curator batches per wave (each batch = up to 10 thumbnails). */
export const CURATOR_CONCURRENCY = 5;

/**
 * Per-request timeouts in milliseconds (wall clock, incl. reading the body — see LiveTransport).
 * The Curator answers ≤ 10 thumbnails at effort low; the Storyteller writes one long plan at
 * effort medium (up to 16k output tokens incl. thinking) and gets its own tick (orchestrator).
 * Non-streaming is fine: the SDK only demands streaming for requests expected to exceed 10 min.
 */
export const AGENT_TIMEOUT_MS = {
  curator: 60_000,
  storyteller: 180_000,
  caption_writer: 90_000,
  critic: 90_000,
  rewriter: 60_000,
  memory_keeper: 60_000,
} as const;
/** Default when a request carries no timeout. */
export const AI_TIMEOUT_MS = 60_000;
/**
 * SDK-level retries: always 0 (client AND per request). runAgentStep owns retries so they are
 * budgeted against the tick lease (an SDK retry loop could outlive the lease).
 */
export const AI_SDK_MAX_RETRIES = 0;

/**
 * Server-side refusal fallbacks via the beta messages endpoint
 * (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`).
 * Verified in @anthropic-ai/sdk 1.6.0: `client.beta.messages.parse` accepts output_config,
 * betas and fallbacks. If the model does not support fallbacks the request simply runs
 * without them; the rule-based album still covers any refusal.
 */
export const USE_SERVER_FALLBACKS = true;
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type AiMode = "off" | "replay" | "live";
type Env = Record<string, string | undefined>;

const MODES: readonly AiMode[] = ["off", "replay", "live"];

/** True when an Anthropic API key is configured (never returns or logs the key). */
export function hasApiKey(env: Env = process.env): boolean {
  return (env.ANTHROPIC_API_KEY ?? "").trim() !== "";
}

/**
 * True for a production deployment: VERCEL_ENV=production, or — outside Vercel (no VERCEL_ENV,
 * e.g. a self-hosted `next start`) — NODE_ENV=production. On Vercel, NODE_ENV is ignored because
 * previews also run with NODE_ENV=production.
 */
export function isProductionEnv(env: Env = process.env): boolean {
  const vercelEnv = (env.VERCEL_ENV ?? "").trim();
  if (vercelEnv) return vercelEnv === "production";
  return env.NODE_ENV === "production";
}

/**
 * D-024. An explicit, valid AI_MODE wins, except `live` without a key degrades to `off` in
 * production and `replay` elsewhere. Without AI_MODE: key → live; no key → replay, except
 * production (isProductionEnv) → off, so real users never see synthetic "AI picks".
 */
export function resolveAiMode(env: Env = process.env): AiMode {
  const isProd = isProductionEnv(env);
  const key = hasApiKey(env);
  const explicit = (env.AI_MODE ?? "").trim().toLowerCase() as AiMode;

  if (MODES.includes(explicit)) {
    if (explicit === "live" && !key) return isProd ? "off" : "replay";
    return explicit;
  }
  if (key) return "live";
  return isProd ? "off" : "replay";
}

let cached: Anthropic | null = null;

/** Lazy singleton. Throws when no key is configured (callers should be in live mode only). */
export function getAnthropic(): Anthropic {
  if (cached) return cached;
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("Anthropic API key is not configured; AI mode must be 'off' or 'replay'.");
  }
  cached = new Anthropic({ apiKey, maxRetries: AI_SDK_MAX_RETRIES, timeout: AGENT_TIMEOUT_MS.storyteller });
  return cached;
}
