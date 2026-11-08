// Browser side of the AI run routes (D-022, D-025, contract in .agentos/runs/m3.md T11):
//   POST /api/ai/runs                 → startRun()
//   GET  /api/ai/runs/[id]            → getRun()
//   POST /api/ai/runs/[id]/advance    → advanceRun()
// Every HTTP status is mapped to a typed outcome; nothing throws. Types are re-declared here
// (not imported from src/lib/db or src/lib/ai) so client components never pull server modules.
// Only ids and counts travel — no photo data is sent or logged.
import { parseRetryAfter } from "@/lib/upload/finalize-client";
import { isUuid } from "@/lib/uuid";

export type RunTrigger = "build" | "rebuild";
export type RunMode = "live" | "replay" | "rule";
export type RunState =
  | "queued"
  | "curating"
  | "storytelling"
  | "captioning"
  | "critiquing"
  | "repairing"
  | "validating"
  | "done"
  | "failed";
export type RunAiStatus = "ok" | "partial" | "failed";
export type RunLimit = "daily_builds" | "rebuilds" | "analysed_photos";

export interface RunProgress {
  phase: RunState;
  photosTotal: number;
  photosDone: number;
  batchesTotal: number;
  batchesDone: number;
  photosCapped: number;
}

export interface RunTick {
  state: RunState;
  progress: RunProgress;
  done: boolean;
  aiStatus: RunAiStatus | null;
  errorCode: string | null;
}

export interface RunView extends RunTick {
  mode: RunMode;
}

/** Failures shared by all three calls. `network` = fetch threw (offline / aborted / CORS). */
export type CommonFailure =
  | { kind: "signed_out" } // 401
  | { kind: "not_found" } // 404 (or a malformed id, never sent)
  | { kind: "forbidden" } // 403 (cross-origin; should never happen in-app)
  | { kind: "server_error" } // 500 / other 5xx / unparsable body
  | { kind: "network" };

export type StartOutcome =
  | { kind: "started"; runId: string; mode: RunMode; state: RunState } // 201
  | { kind: "already_running"; runId: string | null } // 409
  | { kind: "user_edited" } // 409
  | { kind: "limit"; limit: RunLimit } // 429
  | { kind: "invalid" } // 400
  | CommonFailure;

export type AdvanceOutcome =
  | { kind: "tick"; tick: RunTick } // 200
  | { kind: "leased"; retryAfterMs: number } // 202 + Retry-After
  | CommonFailure;

export type GetOutcome = { kind: "view"; view: RunView } | CommonFailure;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The advance route sends Retry-After: 2; used if the header is missing. */
export const DEFAULT_LEASE_WAIT_MS = 2_000;

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
const RUN_MODES: readonly RunMode[] = ["live", "replay", "rule"];
const AI_STATUSES: readonly RunAiStatus[] = ["ok", "partial", "failed"];
const LIMITS: readonly RunLimit[] = ["daily_builds", "rebuilds", "analysed_photos"];

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Lenient: unknown/missing counters become 0; phase falls back to `state`. */
export function parseProgress(raw: unknown, state: RunState): RunProgress {
  const o = obj(raw) ?? {};
  return {
    phase: isOneOf(RUN_STATES, o.phase) ? o.phase : state,
    photosTotal: count(o.photosTotal),
    photosDone: count(o.photosDone),
    batchesTotal: count(o.batchesTotal),
    batchesDone: count(o.batchesDone),
    photosCapped: count(o.photosCapped),
  };
}

/** Strict on state/done (they drive the loop); lenient on the rest. */
export function parseTick(raw: unknown): RunTick | null {
  const o = obj(raw);
  if (!o || !isOneOf(RUN_STATES, o.state) || typeof o.done !== "boolean") return null;
  return {
    state: o.state,
    progress: parseProgress(o.progress, o.state),
    done: o.done,
    aiStatus: isOneOf(AI_STATUSES, o.aiStatus) ? o.aiStatus : null,
    errorCode: typeof o.errorCode === "string" ? o.errorCode : null,
  };
}

function commonFailure(status: number): CommonFailure {
  if (status === 401) return { kind: "signed_out" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "not_found" };
  return { kind: "server_error" };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function send(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  try {
    return await fetchImpl(url, { credentials: "same-origin", cache: "no-store", ...init });
  } catch {
    return null;
  }
}

const defaultFetch: FetchLike = (i, init) => fetch(i, init);

export async function startRun(
  bookId: string,
  trigger: RunTrigger = "build",
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<StartOutcome> {
  if (!isUuid(bookId)) return { kind: "not_found" };
  const res = await send(opts.fetchImpl ?? defaultFetch, "/api/ai/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookId, trigger }),
    signal: opts.signal,
  });
  if (!res) return { kind: "network" };
  const body = obj(await readJson(res));

  if (res.status === 201) {
    if (body && isUuid(body.runId) && isOneOf(RUN_MODES, body.mode) && isOneOf(RUN_STATES, body.state)) {
      return { kind: "started", runId: body.runId, mode: body.mode, state: body.state };
    }
    return { kind: "server_error" };
  }
  if (res.status === 409) {
    if (body?.error === "user_edited") return { kind: "user_edited" };
    return { kind: "already_running", runId: isUuid(body?.runId) ? body.runId : null };
  }
  if (res.status === 429) {
    return { kind: "limit", limit: isOneOf(LIMITS, body?.limit) ? body.limit : "daily_builds" };
  }
  if (res.status === 400) return { kind: "invalid" };
  return commonFailure(res.status);
}

export async function getRun(
  runId: string,
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<GetOutcome> {
  if (!isUuid(runId)) return { kind: "not_found" };
  const res = await send(opts.fetchImpl ?? defaultFetch, `/api/ai/runs/${runId}`, {
    method: "GET",
    signal: opts.signal,
  });
  if (!res) return { kind: "network" };
  if (res.status === 200) {
    const raw = await readJson(res);
    const tick = parseTick(raw);
    const mode = obj(raw)?.mode;
    if (!tick || !isOneOf(RUN_MODES, mode)) return { kind: "server_error" };
    return { kind: "view", view: { ...tick, mode } };
  }
  return commonFailure(res.status);
}

export async function advanceRun(
  runId: string,
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<AdvanceOutcome> {
  if (!isUuid(runId)) return { kind: "not_found" };
  const res = await send(opts.fetchImpl ?? defaultFetch, `/api/ai/runs/${runId}/advance`, {
    method: "POST",
    signal: opts.signal,
  });
  if (!res) return { kind: "network" };
  if (res.status === 202) {
    const header = res.headers.get("retry-after");
    return { kind: "leased", retryAfterMs: header ? parseRetryAfter(header) : DEFAULT_LEASE_WAIT_MS };
  }
  if (res.status === 200) {
    const tick = parseTick(await readJson(res));
    return tick ? { kind: "tick", tick } : { kind: "server_error" };
  }
  return commonFailure(res.status);
}
