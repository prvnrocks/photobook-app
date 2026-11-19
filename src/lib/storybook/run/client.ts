// Browser side of the storybook job routes (Task 8): POST /api/ai/story-runs, GET / advance / cancel
// /api/ai/story-runs/[id]. Client-safe and small: fetch only, no zod, no React. Failure shapes match
// src/lib/runs/client.ts so the shared loop (driveRun, startWithRetry) drives it unchanged.
// Only ids travel; nothing about photos or text is logged.

import type { AdvanceOutcomeOf } from "@/lib/runs/drive";
import { DEFAULT_LEASE_WAIT_MS, DEFAULT_UNAVAILABLE_WAIT_MS, type CommonFailure, type FetchLike } from "@/lib/runs/client";
import { parseRetryAfter } from "@/lib/upload/finalize-client";
import { isUuid } from "@/lib/uuid";
import { isStoryRunState, parseStoryProgress, type StoryRunView } from "./progress";

export type StoryStartOutcome =
  | { kind: "started"; runId: string; view: StoryRunView } // 201
  | { kind: "already_running"; runId: string | null } // 409 (runId null: an album build is running)
  | { kind: "user_edited" } // 409
  | { kind: "no_photos" } // 409
  | { kind: "unsupported_design" } // 422
  | { kind: "story_unavailable" } // 503 story_unavailable (migration missing) — permanent until deployed
  | { kind: "preview_limit" } // 402 (Task 9): the free previews of this book are used up
  | { kind: "rate_limited"; retryAfterMs: number } // 429 (Task 9): too many starts
  | { kind: "invalid" } // 400
  | CommonFailure;

export type StoryAdvanceOutcome = AdvanceOutcomeOf<StoryRunView>;
export type StoryViewOutcome = { kind: "view"; view: StoryRunView } | CommonFailure;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Strict on id / state / done (they drive the loop); lenient on the rest. */
export function parseStoryView(raw: unknown): StoryRunView | null {
  const o = obj(raw);
  if (!o || !isUuid(o.runId) || !isStoryRunState(o.state) || typeof o.done !== "boolean") return null;
  const ai = o.aiStatus;
  const mode = o.mode === "live" || o.mode === "replay" || o.mode === "rule" ? o.mode : "rule";
  return {
    runId: o.runId,
    state: o.state,
    progress: parseStoryProgress(o.progress, o.state),
    done: o.done,
    aiStatus: ai === "ok" || ai === "partial" || ai === "failed" ? ai : null,
    errorCode: typeof o.errorCode === "string" ? o.errorCode : null,
    mode,
  };
}

async function send(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetchImpl(url, { credentials: "same-origin", cache: "no-store", ...init });
  } catch {
    return null;
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function commonFailure(res: Response): CommonFailure {
  if (res.status === 401) return { kind: "signed_out" };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 404) return { kind: "not_found" };
  if (res.status === 503) {
    const header = res.headers.get("retry-after");
    return { kind: "unavailable", retryAfterMs: header ? parseRetryAfter(header) : DEFAULT_UNAVAILABLE_WAIT_MS };
  }
  return { kind: "server_error" };
}

const defaultFetch: FetchLike = (i, init) => fetch(i, init);
type Opts = { fetchImpl?: FetchLike; signal?: AbortSignal };

export async function startStory(bookId: string, opts: Opts = {}): Promise<StoryStartOutcome> {
  if (!isUuid(bookId)) return { kind: "not_found" };
  const res = await send(opts.fetchImpl ?? defaultFetch, "/api/ai/story-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookId }),
    signal: opts.signal,
  });
  if (!res) return { kind: "network" };
  const body = obj(await readJson(res));
  if (res.status === 201) {
    const view = parseStoryView(body?.view);
    return view && isUuid(body?.runId) ? { kind: "started", runId: body.runId, view } : { kind: "server_error" };
  }
  if (res.status === 409) {
    if (body?.error === "user_edited") return { kind: "user_edited" };
    if (body?.error === "no_photos") return { kind: "no_photos" };
    return { kind: "already_running", runId: isUuid(body?.runId) ? body.runId : null };
  }
  if (res.status === 422) return { kind: "unsupported_design" };
  if (res.status === 400) return { kind: "invalid" };
  if (res.status === 503 && body?.error === "story_unavailable") return { kind: "story_unavailable" };
  if (res.status === 402 && body?.error === "preview_limit") return { kind: "preview_limit" };
  if (res.status === 429) {
    const header = res.headers.get("retry-after");
    return { kind: "rate_limited", retryAfterMs: header ? parseRetryAfter(header) : DEFAULT_UNAVAILABLE_WAIT_MS };
  }
  return commonFailure(res);
}

export async function getStory(runId: string, opts: Opts = {}): Promise<StoryViewOutcome> {
  if (!isUuid(runId)) return { kind: "not_found" };
  const res = await send(opts.fetchImpl ?? defaultFetch, `/api/ai/story-runs/${runId}`, { method: "GET", signal: opts.signal });
  if (!res) return { kind: "network" };
  if (res.status === 200) {
    const view = parseStoryView(await readJson(res));
    return view ? { kind: "view", view } : { kind: "server_error" };
  }
  return commonFailure(res);
}

export async function advanceStory(runId: string, opts: Opts = {}): Promise<StoryAdvanceOutcome> {
  if (!isUuid(runId)) return { kind: "not_found" };
  const res = await send(opts.fetchImpl ?? defaultFetch, `/api/ai/story-runs/${runId}/advance`, { method: "POST", signal: opts.signal });
  if (!res) return { kind: "network" };
  // 202 another tick holds the lease; 429 (Task 9) the tick rate limit — both: wait Retry-After, tick again
  if (res.status === 202 || res.status === 429) {
    const header = res.headers.get("retry-after");
    return { kind: "leased", retryAfterMs: header ? parseRetryAfter(header) : DEFAULT_LEASE_WAIT_MS };
  }
  if (res.status === 200) {
    const view = parseStoryView(await readJson(res));
    return view ? { kind: "tick", tick: view } : { kind: "server_error" };
  }
  return commonFailure(res);
}

export async function cancelStory(runId: string, opts: Opts = {}): Promise<StoryViewOutcome> {
  if (!isUuid(runId)) return { kind: "not_found" };
  const res = await send(opts.fetchImpl ?? defaultFetch, `/api/ai/story-runs/${runId}/cancel`, { method: "POST", signal: opts.signal });
  if (!res) return { kind: "network" };
  if (res.status === 200) {
    const view = parseStoryView(await readJson(res));
    return view ? { kind: "view", view } : { kind: "server_error" };
  }
  return commonFailure(res);
}

/** Copy for a start that produced no run. */
export function storyStartErrorCopy(out: StoryStartOutcome): string {
  switch (out.kind) {
    case "user_edited":
      return "Your book already has your own changes, so we won't replace it. Open the editor to keep going.";
    case "no_photos":
      return "Add a few photos first — there's nothing to make a story from yet.";
    case "unsupported_design":
      return "This book's style can't be laid out yet. Pick another style.";
    case "story_unavailable":
      return "Making stories isn't available right now. Please try again later.";
    case "preview_limit":
      return "You've used the free previews for this book. Unlock the full book to make the whole story.";
    case "rate_limited":
      return "That's a lot of tries in a short time. Wait a few minutes and try again.";
    case "signed_out":
      return "You've been signed out. Sign in again to continue.";
    case "not_found":
    case "forbidden":
      return "We couldn't find this book.";
    default:
      return "We couldn't start your story. Check your connection and try again.";
  }
}
