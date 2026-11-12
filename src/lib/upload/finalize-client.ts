// Browser side of POST /api/books/[id]/finalize (T9): one call, plus up to
// `extraRuns` follow-up calls while places are still pending (the route caps
// geocoding per run). Counts only — nothing about the photos is sent or logged.
// The route allows one run per book per 10 s and answers 429 + Retry-After
// otherwise; we wait and retry (at most MAX_WAITS times per call) and space
// follow-up calls at least FOLLOW_UP_GAP_MS apart.
// M10c: the first logical call may carry { colors: { photoId: "#rrggbb" } } (photos.color is
// server-written); follow-ups send no body. Colours are never logged.
// M12 T5: each request has a REQUEST_TIMEOUT_MS deadline (the route's maxDuration is 60 s); a hung
// request is aborted and counts as "unavailable". 503 (Supabase timeout, Retry-After 10) is also
// "unavailable". Both are waited out like 429, sharing the same MAX_WAITS budget per logical call.
import { isPhotoColor } from "@/lib/image/color";
import type { FinalizeResult } from "@/lib/photos/finalize";
import { isUuid } from "@/lib/uuid";

export type { FinalizeResult };

export type FinalizeError = "signed_out" | "not_found" | "failed" | "rate_limited" | "unavailable";

/** Errors the client waits out and retries by itself (429, 503 / hung request). */
export type WaitableFinalizeError = "rate_limited" | "unavailable";

export type FinalizeOutcome =
  | { ok: true; result: FinalizeResult }
  | { ok: false; error: Exclude<FinalizeError, WaitableFinalizeError> }
  | { ok: false; error: WaitableFinalizeError; retryAfterMs: number };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export const DEFAULT_RETRY_AFTER_MS = 10_000;
export const MIN_RETRY_AFTER_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 60_000;
/** Max 429 / 503 / timeout waits per logical call. */
export const MAX_WAITS = 2;
/** Client deadline per finalize request (response + body); the route's maxDuration is 60 s. */
export const REQUEST_TIMEOUT_MS = 75_000;
/** Wait before retrying a request that hit the deadline (the route's 10 s window has long passed). */
export const TIMEOUT_RETRY_MS = 1_000;
export const RETRY_JITTER_MS = 300;
/** Server allows one run per book per 10 s; follow-ups wait a bit longer. */
export const FOLLOW_UP_GAP_MS = 10_500;
/** Max colour entries per finalize body (the route rejects more). */
export const MAX_COLORS_PER_CALL = 500;

export type PhotoColors = Record<string, string>;

/** Valid entries only (uuid key, lowercase #rrggbb), at most MAX_COLORS_PER_CALL. */
export function colorsBody(colors: PhotoColors | undefined): PhotoColors | null {
  if (!colors) return null;
  const out: PhotoColors = {};
  let n = 0;
  for (const [id, hex] of Object.entries(colors)) {
    if (n >= MAX_COLORS_PER_CALL) break;
    if (!isUuid(id) || !isPhotoColor(hex)) continue;
    out[id] = hex;
    n++;
  }
  return n > 0 ? out : null;
}

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

type CallOptions = {
  /** Aborts the in-flight request too (screen left). */
  signal?: AbortSignal;
  timeoutMs?: number;
};

const TIMED_OUT = Symbol("timed_out");

export async function callFinalize(
  bookId: string,
  fetchImpl: FetchLike = (i, init) => fetch(i, init),
  colors?: PhotoColors,
  opts: CallOptions = {},
): Promise<FinalizeOutcome> {
  if (!isUuid(bookId)) return { ok: false, error: "not_found" };
  const body = colorsBody(colors);
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Resolves (never rejects) at the deadline, so a fetch that ignores its signal can't hang us.
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(TIMED_OUT);
    }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  });
  const request = async (): Promise<FinalizeOutcome> => {
    let res: Response;
    try {
      res = await fetchImpl(`/api/books/${bookId}/finalize`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: ctrl.signal,
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ colors: body }) } : {}),
      });
    } catch {
      return { ok: false, error: "failed" };
    }
    if (res.status === 401) return { ok: false, error: "signed_out" };
    if (res.status === 404) return { ok: false, error: "not_found" };
    if (res.status === 429 || res.status === 503) {
      return {
        ok: false,
        error: res.status === 429 ? "rate_limited" : "unavailable",
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      };
    }
    if (!res.ok) return { ok: false, error: "failed" };
    try {
      const json: unknown = await res.json();
      return isFinalizeResult(json) ? { ok: true, result: json } : { ok: false, error: "failed" };
    } catch {
      return { ok: false, error: "failed" };
    }
  };
  try {
    const out = await Promise.race([request(), deadline]);
    return out === TIMED_OUT ? { ok: false, error: "unavailable", retryAfterMs: TIMEOUT_RETRY_MS } : out;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

function isWaitable(out: FinalizeOutcome): out is Extract<FinalizeOutcome, { retryAfterMs: number }> {
  return !out.ok && (out.error === "rate_limited" || out.error === "unavailable");
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
  /** M10c: photo colours for the first call (and its 429 retries); follow-ups send none. */
  colors?: PhotoColors;
  /** Per-request deadline (default REQUEST_TIMEOUT_MS); injectable for tests. */
  requestTimeoutMs?: number;
};

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One logical call: on 429 / 503 / a hung request waits Retry-After (+ jitter) and retries,
 * ≤ MAX_WAITS times in total.
 */
async function callWithWaits(
  bookId: string,
  fetchImpl: FetchLike | undefined,
  sleep: SleepFn,
  random: () => number,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  colors?: PhotoColors,
): Promise<FinalizeOutcome> {
  const call = () => callFinalize(bookId, fetchImpl, colors, { signal, timeoutMs });
  let out = await call();
  for (let waits = 0; waits < MAX_WAITS && isWaitable(out); waits++) {
    await sleep(out.retryAfterMs + Math.floor(random() * RETRY_JITTER_MS));
    if (signal?.aborted) return out;
    out = await call();
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
  const { extraRuns = 2, sleep = defaultSleep, random = Math.random, signal, colors, requestTimeoutMs } = opts;
  const first = await callWithWaits(bookId, fetchImpl, sleep, random, signal, requestTimeoutMs, colors);
  if (!first.ok) return first;
  let result = first.result;
  for (let i = 0; i < extraRuns && result.placesPending > 0; i++) {
    await sleep(FOLLOW_UP_GAP_MS);
    if (signal?.aborted) break;
    const next = await callWithWaits(bookId, fetchImpl, sleep, random, signal, requestTimeoutMs);
    if (!next.ok) break;
    // Keep "wroteDoc" true if any run wrote the album.
    result = { ...next.result, wroteDoc: result.wroteDoc || next.result.wroteDoc };
  }
  return { ok: true, result };
}
