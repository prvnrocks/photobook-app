// Browser side of POST /api/books/[id]/finalize (T9): one call, plus up to
// `extraRuns` follow-up calls while places are still pending (the route caps
// geocoding per run). Counts only — nothing about the photos is sent or logged.
// The route allows one run per book per 10 s and answers 429 + Retry-After
// otherwise; we wait and retry (at most MAX_WAITS times per call) and space
// follow-up calls at least FOLLOW_UP_GAP_MS apart.
import type { FinalizeResult } from "@/lib/photos/finalize";
import { isUuid } from "@/lib/uuid";

export type { FinalizeResult };

export type FinalizeError = "signed_out" | "not_found" | "failed" | "rate_limited";

export type FinalizeOutcome =
  | { ok: true; result: FinalizeResult }
  | { ok: false; error: Exclude<FinalizeError, "rate_limited"> }
  | { ok: false; error: "rate_limited"; retryAfterMs: number };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export const DEFAULT_RETRY_AFTER_MS = 10_000;
export const MIN_RETRY_AFTER_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 60_000;
/** Max 429 waits per logical call. */
export const MAX_WAITS = 2;
export const RETRY_JITTER_MS = 300;
/** Server allows one run per book per 10 s; follow-ups wait a bit longer. */
export const FOLLOW_UP_GAP_MS = 10_500;

const NUMBER_KEYS = [
  "photos",
  "withDate",
  "withGps",
  "withPlace",
  "placesPending",
  "dupGroups",
  "dupPhotos",
  "pages",
] as const;

function isFinalizeResult(v: unknown): v is FinalizeResult {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    NUMBER_KEYS.every((k) => typeof o[k] === "number" && Number.isFinite(o[k])) &&
    typeof o.wroteDoc === "boolean"
  );
}

/**
 * Retry-After (delta seconds, or an HTTP date) → ms, clamped to 1–60 s.
 * Missing / unparsable → 10 s.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number {
  const clamp = (ms: number) => Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms));
  const raw = header?.trim();
  if (!raw) return DEFAULT_RETRY_AFTER_MS;
  if (/^\d+(\.\d+)?$/.test(raw)) return clamp(Math.ceil(Number(raw) * 1000));
  const date = /[a-z]/i.test(raw) ? Date.parse(raw) : NaN; // HTTP dates only, not "-3"
  if (Number.isFinite(date)) return clamp(date - now);
  return DEFAULT_RETRY_AFTER_MS;
}

export async function callFinalize(
  bookId: string,
  fetchImpl: FetchLike = (i, init) => fetch(i, init),
): Promise<FinalizeOutcome> {
  if (!isUuid(bookId)) return { ok: false, error: "not_found" };
  let res: Response;
  try {
    res = await fetchImpl(`/api/books/${bookId}/finalize`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "failed" };
  }
  if (res.status === 401) return { ok: false, error: "signed_out" };
  if (res.status === 404) return { ok: false, error: "not_found" };
  if (res.status === 429) {
    return { ok: false, error: "rate_limited", retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) };
  }
  if (!res.ok) return { ok: false, error: "failed" };
  try {
    const body: unknown = await res.json();
    return isFinalizeResult(body) ? { ok: true, result: body } : { ok: false, error: "failed" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export type FinalizeOptions = {
  /** Follow-up calls while placesPending > 0 (default 2). */
  extraRuns?: number;
  /** Injectable for tests. */
  sleep?: SleepFn;
  /** 0..1, injectable for tests (jitter). */
  random?: () => number;
  /** Stop issuing calls once aborted (screen left). */
  signal?: AbortSignal;
};

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One logical call: on 429 waits Retry-After (+ jitter) and retries, ≤ MAX_WAITS times. */
async function callWithWaits(
  bookId: string,
  fetchImpl: FetchLike | undefined,
  sleep: SleepFn,
  random: () => number,
  signal: AbortSignal | undefined,
): Promise<FinalizeOutcome> {
  let out = await callFinalize(bookId, fetchImpl);
  for (let waits = 0; waits < MAX_WAITS && !out.ok && out.error === "rate_limited"; waits++) {
    await sleep(out.retryAfterMs + Math.floor(random() * RETRY_JITTER_MS));
    if (signal?.aborted) return out;
    out = await callFinalize(bookId, fetchImpl);
  }
  return out;
}

/**
 * First call decides success. Follow-up calls (only while placesPending > 0)
 * improve the result, spaced ≥ FOLLOW_UP_GAP_MS apart; if one fails we keep
 * the last good result.
 */
export async function finalizeWithPlaces(
  bookId: string,
  fetchImpl?: FetchLike,
  opts: FinalizeOptions = {},
): Promise<FinalizeOutcome> {
  const { extraRuns = 2, sleep = defaultSleep, random = Math.random, signal } = opts;
  const first = await callWithWaits(bookId, fetchImpl, sleep, random, signal);
  if (!first.ok) return first;
  let result = first.result;
  for (let i = 0; i < extraRuns && result.placesPending > 0; i++) {
    await sleep(FOLLOW_UP_GAP_MS);
    if (signal?.aborted) break;
    const next = await callWithWaits(bookId, fetchImpl, sleep, random, signal);
    if (!next.ok) break;
    // Keep "wroteDoc" true if any run wrote the album.
    result = { ...next.result, wroteDoc: result.wroteDoc || next.result.wroteDoc };
  }
  return { ok: true, result };
}
