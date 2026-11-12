// Browser side of the automatic first build (M13 T6, D-070 (3)). When the upload screen's uploads +
// finalize settle, the client asks POST /api/ai/runs { bookId, auto: true } and the SERVER decides
// whether a run may start (src/lib/ai/auto-build.ts): first build only, ≥ 5 ready photos, nothing
// pending, normal caps. This module maps the HTTP answer to a typed outcome and the outcome to the
// screen's next step. Pure apart from fetch; no React, no server imports — unit-tested in node.
// Only the book id travels; nothing about photos is sent or logged.

import type { RunLimit, RunMode, RunState } from "@/lib/runs/client";
import { isUuid } from "@/lib/uuid";

/** Mirrors AUTO_BUILD_MIN_READY_PHOTOS (server); below it the client doesn't ask. */
export const AUTO_BUILD_MIN_PHOTOS = 5;
/** One more ask after a not_ready answer (rows may still be settling), then the fallback button. */
export const NOT_READY_RETRY_MS = 3_000;

export type AutoStartOutcome =
  | { kind: "started"; runId: string; mode: RunMode; state: RunState } // 201 (auto: true)
  | { kind: "not_first" } // 409 — already has a run / AI album: never an automatic rebuild
  | { kind: "not_ready" } // 409 — < 5 ready or an upload pending
  | { kind: "already_running"; runId: string | null } // 409
  | { kind: "user_edited" } // 409
  | { kind: "limit"; limit: RunLimit } // 429
  | { kind: "signed_out" } // 401
  | { kind: "error" }; // anything else (network, 4xx/5xx, 503, unparsable)

const RUN_MODES: readonly RunMode[] = ["live", "replay", "rule"];
const RUN_STATES: readonly RunState[] = [
  "queued",
  "curating",
  "storytelling",
  "captioning",
  "critiquing",
  "repairing",
  "validating",
  "done",
  "failed",
];
const LIMITS: readonly RunLimit[] = ["daily_builds", "rebuilds", "analysed_photos", "rate", "budget_exhausted"];

const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (values as readonly string[]).includes(v);

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function requestAutoBuild(
  bookId: string,
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<AutoStartOutcome> {
  if (!isUuid(bookId)) return { kind: "error" };
  const doFetch = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  let res: Response;
  try {
    res = await doFetch("/api/ai/runs", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookId, auto: true }),
      signal: opts.signal,
    });
  } catch {
    return { kind: "error" };
  }
  let body: Record<string, unknown> | null = null;
  try {
    const raw: unknown = await res.json();
    body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (res.status === 201) {
    if (body && isUuid(body.runId) && oneOf(RUN_MODES, body.mode) && oneOf(RUN_STATES, body.state)) {
      return { kind: "started", runId: body.runId as string, mode: body.mode, state: body.state };
    }
    return { kind: "error" };
  }
  if (res.status === 409) {
    switch (body?.error) {
      case "not_first":
        return { kind: "not_first" };
      case "not_ready":
        return { kind: "not_ready" };
      case "user_edited":
        return { kind: "user_edited" };
      case "already_running":
        return { kind: "already_running", runId: isUuid(body.runId) ? (body.runId as string) : null };
      default:
        return { kind: "error" };
    }
  }
  if (res.status === 429) return { kind: "limit", limit: oneOf(LIMITS, body?.limit) ? body.limit : "daily_builds" };
  if (res.status === 401) return { kind: "signed_out" };
  return { kind: "error" };
}

/** Where the book stood when the upload screen loaded. */
export type FirstRunState = "none" | "active" | "done";

/** Ask for the automatic build only for a fresh book whose upload settled with enough photos. */
export function shouldAutoStart(input: {
  firstRun: FirstRunState;
  ready: number;
  pendingLeft: number;
  fatal: boolean;
  cancelled: boolean;
}): boolean {
  return (
    input.firstRun === "none" &&
    !input.fatal &&
    !input.cancelled &&
    input.pendingLeft === 0 &&
    input.ready >= AUTO_BUILD_MIN_PHOTOS
  );
}

const TERMINAL: ReadonlySet<RunState> = new Set(["done", "failed"]);

export type AutoStartNext =
  /** Navigate. `rules` = a rule run (AI off) already finished inside the POST: the build screen
   * would start another, so go to the editor and report ai_build_done here. */
  | { kind: "go"; href: string; rules?: { outcome: "ok" | "failed" } }
  /** not_ready: ask once more shortly, then fall back. */
  | { kind: "retry" }
  /** Show the "Make my book now" fallback (optionally with the limit copy). */
  | { kind: "fallback"; limit?: RunLimit };

export function buildHref(bookId: string, auto: boolean): string {
  return `/books/${bookId}/build${auto ? "?auto=1" : ""}`;
}

export function editorHref(bookId: string): string {
  return `/books/${bookId}/edit`;
}

/**
 * The next step for an auto-start answer. `retried` = a not_ready retry already happened;
 * `activeAtLoad` = the book had an active run when the screen loaded (not_first then means "watch
 * it build", otherwise the album exists → editor).
 */
export function autoStartNext(
  bookId: string,
  outcome: AutoStartOutcome,
  ctx: { retried: boolean; activeAtLoad: boolean },
): AutoStartNext {
  switch (outcome.kind) {
    case "started":
      if (outcome.mode === "rule" && TERMINAL.has(outcome.state)) {
        return { kind: "go", href: editorHref(bookId), rules: { outcome: outcome.state === "done" ? "ok" : "failed" } };
      }
      return { kind: "go", href: buildHref(bookId, true) };
    case "already_running":
      return { kind: "go", href: buildHref(bookId, false) };
    case "not_first":
      return { kind: "go", href: ctx.activeAtLoad ? buildHref(bookId, false) : editorHref(bookId) };
    case "user_edited":
      return { kind: "go", href: editorHref(bookId) };
    case "not_ready":
      return ctx.retried ? { kind: "fallback" } : { kind: "retry" };
    case "limit":
      return { kind: "fallback", limit: outcome.limit };
    case "signed_out":
    case "error":
      return { kind: "fallback" };
  }
}
