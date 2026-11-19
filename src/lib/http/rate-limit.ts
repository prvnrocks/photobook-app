import "server-only";
// Postgres-backed rate limiting (Task 9): a fixed-window counter in private.rate_limit_windows via
// public.rate_limit_hit (migration 2900). No extra paid service. Used by the AI-triggering routes
// (storybook runs, ✨ rewrites, album runs, photo finalize) and Stripe checkout.
//
// The bucket key is '<route>:<32 hex>': HMAC-SHA-256 of the user id keyed with the optional
// RATE_LIMIT_SECRET (else a plain SHA-256). The table never holds a user id; with the secret set,
// a key cannot be linked back to a user from the table alone.
//
// Fails OPEN (allowed) when the limiter cannot be reached or migration 2900 is missing: the per-book
// limits, daily run caps, spending caps and budgets still apply. Logs carry a code only.

import { createHash, createHmac } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { json } from "@/lib/http/json";

/** Per-user limits per route. Generous for real use, tight enough to stop loops and scripts. */
export const RATE_LIMITS = {
  /** POST /api/ai/story-runs — start / regenerate / complete a storybook. */
  story_runs: { limit: 10, windowSeconds: 600 },
  /** POST /api/ai/story-runs/[id]/advance — the client ticks every few seconds while a job runs. */
  story_tick: { limit: 120, windowSeconds: 60 },
  /** POST /api/books/[id]/story-rewrite — one page text at a time. */
  story_rewrite: { limit: 20, windowSeconds: 60 },
  /** POST /api/ai/runs — album build / rebuild. */
  ai_runs: { limit: 10, windowSeconds: 600 },
  /** POST /api/ai/rewrite — ✨ caption / description rewrite. */
  ai_rewrite: { limit: 20, windowSeconds: 60 },
  /** POST /api/books/[id]/finalize — photo ingest + analysis kick-off (also limited per book). */
  finalize: { limit: 30, windowSeconds: 60 },
  /** Stripe Checkout session creation. */
  checkout: { limit: 10, windowSeconds: 600 },
  /** Task 10: POST /api/books/[id]/pdf/package — cover + interior PDFs (downloads + splits a stored PDF). */
  print_package: { limit: 10, windowSeconds: 600 },
} as const;
export type RateLimitRoute = keyof typeof RATE_LIMITS;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** '<route>:<32 hex>' — the user id is never stored (keyed hash). */
export function rateLimitBucket(route: RateLimitRoute, subject: string, secret: string | undefined = process.env.RATE_LIMIT_SECRET): string {
  const hex = secret ? createHmac("sha256", secret).update(`rl:${subject}`).digest("hex") : createHash("sha256").update(`rl:${subject}`).digest("hex");
  return `${route}:${hex.slice(0, 32)}`;
}

export type RateLimitDeps = { hit?: (bucket: string, limit: number, windowSeconds: number) => Promise<number> };

async function defaultHit(bucket: string, limit: number, windowSeconds: number): Promise<number> {
  const { data, error } = await createAdminClient().rpc("rate_limit_hit", { p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds });
  if (error) throw Object.assign(new Error("rate_limit_hit failed"), { code: error.code });
  return typeof data === "number" ? data : Number(data) || 0;
}

const MISSING = new Set(["42883", "PGRST202", "42P01", "PGRST205"]);
let warnedMissing = false;

/** Counts one hit for `subject` (a user id) on `route`. Never throws. */
export async function checkRateLimit(route: RateLimitRoute, subject: string, deps: RateLimitDeps = {}): Promise<RateLimitResult> {
  const { limit, windowSeconds } = RATE_LIMITS[route];
  try {
    const wait = await (deps.hit ?? defaultHit)(rateLimitBucket(route, subject), limit, windowSeconds);
    return wait > 0 ? { allowed: false, retryAfterSeconds: Math.min(windowSeconds, Math.max(1, Math.ceil(wait))) } : { allowed: true };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "unknown";
    if (MISSING.has(code)) {
      if (!warnedMissing) console.error("[rate-limit] unavailable (migration 2900 missing)");
      warnedMissing = true;
    } else console.error(`[rate-limit] check_failed (${code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 16)})`);
    return { allowed: true };
  }
}

/** 429 { error: 'rate_limited' } + Retry-After, or null when allowed. For API routes. */
export async function rateLimitResponse(route: RateLimitRoute, subject: string, deps?: RateLimitDeps): Promise<Response | null> {
  const r = await checkRateLimit(route, subject, deps);
  return r.allowed ? null : json({ error: "rate_limited" }, 429, { "retry-after": String(r.retryAfterSeconds) });
}
