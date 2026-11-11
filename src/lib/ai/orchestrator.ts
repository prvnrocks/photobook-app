import "server-only";

// In-product AI orchestrator (docs/AI-AGENTS.md, D-022): a TypeScript state machine — NOT an LLM —
// driven by client ticks. Every model call goes through an agent function → runAgentStep()
// (one agent_steps row each). All I/O is injected through OrchestratorDeps; defaultDeps() wires
// the real DB / transport / clock, tests pass in-memory fakes.
//
//   startRun()  owner + doc + limit checks, creates the run (or, with AI off, builds the rule
//               album synchronously).
//   advance()   one tick under a DB lease: runs idempotent chunks within `budgetMs`,
//               checkpoints after each chunk and returns progress.
//   getProgress() owner-scoped read for GET /api/ai/runs/[id].
//
// States: queued → curating → storytelling → captioning → critiquing → repairing → validating → done
//         any unexpected exception → failed (the rule album is written if the book had no doc).
//
//   captioning  (M4, D-029) the AI doc is rebuilt from the stored plan (planDocOf — structure frozen
//               at storytelling), split into Caption Writer batches (captionBatches), sent in waves
//               (batch 0 alone first: prompt cache). Rule albums: one `skipped` step, no captions.
//   critiquing  (D-030) captions applied, whole-book pre-check, ONE Critic call, repair plan stored.
//   repairing   one targeted Caption Writer call per affected batch (never a second round); still
//               failing → null. A cover swap is decided in code and applied at validating.
//   validating  prunePlan → planToDoc → captions re-mapped onto pages whose photos are unchanged →
//               validate → writeDocIfReplaceable (guard 'ai': user captions are never overwritten).
//
// Resumability: the cursor (agent_runs.cursor) records the run's alias table, Curator batches,
// finished batches and Storyteller attempts, so a resumed tick never re-bills finished work.
// A batch whose photos already carry current-version notes (written by a tick that died before
// its checkpoint) is marked done without a call. Every model call gets a fresh attempt number
// that is RESERVED in the cursor (checkpointed) before the call, so a call re-run after a dead
// tick logs its own agent_steps row instead of colliding with the dead tick's (step_key, attempt).
//
// Leases: claimRun() returns a lease token; every checkpoint carries it. A checkpoint that
// returns false means another tick took over (our lease expired): the tick stops at once, writes
// nothing more, does not release, and returns { leased: true }. Side effects outside agent_runs
// (photo curation, the doc, books.ai_status) are preceded by a checkpoint, so a stale tick stops
// before them. A model call starts only when its timeout (+ margin) fits in the remaining lease;
// runAgentStep retries only within the same bound (SDK retries are off).
//
// Guards (M4 review): the cursor is measured before every checkpoint (cursorBytes vs
// cursorByteLimit — AI_MAX_CURSOR_BYTES, default the DB check); a caption-phase cursor that would
// not fit sheds its pending caption work and the run finishes with the AI album and the captions
// that fit (ai_status partial, error_code cursor_too_large). Every Caption Writer / Critic / repair
// call first checks the run's spend + a pessimistic estimate of the call against
// limits.maxRunCostUsd (D-035); over → that work stops (error_code run_budget). Critic-only
// failures mark the RUN partial but not the book (criticFailures, SF5).
//
// Privacy (D-027): nothing here logs. Error codes are short code strings; cursor / progress hold
// ids, counts and codes only — except, while the run is going, `cursor.album.plan` (AI titles),
// `cursor.captions` / `cursor.headings` (AI text) and `cursor.memory` (the user's memory snapshot),
// all removed when the run finishes (stripCursorText). Progress holds counts only.

import { autolayout, parseTime, type AutoPhoto } from "@/lib/autolayout";
import {
  CAPTION_LANGS,
  DEFAULT_TONE,
  OCCASIONS,
  TONES,
  type CaptionLang,
  type Occasion,
  type Tone,
} from "@/lib/book/options";
import { docOrigin, isAiReplaceableDoc, isEmptyDoc } from "@/lib/book/replaceable";
import { bookDesignOf, isSupportedDesign, isUnsupportedDesignError, withBookDesign } from "@/lib/book/book-design";
import { serializeDoc } from "@/lib/book/doc-version";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import * as agentRunsDb from "@/lib/db/agent-runs";
import type {
  CreateRunCappedInput,
  CreateRunCappedResult,
  OwnerRun,
  RunAiStatus,
  RunCheckpointPatch,
  RunForTick,
  RunMode,
  RunState,
  RunTrigger,
} from "@/lib/db/agent-runs";
import * as booksDb from "@/lib/db/books";
import { getUserMemoryAdmin } from "@/lib/db/memory";
import type { BookAiStatus, BookForRun, WriteDocResult } from "@/lib/db/books";
import * as photosDb from "@/lib/db/photos";
import { colorFromThumbBase64 } from "@/lib/image/color-server";
import type { CurationPhotoRow, CurationWrite } from "@/lib/db/photos";
import type { Json } from "@/lib/supabase/database.types";
import { curateBatch, needsCuration, CURATOR_PROMPT_VERSION } from "./agents/curator";
import { captionWriterMaxTokens, writeCaptions, type WriteCaptionsResult } from "./agents/caption-writer";
import { critiqueBook, criticMaxTokens } from "./agents/critic";
import { MAX_RETRY_ISSUES, planAlbum } from "./agents/storyteller";
import { buildBatches } from "./batches";
import { isAiBudgetExhausted } from "./budget";
import { buildCaptionContext, checkBookCaptions, CAPTION_ISSUE_CODES, type CaptionCheckContext, type CaptionIssue } from "./caption-check";
import {
  applyCaptions,
  batchIndexOfKey,
  batchIndexOfMoment,
  captionBatches,
  groundStoryText,
  type CaptionBatchSpec,
} from "./captions";
import { AGENT_TIMEOUT_MS, AI_MODEL, CURATOR_CONCURRENCY, resolveAiMode, type AiMode } from "./client";
import {
  ensureAtLeastOneKept,
  isDropReason,
  ruleCurate,
  type CurationPhoto,
  type DropReason,
} from "./fallback";
import { estimateCallCostUsd } from "./cost";
import { limitsFor } from "./limits";
import { isEmptyMemory, sanitizeMemory } from "./memory";
import { planToDoc, prunePlan } from "./plan-to-doc";
import { STORYTELLER_PROMPT_VERSION } from "./prompts/storyteller";
import { momentIdOfKey, pageCaptionKeys, planRepair } from "./repair";
import type { RetryOptions, StepErrorCode, StepLogger } from "./run-step";
import {
  AlbumPlanStrictSchema,
  CRITIQUE_FIXES,
  CRITIQUE_ISSUE_TYPES,
  MOMENT_ID_RE,
  MOODS,
  SCENES,
  UserMemorySchema,
  type AlbumPlan,
  type UserMemory,
} from "./schemas";
import type { StoryAnalysis, StoryBook, StoryPhoto } from "./story";
import { getTransport } from "./transport-factory";
import type { AgentName, AgentTransport } from "./transport";

// ---------------------------------------------------------------------------------------------
// Tunables (tick timing — see the HANDOFF in .agentos/runs/m3.md)

/**
 * DB lease per tick (claim_agent_run allows ≤ MAX_LEASE_SECONDS). Must cover the longest single
 * request (the Storyteller, AGENT_TIMEOUT_MS.storyteller = 180 s) + LEASE_MARGIN_MS of DB work,
 * started at the beginning of a tick. The advance route's maxDuration (300 s) must stay ≥ this.
 */
export const LEASE_SECONDS = 240;
/** Upper bound accepted by claim_agent_run. */
export const MAX_LEASE_SECONDS = 300;
/** Time reserved after the last model call of a tick for writes + checkpoint + release. */
export const LEASE_MARGIN_MS = 20_000;
/**
 * Soft work budget of one advance() call: no new Curator wave starts after
 * CURATOR_WAVE_CUTOFF of it (keeps progress updates frequent). The hard bound is the lease.
 */
export const DEFAULT_TICK_BUDGET_MS = 40_000;
export const CURATOR_WAVE_CUTOFF = 0.5;
/** Storyteller attempts per run, incl. attempts lost in dead ticks (attempt 2 gets the issues). */
export const MAX_STORY_ATTEMPTS = 2;
/** Calls per Curator batch, incl. calls lost in dead ticks; then the batch is rule-curated. */
export const MAX_BATCH_ATTEMPTS = 2;
/** Transport retries inside one agent step (only if they still fit the lease). */
export const STEP_RETRIES = 1;
/** Caption Writer calls per caption batch, incl. calls lost in dead ticks; then the batch stays uncaptioned. */
export const MAX_CAPTION_ATTEMPTS = 2;
/** Critic calls per run, incl. calls lost in dead ticks (a failed answer is not retried). */
export const MAX_CRITIC_ATTEMPTS = 2;
/**
 * Soft budget fraction after which no new caption wave / Critic / repair call starts in a tick
 * that already made a model call (keeps progress frequent; the hard bound is the lease).
 */
export const CAPTION_WAVE_CUTOFF = 1;
/** agent_runs.cursor size check (migration 0800, D-033: pg_column_size(cursor) ≤ 262144). */
export const MAX_CURSOR_BYTES = 262_144;
/** jsonb storage overhead over the UTF-8 JSON text (conservative). */
export const CURSOR_SIZE_FACTOR = 1.15;
/** Rough input tokens of one Caption Writer call (system + book info + per page notes) — D-035 estimate. */
const CAPTION_CALL_INPUT_TOKENS = (pages: number) => 5_000 + 400 * Math.max(1, pages);
/** Rough input tokens of one Critic call (system + per page line + photo notes) — D-035 estimate. */
const CRITIC_CALL_INPUT_TOKENS = (pages: number) => 4_000 + 300 * Math.max(1, pages);

/**
 * Cursor byte limit used by the guard: env AI_MAX_CURSOR_BYTES (positive integer, never above the
 * DB check), else MAX_CURSOR_BYTES.
 */
export function cursorByteLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = Number.parseInt((env.AI_MAX_CURSOR_BYTES ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_CURSOR_BYTES) : MAX_CURSOR_BYTES;
}

/** Pessimistic stored size of a cursor: UTF-8 bytes of its JSON × CURSOR_SIZE_FACTOR. */
export function cursorBytes(cursor: unknown): number {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(cursor)).length * CURSOR_SIZE_FACTOR);
}
/** Optimistic-lock conflicts tolerated when saving the doc (each retried on the next tick). */
export const MAX_WRITE_CONFLICTS = 1;
export const CURSOR_VERSION = 1;
const MAX_FAILURE_CODES = 20;

// ---------------------------------------------------------------------------------------------
// Dependencies

export interface OrchestratorDeps {
  // books
  getBookForRun(bookId: string): Promise<BookForRun | null>;
  setBookAiStatus(bookId: string, status: BookAiStatus): Promise<void>;
  writeDocIfReplaceable(bookId: string, doc: Json, pageCount: number, expected: { updatedAt: string }): Promise<WriteDocResult>;
  // photos
  listPhotosForCuration(bookId: string): Promise<CurationPhotoRow[]>;
  writeCuration(bookId: string, rows: CurationWrite[]): Promise<void>;
  loadThumbBase64(paths: string[]): Promise<Map<string, string>>;
  /** M10c colour backfill: base64 thumb → "#rrggbb" | null. Missing → no backfill. */
  colorFromThumb?(thumbBase64: string): Promise<string | null>;
  /** M10c: photos.color for photos of the book whose colour is still null (never overwrites). */
  setPhotosColor?(bookId: string, colors: Map<string, string>): Promise<void>;
  // runs
  /** Atomic: one active run per book + daily / rebuild caps (when `enforce`) + insert. */
  createRunCapped(input: CreateRunCappedInput): Promise<CreateRunCappedResult>;
  /** Lease token, or null (lease held by another tick, or the run is finished / missing). */
  claimRun(runId: string, leaseSeconds: number): Promise<string | null>;
  /** No-op when `token` no longer holds the lease. */
  releaseRun(runId: string, token: string): Promise<void>;
  /** false = stale tick (lease lost): stop immediately, write nothing more. */
  checkpointRun(runId: string, token: string, patch: RunCheckpointPatch): Promise<boolean>;
  getRunForTick(runId: string): Promise<RunForTick | null>;
  getRunForOwner(runId: string): Promise<OwnerRun | null>;
  /** The book already had a finished live AI run (→ a new "build" is really a rebuild). */
  hasFinishedLiveAiRun(bookId: string): Promise<boolean>;
  stepLogger(runId: string): StepLogger;
  /** USD spent by the run so far (sum of its agent_steps) — D-035 run budget. */
  getRunCostUsd(runId: string): Promise<number>;
  /**
   * D-059 daily budget breaker: true = today's (Asia/Dubai) AI spend reached AI_DAILY_BUDGET_USD.
   * Checked before a LIVE run is created. Must never throw (fails open). Missing → never over.
   */
  isOverDailyAiBudget?: () => Promise<boolean>;
  /** Optional override of cursorByteLimit() (tests). */
  maxCursorBytes?: () => number;
  // memory (D-032)
  /** user_memory.prefs of the user (raw jsonb, sanitised by the caller), or null. */
  getUserMemory(userId: string): Promise<unknown>;
  // AI
  resolveMode(): AiMode;
  transportFor(mode: "live" | "replay"): AgentTransport | null;
  // clock (ms since epoch) + backoff sleep
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type { CreateRunCappedInput, CreateRunCappedResult };

export function defaultDeps(): OrchestratorDeps {
  return {
    getBookForRun: booksDb.getBookForRun,
    setBookAiStatus: booksDb.setBookAiStatus,
    // AI runs always use the "ai" guard: never overwrite a doc with user captions (D-031).
    writeDocIfReplaceable: (bookId, doc, pageCount, expected) =>
      booksDb.writeDocIfReplaceable(bookId, doc, pageCount, expected, { guard: "ai" }),
    listPhotosForCuration: photosDb.listPhotosForCuration,
    writeCuration: photosDb.writeCuration,
    loadThumbBase64: photosDb.loadThumbBase64,
    colorFromThumb: colorFromThumbBase64,
    setPhotosColor: photosDb.setPhotosColor,
    createRunCapped: agentRunsDb.createRunCapped,
    claimRun: agentRunsDb.claimRun,
    releaseRun: agentRunsDb.releaseRun,
    checkpointRun: agentRunsDb.checkpointRun,
    getRunForTick: agentRunsDb.getRunForTick,
    getRunForOwner: agentRunsDb.getRunForOwner,
    hasFinishedLiveAiRun: agentRunsDb.hasFinishedLiveAiRun,
    stepLogger: agentRunsDb.stepLogger,
    // Re-sums agent_steps into agent_runs.total_* (idempotent) and returns the total.
    getRunCostUsd: async (runId) => (await agentRunsDb.syncRunTotals(runId)).costUsd,
    isOverDailyAiBudget: () => isAiBudgetExhausted(),
    getUserMemory: async (userId) => (await getUserMemoryAdmin(userId))?.prefs ?? null,
    resolveMode: () => resolveAiMode(),
    transportFor: (mode) => getTransport(mode),
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  };
}

// ---------------------------------------------------------------------------------------------
// Public result shapes

export type StartInput = { bookId: string; userId: string; trigger: "build" | "rebuild" };

/** 'budget_exhausted' (D-059): the global daily AI budget is used up — no run was created. */
export type StartLimit = "daily_builds" | "rebuilds" | "analysed_photos" | "budget_exhausted";

export type StartResult =
  | { ok: true; runId: string; mode: RunMode; state: RunState }
  | {
      ok: false;
      /**
       * 'unsupported_design' (M10b A19, review S1): books.design_style has no layouts yet
       * (none since M10c T10; rows inserted directly) — refused before any run row or model call.
       */
      error: "not_found" | "already_running" | "user_edited" | "limit" | "unsupported_design";
      /**
       * Set when error = 'limit'. 'analysed_photos' is never a start error today: photos over
       * maxAnalyzedPhotos are rule-curated and reported as progress.photosCapped.
       */
      limit?: StartLimit;
    };

export interface RunProgress {
  phase: RunState;
  /** Photos sent to the Curator in this run. */
  photosTotal: number;
  photosDone: number;
  batchesTotal: number;
  batchesDone: number;
  /** Photos that needed analysis but were over the plan's analysed-photo cap (rule-curated). */
  photosCapped: number;
  /** Pages the Caption Writer was asked to caption in this run (0 for rule albums). Counts only. */
  captionsTotal: number;
  /** Of those, pages in finished caption batches (captioned or left empty). Counts only. */
  captionsDone: number;
}

export type AdvanceResult =
  | { state: RunState; progress: RunProgress; done: boolean; aiStatus?: RunAiStatus | null; errorCode?: string | null }
  | { leased: true }
  | { notFound: true };

export interface ProgressView {
  state: RunState;
  progress: RunProgress;
  aiStatus: RunAiStatus | null;
  errorCode: string | null;
  mode: RunMode;
  done: boolean;
}

// ---------------------------------------------------------------------------------------------
// Cursor

type AlbumChoice = { kind: "ai"; plan?: AlbumPlan } | { kind: "rule"; reason: string };

/** One caption batch in compact form (the spec is recomputed from the plan each tick). */
export interface CaptionBatchRef {
  /** Moment ids in the batch (incl. heading-only moments). */
  moments: string[];
  /** Page caption keys ("m2:1"). Step key of batch i = `caption_writer:${i}`. */
  keys: string[];
}

/** Critic result kept between critiquing and finish: score + issue types / pages (never `detail`). */
export interface CursorCritique {
  score: number;
  issues: Array<{
    type: (typeof CRITIQUE_ISSUE_TYPES)[number];
    pageIndex: number | null;
    fix: (typeof CRITIQUE_FIXES)[number];
  }>;
}

/** One caption the repair round rewrites (codes only). */
export interface CursorRepairTarget {
  /** Caption batch whose spec holds the key. Step key `caption_writer:repair:${batch}`. */
  batch: number;
  /** captionKey ("m2:1" or "m2:heading"). */
  key: string;
  /** Pre-check codes / Critic issue types. */
  codes: string[];
}

export interface RunCursor {
  v: typeof CURSOR_VERSION;
  /** Alias table (D-023): photo id of alias `p${i + 1}` is aliasIds[i]. Append-only. */
  aliasIds: string[];
  /** Curator batches as alias numbers (1-based). Step key of batch i = `curator:${i}`. */
  batches: number[][];
  batchesDone: number[];
  /** Model calls reserved per batch (index = batch). Checkpointed BEFORE each call. */
  batchAttempts: number[];
  /** Batches answered by the model (usedAi). */
  batchesAi: number;
  /** Batches that fell back to rule decisions (refusal / error / no loadable thumbs). */
  aiFailures: number;
  photosCapped: number;
  curationDone: boolean;
  /** Storyteller attempts reserved (0..MAX_STORY_ATTEMPTS). Checkpointed BEFORE each call. */
  storyAttempt: number;
  /** Validation issues of the last Storyteller attempt (no user text). */
  issues: string[];
  album: AlbumChoice | null;
  /** Failure codes in order, e.g. "curator_refusal" (codes only). */
  failures: string[];
  writeConflicts: number;
  /** books.ai_status before the run — restored when the run does not replace the doc. */
  prevBookStatus: BookAiStatus;

  // --- M4 (all optional in stored cursors: runs started before M4 parse with these defaults) ---
  /** Sanitised user_memory snapshot taken when the cursor was created (D-032); null = none. */
  memory: UserMemory | null;
  /** Caption batches (compact); null = not planned yet. */
  captionBatches: CaptionBatchRef[] | null;
  /** Caption Writer calls reserved per caption batch. Checkpointed BEFORE each call. */
  captionAttempts: number[];
  captionBatchesDone: number[];
  /** Caption batches / repair calls without a usable answer, budget / size stops (→ run AND book partial). */
  captionFailures: number;
  /** Critic refusals / errors / budget skips (→ run partial only; the book follows the captions, SF5). */
  criticFailures: number;
  /** Step keys of `skipped` agent_steps rows already written (idempotent skippedStep). */
  skippedSteps: string[];
  /** captionKey → AI caption (passed the pre-check). Stripped at finish. */
  captions: Record<string, string>;
  /** momentId → AI heading. Stripped at finish. */
  headings: Record<string, string>;
  /** captionKey → pre-check issue codes of captions the batch rejected (codes only). */
  captionIssues: Record<string, string[]>;
  captionsDone: boolean;
  /** Critic calls reserved. Checkpointed BEFORE the call. */
  criticAttempts: number;
  critique: CursorCritique | null;
  critiqueDone: boolean;
  /** Repair round targets (decided once, at the end of critiquing). */
  repairTargets: CursorRepairTarget[];
  /** Repair calls reserved per caption batch (≤ maxCaptionRepairsPerBatch, dead ticks included). */
  repairAttempts: number[];
  repairBatchesDone: number[];
  /** New cover photo id chosen in code (Critic weak_cover), applied at validating. */
  coverSwap: string | null;
  repairDone: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isIntArr = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n));
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

const PAGE_KEY_RE = /^m[1-9]\d*:\d{1,3}$/;
const ANY_KEY_RE = /^m[1-9]\d*:(?:\d{1,3}|heading)$/;
const CODE_RE = /^[a-z_]{1,40}$/;

/** Record<string, string> with keys matching `keyRe` (anything else dropped). */
function strRecord(v: unknown, keyRe: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, t] of Object.entries(v)) if (keyRe.test(k) && typeof t === "string" && t.trim()) out[k] = t;
  return out;
}

function codeRecord(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isObj(v)) return out;
  for (const [k, list] of Object.entries(v)) {
    if (ANY_KEY_RE.test(k) && isStrArr(list)) out[k] = list.filter((c) => CODE_RE.test(c));
  }
  return out;
}

function parseCaptionBatches(v: unknown): CaptionBatchRef[] | null {
  if (!Array.isArray(v)) return null;
  const out: CaptionBatchRef[] = [];
  for (const b of v) {
    if (!isObj(b) || !isStrArr(b.moments) || !isStrArr(b.keys)) return null;
    if (!b.moments.every((m) => MOMENT_ID_RE.test(m)) || !b.keys.every((k) => PAGE_KEY_RE.test(k))) return null;
    out.push({ moments: b.moments, keys: b.keys });
  }
  return out;
}

function parseCritique(v: unknown): CursorCritique | null {
  if (!isObj(v) || typeof v.score !== "number" || !Number.isFinite(v.score) || !Array.isArray(v.issues)) return null;
  const issues: CursorCritique["issues"] = [];
  for (const i of v.issues) {
    if (!isObj(i)) continue;
    const type = (CRITIQUE_ISSUE_TYPES as readonly unknown[]).includes(i.type) ? (i.type as CursorCritique["issues"][number]["type"]) : null;
    const fix = (CRITIQUE_FIXES as readonly unknown[]).includes(i.fix) ? (i.fix as CursorCritique["issues"][number]["fix"]) : null;
    const pageIndex = i.pageIndex === null ? null : Number.isInteger(i.pageIndex) ? (i.pageIndex as number) : undefined;
    if (type && fix && pageIndex !== undefined) issues.push({ type, pageIndex, fix });
  }
  return { score: v.score, issues };
}

function parseRepairTargets(v: unknown): CursorRepairTarget[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is Record<string, unknown> => isObj(t))
    .filter((t) => Number.isInteger(t.batch) && typeof t.key === "string" && ANY_KEY_RE.test(t.key) && isStrArr(t.codes))
    .map((t) => ({ batch: t.batch as number, key: t.key as string, codes: (t.codes as string[]).filter((c) => CODE_RE.test(c)) }));
}

function parseMemory(v: unknown): UserMemory | null {
  if (!isObj(v)) return null;
  const mem = sanitizeMemory(v);
  return UserMemorySchema.safeParse(mem).success && !isEmptyMemory(mem) ? mem : null;
}

/** Reads a stored cursor; null when it is missing or not ours (→ run fails with 'bad_cursor'). */
export function parseCursor(raw: unknown): RunCursor | null {
  if (!isObj(raw) || raw.v !== CURSOR_VERSION) return null;
  const c = raw as Record<string, unknown>;
  if (!isStrArr(c.aliasIds) || !Array.isArray(c.batches) || !c.batches.every(isIntArr) || !isIntArr(c.batchesDone)) {
    return null;
  }
  const num = (k: string) => (typeof c[k] === "number" && Number.isFinite(c[k]) ? (c[k] as number) : 0);
  let album: AlbumChoice | null = null;
  if (isObj(c.album)) {
    if (c.album.kind === "rule") album = { kind: "rule", reason: typeof c.album.reason === "string" ? c.album.reason : "unknown" };
    else if (c.album.kind === "ai") {
      const plan = AlbumPlanStrictSchema.safeParse(c.album.plan);
      album = plan.success ? { kind: "ai", plan: plan.data } : { kind: "ai" };
    }
  }
  return {
    v: CURSOR_VERSION,
    aliasIds: c.aliasIds,
    batches: c.batches as number[][],
    batchesDone: c.batchesDone,
    batchAttempts: isIntArr(c.batchAttempts) ? c.batchAttempts : [],
    batchesAi: num("batchesAi"),
    aiFailures: num("aiFailures"),
    photosCapped: num("photosCapped"),
    curationDone: c.curationDone === true,
    storyAttempt: num("storyAttempt"),
    issues: isStrArr(c.issues) ? c.issues : [],
    album,
    failures: isStrArr(c.failures) ? c.failures : [],
    writeConflicts: num("writeConflicts"),
    prevBookStatus: restorableStatus(c.prevBookStatus),
    memory: parseMemory(c.memory),
    captionBatches: parseCaptionBatches(c.captionBatches),
    captionAttempts: isIntArr(c.captionAttempts) ? c.captionAttempts : [],
    captionBatchesDone: isIntArr(c.captionBatchesDone) ? c.captionBatchesDone : [],
    captionFailures: num("captionFailures"),
    criticFailures: num("criticFailures"),
    skippedSteps: isStrArr(c.skippedSteps) ? c.skippedSteps : [],
    captions: strRecord(c.captions, PAGE_KEY_RE),
    headings: strRecord(c.headings, MOMENT_ID_RE),
    captionIssues: codeRecord(c.captionIssues),
    captionsDone: c.captionsDone === true,
    criticAttempts: num("criticAttempts"),
    critique: parseCritique(c.critique),
    critiqueDone: c.critiqueDone === true,
    repairTargets: parseRepairTargets(c.repairTargets),
    repairAttempts: isIntArr(c.repairAttempts) ? c.repairAttempts : [],
    repairBatchesDone: isIntArr(c.repairBatchesDone) ? c.repairBatchesDone : [],
    coverSwap: typeof c.coverSwap === "string" && c.coverSwap ? c.coverSwap : null,
    repairDone: c.repairDone === true,
  };
}

/** M4 cursor fields of a fresh run. */
function emptyCaptionFields(): Pick<
  RunCursor,
  | "memory"
  | "captionBatches"
  | "captionAttempts"
  | "captionBatchesDone"
  | "captionFailures"
  | "criticFailures"
  | "skippedSteps"
  | "captions"
  | "headings"
  | "captionIssues"
  | "captionsDone"
  | "criticAttempts"
  | "critique"
  | "critiqueDone"
  | "repairTargets"
  | "repairAttempts"
  | "repairBatchesDone"
  | "coverSwap"
  | "repairDone"
> {
  return {
    memory: null,
    captionBatches: null,
    captionAttempts: [],
    captionBatchesDone: [],
    captionFailures: 0,
    criticFailures: 0,
    skippedSteps: [],
    captions: {},
    headings: {},
    captionIssues: {},
    captionsDone: false,
    criticAttempts: 0,
    critique: null,
    critiqueDone: false,
    repairTargets: [],
    repairAttempts: [],
    repairBatchesDone: [],
    coverSwap: null,
    repairDone: false,
  };
}

/**
 * The cursor as stored once the run is over: no AI plan (titles), captions, headings, critique or
 * memory snapshot — ids, counts and codes only.
 */
export function stripCursorText(cursor: RunCursor, album: AlbumChoice | null = cursor.album?.kind === "ai" ? { kind: "ai" } : cursor.album): RunCursor {
  return { ...cursor, album, memory: null, captions: {}, headings: {}, critique: null };
}

/** A stored cursor nobody has written yet (startRun creates runs without one). */
function isBlankCursor(raw: unknown): boolean {
  return raw === null || raw === undefined || (isObj(raw) && Object.keys(raw).length === 0);
}

const SETTLED_BOOK_STATUSES: readonly BookAiStatus[] = ["idle", "done", "partial", "failed"];

/** A settled books.ai_status to restore (in-progress values of a crashed run → 'idle'). */
export function restorableStatus(v: unknown): BookAiStatus {
  return (SETTLED_BOOK_STATUSES as readonly unknown[]).includes(v) ? (v as BookAiStatus) : "idle";
}

function emptyProgress(phase: RunState): RunProgress {
  return { phase, photosTotal: 0, photosDone: 0, batchesTotal: 0, batchesDone: 0, photosCapped: 0, captionsTotal: 0, captionsDone: 0 };
}

export function parseProgress(raw: unknown, phase: RunState): RunProgress {
  const p = emptyProgress(phase);
  if (!isObj(raw)) return p;
  for (const k of ["photosTotal", "photosDone", "batchesTotal", "batchesDone", "photosCapped", "captionsTotal", "captionsDone"] as const) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) p[k] = v;
  }
  return p;
}

function progressOf(cursor: RunCursor, phase: RunState): RunProgress {
  const done = new Set(cursor.batchesDone);
  const capDone = new Set(cursor.captionBatchesDone);
  const capBatches = cursor.captionBatches ?? [];
  return {
    phase,
    photosTotal: cursor.batches.reduce((n, b) => n + b.length, 0),
    photosDone: cursor.batches.reduce((n, b, i) => n + (done.has(i) ? b.length : 0), 0),
    batchesTotal: cursor.batches.length,
    batchesDone: done.size,
    photosCapped: cursor.photosCapped,
    captionsTotal: capBatches.reduce((n, b) => n + b.keys.length, 0),
    captionsDone: capBatches.reduce((n, b, i) => n + (capDone.has(i) ? b.keys.length : 0), 0),
  };
}

const toJson = (v: unknown) => v as Json;
/** A doc as stored (v1 when it uses no v2 feature — serializeDoc, M10 D-062). */
const docJson = (doc: BookDoc) => serializeDoc(doc) as unknown as Json;

// ---------------------------------------------------------------------------------------------
// Row → domain helpers

const asOccasion = (v: string | null): Occasion =>
  (OCCASIONS as readonly string[]).includes(v ?? "") ? (v as Occasion) : "other";
const asCaptionLang = (v: string | null): CaptionLang =>
  (CAPTION_LANGS as readonly string[]).includes(v ?? "") ? (v as CaptionLang) : "en";
const asTone = (v: string | null, occasion: Occasion): Tone =>
  (TONES as readonly string[]).includes(v ?? "") ? (v as Tone) : DEFAULT_TONE[occasion];
const positive = (v: number | null): number => (v !== null && Number.isFinite(v) && v > 0 ? v : 1);

export function toCurationPhoto(r: CurationPhotoRow): CurationPhoto {
  return {
    id: r.id,
    thumbPath: r.thumb_path,
    width: r.width,
    height: r.height,
    takenAt: r.taken_at,
    dateSource: r.date_source === "exif" || r.date_source === "file" ? r.date_source : null,
    place: r.place,
    camera: r.camera,
    originalMime: r.original_mime,
    blurScore: r.blur_score,
    dupGroup: r.dup_group,
    status: r.status === "dropped" ? "dropped" : "kept",
    dropReason: isDropReason(r.drop_reason) ? r.drop_reason : null,
    userOverride: r.user_override === true,
    ai: r.ai,
    color: r.color,
  };
}

function toAutoPhoto(p: CurationPhoto): AutoPhoto {
  return {
    id: p.id,
    width: positive(p.width),
    height: positive(p.height),
    takenAt: p.takenAt,
    dateSource: p.dateSource,
    place: p.place,
    status: p.status,
    dupGroup: p.dupGroup,
    blurScore: p.blurScore,
  };
}

function storyBookOf(book: BookForRun): StoryBook {
  const occasion = asOccasion(book.occasion);
  return {
    occasion,
    tone: asTone(book.tone, occasion),
    captionLang: asCaptionLang(book.caption_lang),
    title: book.title,
    isPaid: book.is_paid === true,
    maxPages: book.max_pages,
  };
}

/** Current-version Curator notes from photos.ai, else null. */
export function analysisOf(ai: unknown): StoryAnalysis | null {
  if (!isObj(ai) || ai.v !== CURATOR_PROMPT_VERSION) return null;
  const { description, scene, mood, quality, coverWorthy } = ai;
  if (typeof description !== "string") return null;
  if (!(SCENES as readonly unknown[]).includes(scene) || !(MOODS as readonly unknown[]).includes(mood)) return null;
  if (typeof quality !== "number" || !Number.isFinite(quality) || typeof coverWorthy !== "boolean") return null;
  return { description, scene: scene as StoryAnalysis["scene"], mood: mood as StoryAnalysis["mood"], quality, coverWorthy };
}

function storyPhotosOf(photos: CurationPhoto[]): StoryPhoto[] {
  return photos.map((p) => ({
    id: p.id,
    width: positive(p.width),
    height: positive(p.height),
    takenAt: p.takenAt,
    place: p.place,
    keep: p.status === "kept",
    analysis: analysisOf(p.ai),
  }));
}

/** Time order (undated last), ties by id — the stable order aliases are assigned in. */
function byTime(a: CurationPhoto, b: CurationPhoto): number {
  const ma = parseTime(a.takenAt);
  const mb = parseTime(b.takenAt);
  if (ma !== null && mb !== null && ma !== mb) return ma - mb;
  if (ma === null && mb !== null) return 1;
  if (ma !== null && mb === null) return -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Appends aliases for photos that have none yet (e.g. uploaded after the run started). */
function extendAliases(cursor: RunCursor, photos: CurationPhoto[]): void {
  const known = new Set(cursor.aliasIds);
  for (const p of [...photos].sort(byTime)) {
    if (!known.has(p.id)) {
      cursor.aliasIds.push(p.id);
      known.add(p.id);
    }
  }
}

const aliasOfMap = (c: RunCursor) => new Map(c.aliasIds.map((id, i) => [id, `p${i + 1}`]));
const aliasToIdMap = (c: RunCursor) => new Map(c.aliasIds.map((id, i) => [`p${i + 1}`, id]));

/** Initial cursor: aliases over all ready photos; batches over photos needing analysis, capped. */
export function initialCursor(photos: CurationPhoto[], maxAnalyzedPhotos: number, prevBookStatus: unknown = "idle"): RunCursor {
  const sorted = [...photos].sort(byTime);
  const aliasIds = sorted.map((p) => p.id);
  const aliasNo = new Map(aliasIds.map((id, i) => [id, i + 1]));
  const analysed = photos.filter((p) => !needsCuration(p)).length;
  const remaining = Math.max(0, maxAnalyzedPhotos - analysed);
  const candidates = sorted.filter((p) => needsCuration(p) && p.thumbPath);
  const selected = candidates.slice(0, remaining);
  const batches = buildBatches(selected.map((p) => ({ id: p.id, takenAt: p.takenAt, dupGroup: p.dupGroup }))).map((b) =>
    b.map((id) => aliasNo.get(id) as number),
  );
  return {
    v: CURSOR_VERSION,
    aliasIds,
    batches,
    batchesDone: [],
    batchAttempts: batches.map(() => 0),
    batchesAi: 0,
    aiFailures: 0,
    photosCapped: candidates.length - selected.length,
    curationDone: false,
    storyAttempt: 0,
    issues: [],
    album: null,
    failures: [],
    writeConflicts: 0,
    prevBookStatus: restorableStatus(prevBookStatus),
    ...emptyCaptionFields(),
  };
}

/** Kept / dropped decision → the curation row to write (or null when nothing changes). */
function decisionRow(
  p: CurationPhoto,
  d: { keep: boolean; dropReason: DropReason | null },
  ai: CurationWrite["ai"] | undefined,
): CurationWrite | null {
  const row: CurationWrite = { id: p.id };
  if (ai !== undefined && ai !== null) row.ai = ai;
  if (!p.userOverride) {
    const status = d.keep ? "kept" : "dropped";
    const reason = d.keep ? null : d.dropReason;
    if (status !== p.status || reason !== p.dropReason || row.ai !== undefined) {
      row.status = status;
      row.dropReason = reason;
    }
  }
  return row.ai !== undefined || row.status !== undefined ? row : null;
}

/** Mirrors writeCuration's semantics on the in-memory photos of this tick. */
function applyRows(photos: CurationPhoto[], rows: CurationWrite[]): void {
  const byId = new Map(photos.map((p) => [p.id, p]));
  for (const r of rows) {
    const p = byId.get(r.id);
    if (!p) continue;
    if (r.ai !== undefined) p.ai = r.ai;
    if (r.status && !p.userOverride) {
      p.status = r.status;
      p.dropReason = r.status === "kept" ? null : isDropReason(r.dropReason) ? r.dropReason : null;
    }
  }
}

/** Rule-based album, stamped with the book's format + design style (D-063, M10b A6). */
function ruleDoc(photos: CurationPhoto[], book: BookForRun, runId: string | null): BookDoc {
  const design = bookDesignOf(book);
  const doc = autolayout(photos.map(toAutoPhoto), {
    occasion: asOccasion(book.occasion),
    title: book.title,
    captionLang: asCaptionLang(book.caption_lang),
    isPaid: book.is_paid === true,
    runId,
    design,
  });
  return withBookDesign(doc, design);
}

function docIssues(doc: BookDoc, photos: CurationPhoto[], book: BookForRun): string[] {
  const parsed = parseBookDoc(doc);
  if (!parsed.ok) return parsed.issues;
  const kept = new Set(photos.filter((p) => p.status === "kept").map((p) => p.id));
  return validateBookDoc(parsed.doc, { photoIds: kept, maxPages: limitsFor(book.is_paid === true).maxPages });
}

/** Rule-mode / leftover curation: rule decisions for photos needing curation, then ≥ 1 kept. */
function ruleCurationRows(photos: CurationPhoto[], subset: CurationPhoto[]): CurationWrite[] {
  const rule = ruleCurate(subset, { ensureOneKept: false });
  const decisions = new Map<string, { keep: boolean; dropReason: DropReason | null }>();
  for (const p of photos) decisions.set(p.id, rule.get(p.id) ?? { keep: p.status === "kept", dropReason: p.dropReason });
  const ensured = ensureAtLeastOneKept(photos, decisions);
  const rows: CurationWrite[] = [];
  for (const p of photos) {
    const row = decisionRow(p, ensured.get(p.id)!, undefined);
    if (row) rows.push(row);
  }
  return rows;
}

export class OrchestratorError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`orchestrator: ${code}`);
    this.name = "OrchestratorError";
    this.code = code;
  }
}

function errorCodeOf(e: unknown): string {
  if (e instanceof OrchestratorError) return e.code;
  if (isUnsupportedDesignError(e)) return e.code; // 'unsupported_design'
  const code = isObj(e) && typeof e.code === "string" && /^[\w-]{1,32}$/.test(e.code) ? e.code : null;
  return code ? `internal_${code}` : "internal_error";
}

const isFinished = (s: string) => s === "done" || s === "failed";
const bookStatusOf = (s: RunAiStatus): BookAiStatus => (s === "ok" ? "done" : s);

function pushFailure(c: RunCursor, code: string): void {
  if (c.failures.length < MAX_FAILURE_CODES) c.failures.push(code);
}

/** Failure codes that become the run's error_code whenever present (they explain a partial run). */
const PRIORITY_FAILURES = ["cursor_too_large", "run_budget"] as const;

/** Records a priority code once; it is kept even when the failure list is full. */
function pushFailureOnce(c: RunCursor, code: (typeof PRIORITY_FAILURES)[number]): void {
  if (c.failures.includes(code)) return;
  if (c.failures.length >= MAX_FAILURE_CODES) c.failures[c.failures.length - 1] = code;
  else c.failures.push(code);
}

/** error_code of a finished, non-ok run: a priority code if any, else the first failure. */
function runErrorCode(c: RunCursor): string | null {
  for (const p of PRIORITY_FAILURES) if (c.failures.includes(p)) return p;
  return c.failures[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// startRun

export async function startRun(input: StartInput, deps: OrchestratorDeps = defaultDeps()): Promise<StartResult> {
  const book = await deps.getBookForRun(input.bookId);
  if (!book || book.user_id !== input.userId) return { ok: false, error: "not_found" };
  if (!isAiReplaceableDoc(book.doc)) return { ok: false, error: "user_edited" }; // D-018 + D-031
  // Review S1: no layouts for this style → nothing to build; no run row, no model call, no cost.
  if (!isSupportedDesign(bookDesignOf(book))) return { ok: false, error: "unsupported_design" };

  const aiMode = deps.resolveMode();
  const transport = aiMode === "off" ? null : deps.transportFor(aiMode);
  if (aiMode === "off" || !transport) return startRuleRun(input, book, deps);

  // Limits are enforced atomically by createRunCapped BEFORE any model call (live runs only).
  // The route derives the trigger server-side; defensively, a "build" on a book whose album the
  // AI already made (or that already had a finished live AI run) counts as a rebuild.
  const trigger = await effectiveTrigger(input.trigger, book, aiMode, deps);
  // D-059: over the global daily budget → no run row, no model call, nothing counted. The book
  // keeps its rule album (written at finalize, D-016). Replay costs nothing and is never refused.
  if (aiMode === "live" && (await overDailyBudget(deps))) {
    return { ok: false, error: "limit", limit: "budget_exhausted" };
  }
  const limits = limitsFor(book.is_paid === true);
  const created = await deps.createRunCapped({
    bookId: book.id,
    userId: input.userId,
    trigger,
    mode: aiMode,
    dailyCap: limits.maxLiveBuildsPerUserPerDay,
    rebuildCap: limits.maxRebuilds,
    enforce: aiMode === "live",
  });
  if ("error" in created) {
    return created.error === "limit"
      ? { ok: false, error: "limit", limit: created.limit }
      : { ok: false, error: "already_running" };
  }
  // No cursor yet: the first tick builds it from the photos as they are then (state 'queued').
  return { ok: true, runId: created.id, mode: aiMode, state: "queued" };
}

/** Never throws: a failing check fails open (budget.ts already logs the code). */
async function overDailyBudget(deps: OrchestratorDeps): Promise<boolean> {
  if (!deps.isOverDailyAiBudget) return false;
  try {
    return (await deps.isOverDailyAiBudget()) === true;
  } catch {
    return false;
  }
}

async function effectiveTrigger(
  requested: StartInput["trigger"],
  book: BookForRun,
  mode: AiMode,
  deps: OrchestratorDeps,
): Promise<RunTrigger> {
  if (requested === "rebuild") return "rebuild";
  if (docOrigin(book.doc).generator === "ai") return "rebuild";
  if (mode === "live" && (await deps.hasFinishedLiveAiRun(book.id))) return "rebuild";
  return "build";
}

/** AI off (D-024): rule curation + rule album, synchronously. The run is logged with mode 'rule'. */
async function startRuleRun(input: StartInput, book: BookForRun, deps: OrchestratorDeps): Promise<StartResult> {
  const limits = limitsFor(book.is_paid === true);
  const created = await deps.createRunCapped({
    bookId: book.id,
    userId: input.userId,
    trigger: input.trigger,
    mode: "rule",
    dailyCap: limits.maxLiveBuildsPerUserPerDay,
    rebuildCap: limits.maxRebuilds,
    enforce: false,
  });
  if ("error" in created) return { ok: false, error: "already_running" };
  const runId = created.id;
  // A run that cannot be claimed right after creation stays queued; the first advance() finishes
  // it with the rule album (its mode never matches resolveAiMode() → 'mode_changed' path).
  const token = await deps.claimRun(runId, LEASE_SECONDS);
  if (!token) return { ok: true, runId, mode: "rule", state: "queued" };
  const progress = emptyProgress("done");
  try {
    const photos = (await deps.listPhotosForCuration(book.id)).map(toCurationPhoto);
    const rows = ruleCurationRows(photos, photos.filter((p) => needsCuration(p)));
    if (rows.length) {
      await deps.writeCuration(book.id, rows);
      applyRows(photos, rows);
    }
    const doc = ruleDoc(photos, book, runId);
    const issues = docIssues(doc, photos, book);
    if (issues.length) throw new OrchestratorError("rule_album_invalid");
    const fresh = await deps.getBookForRun(book.id);
    if (!fresh) throw new OrchestratorError("not_found");
    const w = await deps.writeDocIfReplaceable(book.id, docJson(doc), doc.pages.length, { updatedAt: fresh.updated_at });
    const errorCode = w.ok ? null : w.reason;
    if (w.ok) await deps.setBookAiStatus(book.id, "idle");
    const saved = await deps.checkpointRun(runId, token, {
      state: "done",
      ai_status: null,
      error_code: errorCode,
      progress: toJson(progress),
      finished_at: new Date(deps.now()).toISOString(),
    });
    return { ok: true, runId, mode: "rule", state: saved ? "done" : "queued" };
  } catch (e) {
    const saved = await deps
      .checkpointRun(runId, token, {
        state: "failed",
        ai_status: null,
        error_code: errorCodeOf(e),
        progress: toJson(emptyProgress("failed")),
        finished_at: new Date(deps.now()).toISOString(),
      })
      .catch(() => false);
    return { ok: true, runId, mode: "rule", state: saved ? "failed" : "queued" };
  } finally {
    await deps.releaseRun(runId, token).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// advance

export async function advance(
  runId: string,
  opts: { budgetMs?: number } = {},
  deps: OrchestratorDeps = defaultDeps(),
): Promise<AdvanceResult> {
  const budgetMs = opts.budgetMs ?? DEFAULT_TICK_BUDGET_MS;
  // M5 review B1: only build / rebuild runs are ever ticked. A ✨ rewrite run (trigger 'rewrite',
  // one bounded request) shares agent_runs but is "not found" here and is NEVER claimed — claiming
  // it would run an uncapped full build on its row. claim_agent_run (0900) refuses it as well.
  const pre = await deps.getRunForTick(runId);
  if (!pre || !agentRunsDb.isBuildRunTrigger(pre.trigger)) return { notFound: true };
  // Taken BEFORE the claim: our view of the lease end is never later than the DB's.
  const t0 = deps.now();
  const token = await deps.claimRun(runId, LEASE_SECONDS);
  if (!token) {
    // Lease held by another tick — or the run is finished / missing (claim refuses those too).
    const run = await deps.getRunForTick(runId);
    if (!run) return { notFound: true };
    if (isFinished(run.state)) return finishedResult(run);
    return { leased: true };
  }
  let result: AdvanceResult | null = null;
  try {
    result = await tick(runId, token, t0, budgetMs, deps);
    return result;
  } finally {
    // A stale tick (lease taken over) must not touch the new holder's lease.
    if (!result || !("leased" in result)) await deps.releaseRun(runId, token).catch(() => undefined);
  }
}

function finishedResult(run: Pick<RunForTick, "state" | "progress" | "ai_status" | "error_code">): AdvanceResult {
  const state = run.state as RunState;
  return {
    state,
    progress: parseProgress(run.progress, state),
    done: isFinished(state),
    aiStatus: (run.ai_status as RunAiStatus | null) ?? null,
    errorCode: run.error_code ?? null,
  };
}

/** Thrown when a checkpoint reports that our lease was taken over. Never escapes tick(). */
class StaleLeaseError extends Error {
  constructor() {
    super("orchestrator: stale lease");
    this.name = "StaleLeaseError";
  }
}

interface Tick {
  deps: OrchestratorDeps;
  runId: string;
  token: string;
  run: RunForTick;
  book: BookForRun;
  photos: CurationPhoto[];
  cursor: RunCursor;
  state: RunState;
  /** null only on the mode-changed path (no model call is made). */
  transport: AgentTransport | null;
  logger: StepLogger;
  t0: number;
  budgetMs: number;
  /** End of our lease on the deps clock. */
  leaseEnd: number;
  /** A model call (wave / Storyteller) already ran in this tick. */
  heavyDone: boolean;
  /** planDocOf() of this tick (undefined = not computed yet). */
  planDoc?: PlanDoc | null;
  /** Captions / headings as of the last successful checkpoint (restored when a cursor is too large). */
  saved: { captions: Record<string, string>; headings: Record<string, string> };
}

/** Thrown by save() after it shed the caption work of an oversized cursor; loop() continues at validating. */
class CaptionsShedSignal extends Error {
  constructor() {
    super("orchestrator: caption work shed");
    this.name = "CaptionsShedSignal";
  }
}

async function tick(runId: string, token: string, t0: number, budgetMs: number, deps: OrchestratorDeps): Promise<AdvanceResult> {
  const run = await deps.getRunForTick(runId);
  // Defence in depth (B1): advance() already refused non-build triggers before claiming.
  if (!run || !agentRunsDb.isBuildRunTrigger(run.trigger)) return { notFound: true };
  if (isFinished(run.state)) return finishedResult(run);

  let ctx: Tick | null = null;
  try {
    const book = run.book_id ? await deps.getBookForRun(run.book_id) : null;
    if (!book || book.user_id !== run.user_id) {
      return await finishRun(deps, runId, token, null, null, {
        state: "failed",
        aiStatus: "failed",
        errorCode: "not_found",
        progress: { ...parseProgress(run.progress, "failed"), phase: "failed" },
        bookStatus: null,
      });
    }
    // Review S1: a run queued for a style without layouts (startRun refuses new ones) fails
    // cleanly here, before any model call: state failed, error_code 'unsupported_design'.
    if (!isSupportedDesign(bookDesignOf(book))) throw new OrchestratorError("unsupported_design");
    const photos = (await deps.listPhotosForCuration(book.id)).map(toCurationPhoto);
    let cursor = parseCursor(run.cursor);
    if (!cursor && run.state === "queued" && isBlankCursor(run.cursor)) {
      cursor = initialCursor(photos, limitsFor(book.is_paid === true).maxAnalyzedPhotos, book.ai_status);
      // Memory snapshot for the whole run (D-032), taken once when the run's cursor is created.
      cursor.memory = await loadMemory(deps, book.user_id);
    }
    if (!cursor) throw new OrchestratorError("bad_cursor");
    extendAliases(cursor, photos);

    // The AI mode may have changed since the run started (key removed, AI_MODE switched,
    // replay run seen by a production server): never call a transport the run was not made for.
    const modeChanged = deps.resolveMode() !== run.mode;
    let transport: AgentTransport | null = null;
    if (!modeChanged) {
      if (run.mode !== "live" && run.mode !== "replay") throw new OrchestratorError("bad_mode");
      transport = deps.transportFor(run.mode);
      if (!transport) throw new OrchestratorError("ai_unavailable");
    }

    ctx = {
      deps,
      runId,
      token,
      run,
      book,
      photos,
      cursor,
      state: run.state as RunState,
      transport,
      logger: deps.stepLogger(runId),
      t0,
      budgetMs,
      leaseEnd: t0 + LEASE_SECONDS * 1000,
      heavyDone: false,
      saved: { captions: { ...cursor.captions }, headings: { ...cursor.headings } },
    };
    if (modeChanged) return await finishWithRuleAlbum(ctx, "mode_changed");
    return await loop(ctx);
  } catch (e) {
    if (e instanceof StaleLeaseError) return { leased: true };
    return crash(deps, run, token, ctx, errorCodeOf(e));
  }
}

/** Sanitised, non-empty memory of the user, or null. Best effort: any error → no memory. */
async function loadMemory(deps: OrchestratorDeps, userId: string): Promise<UserMemory | null> {
  try {
    const raw = await deps.getUserMemory(userId);
    if (raw === null || raw === undefined) return null;
    const mem = sanitizeMemory(raw);
    return isEmptyMemory(mem) ? null : mem;
  } catch {
    return null;
  }
}

const elapsed = (c: Tick) => c.deps.now() - c.t0;

/** Does a request with this timeout (plus the write margin) still fit in our lease? */
const callFits = (c: Tick, timeoutMs: number) => c.deps.now() + timeoutMs + LEASE_MARGIN_MS <= c.leaseEnd;

/** Retry policy for agent steps: retries only while they fit the lease (runAgentStep checks). */
function stepRetry(c: Tick): RetryOptions {
  return { retries: STEP_RETRIES, deadline: c.leaseEnd - LEASE_MARGIN_MS, sleep: c.deps.sleep };
}

function needTransport(c: Tick): AgentTransport {
  if (!c.transport) throw new OrchestratorError("ai_unavailable");
  return c.transport;
}

const CAPTION_STATES: readonly RunState[] = ["captioning", "critiquing", "repairing", "validating"];

/**
 * SF1: an oversized caption-phase cursor drops its pending caption work instead of failing the
 * checkpoint: captions/headings go back to the last checkpointed ones (all of them if even that
 * is too large), still-failing ones are removed, no Critic / repair is left to do and the run
 * continues at validating with the AI album. false = nothing to shed (not a caption phase).
 */
function shedCaptionWork(c: Tick, limit: number): boolean {
  if (!CAPTION_STATES.includes(c.state)) return false;
  const cur = c.cursor;
  cur.captions = { ...c.saved.captions };
  cur.headings = { ...c.saved.headings };
  if (cursorBytes(cur) > limit) {
    cur.captions = {};
    cur.headings = {};
  }
  const pd = planDocOf(c);
  if (pd) finalizeCaptions(c, pd);
  cur.captionIssues = {};
  cur.critique = null;
  cur.repairTargets = [];
  cur.coverSwap = null;
  cur.captionBatchesDone = (cur.captionBatches ?? []).map((_, i) => i);
  cur.captionsDone = true;
  cur.critiqueDone = true;
  cur.repairDone = true;
  cur.captionFailures++;
  pushFailureOnce(cur, "cursor_too_large");
  c.state = "validating";
  return true;
}

/**
 * Checkpoint with our lease token; throws StaleLeaseError when the lease was taken over. A cursor
 * over the size limit is shed in caption phases (then CaptionsShedSignal), else the run fails
 * with cursor_too_large.
 */
async function save(c: Tick, extra: RunCheckpointPatch = {}): Promise<void> {
  const limit = c.deps.maxCursorBytes?.() ?? cursorByteLimit();
  let shedFrom: RunState | null = null;
  if (cursorBytes(c.cursor) > limit) {
    const from = c.state;
    if (!shedCaptionWork(c, limit) || cursorBytes(c.cursor) > limit) throw new OrchestratorError("cursor_too_large");
    shedFrom = from;
  }
  const ok = await c.deps.checkpointRun(c.runId, c.token, {
    state: c.state,
    cursor: toJson(c.cursor),
    progress: toJson(progressOf(c.cursor, c.state)),
    ...extra,
  });
  if (!ok) throw new StaleLeaseError();
  c.saved = { captions: { ...c.cursor.captions }, headings: { ...c.cursor.headings } };
  // Callers in a caption phase must not continue their (now dropped) work.
  if (shedFrom !== null && shedFrom !== "validating") throw new CaptionsShedSignal();
}

function yieldTick(c: Tick): AdvanceResult {
  return { state: c.state, progress: progressOf(c.cursor, c.state), done: false, aiStatus: null, errorCode: null };
}

/** Wave size: batch 0 alone first (writes the prompt cache), then the rest of the first wave. */
function waveSize(batchesDone: number): number {
  if (batchesDone === 0) return 1;
  return batchesDone < CURATOR_CONCURRENCY ? CURATOR_CONCURRENCY - batchesDone : CURATOR_CONCURRENCY;
}

async function loop(c: Tick): Promise<AdvanceResult> {
  for (;;) {
    try {
      const out = await loopStep(c);
      if (out) return out;
    } catch (e) {
      if (e instanceof CaptionsShedSignal) continue; // state is now validating
      throw e;
    }
  }
}

/** One state of the machine; null = continue with the next state. */
async function loopStep(c: Tick): Promise<AdvanceResult | null> {
  switch (c.state) {
    case "queued":
      c.state = "curating";
      await save(c);
      await c.deps.setBookAiStatus(c.book.id, "analyzing");
      return null;

    case "curating": {
      const done = new Set(c.cursor.batchesDone);
      const pending = c.cursor.batches.map((_, i) => i).filter((i) => !done.has(i));
      if (pending.length) {
        if (c.heavyDone && elapsed(c) > c.budgetMs * CURATOR_WAVE_CUTOFF) return yieldTick(c);
        if (!callFits(c, AGENT_TIMEOUT_MS.curator)) return yieldTick(c);
        await curatorWave(c, pending.slice(0, waveSize(done.size)));
        return null;
      }
      await finishCuration(c);
      c.state = "storytelling";
      await save(c);
      await c.deps.setBookAiStatus(c.book.id, "planning");
      return null;
    }

    case "storytelling":
      // The Storyteller is one long request: it runs alone, at the start of its own tick.
      if (c.heavyDone || !callFits(c, AGENT_TIMEOUT_MS.storyteller)) return yieldTick(c);
      await storytellerStep(c);
      return null;

    case "captioning":
      if ((await captioningStep(c)) === "yield") return yieldTick(c);
      return null;

    case "critiquing":
      if ((await critiquingStep(c)) === "yield") return yieldTick(c);
      return null;

    case "repairing":
      if ((await repairingStep(c)) === "yield") return yieldTick(c);
      return null;

    case "validating":
      return await validateAndSave(c);

    default:
      throw new OrchestratorError("bad_state");
  }
}

type WaveOutcome = { bi: number; result: Awaited<ReturnType<typeof curateBatch>> | null };

async function curatorWave(c: Tick, indices: number[]): Promise<void> {
  const transport = needTransport(c);
  const byId = new Map(c.photos.map((p) => [p.id, p]));
  const aliasOf = aliasOfMap(c.cursor);
  const occasion = asOccasion(c.book.occasion);

  // 1. Plan the wave and reserve one attempt per real call (checkpointed before any call).
  const outcomes: WaveOutcome[] = [];
  const calls: Array<{ bi: number; attempt: number; batch: CurationPhoto[] }> = [];
  for (const bi of indices) {
    const batch = c.cursor.batches[bi]
      .map((n) => byId.get(c.cursor.aliasIds[n - 1]))
      .filter((p): p is CurationPhoto => p !== undefined);
    // Photos gone, or notes already written by a tick that died before its checkpoint.
    if (batch.length === 0 || batch.every((p) => !needsCuration(p))) {
      outcomes.push({ bi, result: null });
      continue;
    }
    const used = c.cursor.batchAttempts[bi] ?? 0;
    if (used >= MAX_BATCH_ATTEMPTS) {
      outcomes.push({ bi, result: ruleBatchResult(batch, "attempts") });
      continue;
    }
    c.cursor.batchAttempts[bi] = used + 1;
    calls.push({ bi, attempt: used + 1, batch });
  }
  if (calls.length) await save(c);

  // 2. The calls (parallel).
  const results = await Promise.all(
    calls.map(async ({ bi, attempt, batch }) => ({
      bi,
      result: await curateBatch({
        runId: c.runId,
        stepKey: `curator:${bi}`,
        attempt,
        batch,
        occasion,
        aliasOf,
        transport,
        logger: c.logger,
        deps: {
          loadThumbs: c.deps.loadThumbBase64,
          ...(c.deps.colorFromThumb && c.deps.setPhotosColor ? { colorOf: c.deps.colorFromThumb } : {}),
        },
        retry: stepRetry(c),
      }),
    })),
  );
  outcomes.push(...results);
  if (calls.length) c.heavyDone = true;

  // 3. Still our lease? Only then touch photos.
  await save(c);
  const rows: CurationWrite[] = [];
  for (const { result } of outcomes) {
    if (!result) continue;
    for (const [id, r] of result.results) {
      const p = byId.get(id);
      if (!p) continue;
      const row = decisionRow(p, r, r.ai === null ? undefined : toJson(r.ai));
      if (row) rows.push(row);
    }
  }
  if (rows.length) {
    await c.deps.writeCuration(c.book.id, rows);
    applyRows(c.photos, rows);
  }
  await storeBackfilledColors(c, outcomes);

  for (const { bi, result } of outcomes.sort((x, y) => x.bi - y.bi)) {
    c.cursor.batchesDone.push(bi);
    if (!result) continue;
    if (result.usedAi) c.cursor.batchesAi++;
    else {
      c.cursor.aiFailures++;
      pushFailure(c.cursor, `curator_${result.failure?.code ?? "no_thumbs"}`);
    }
  }
  await save(c);
}

/**
 * M10c: colours the Curator computed from thumbs (photos whose color was null) → photos.color.
 * Runs after the lease check, like writeCuration. Not fatal: a failure leaves the colours null
 * (logged by code only — never ids or colours).
 */
async function storeBackfilledColors(c: Tick, outcomes: WaveOutcome[]): Promise<void> {
  if (!c.deps.setPhotosColor) return;
  const colors = new Map<string, string>();
  for (const { result } of outcomes) for (const [id, hex] of result?.colors ?? []) colors.set(id, hex);
  if (colors.size === 0) return;
  try {
    await c.deps.setPhotosColor(c.book.id, colors);
    for (const p of c.photos) {
      const hex = colors.get(p.id);
      if (hex && p.color == null) p.color = hex;
    }
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "unknown";
    console.error(`[orchestrator] photo colours not saved (${code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)})`);
  }
}

/** Rule decisions for a whole batch without a call (its attempts were used up by dead ticks). */
function ruleBatchResult(batch: CurationPhoto[], code: "attempts"): WaveOutcome["result"] {
  const rule = ruleCurate(batch, { ensureOneKept: false });
  const results = new Map(
    batch.map((p) => {
      const d = rule.get(p.id)!;
      return [p.id, { keep: d.keep, dropReason: d.dropReason, ai: null, source: "rule" as const }];
    }),
  );
  return { results, usedAi: false, failure: { code: code as StepErrorCode, retryable: false }, costUsd: 0 };
}

/**
 * Book-level: rule-curate photos still needing curation that no finished batch covered (over the
 * cap, added later, or — on the mode-changed path — in batches never sent), then ≥ 1 kept.
 */
async function finishCuration(c: Tick): Promise<void> {
  if (c.cursor.curationDone) return;
  const done = new Set(c.cursor.batchesDone);
  const covered = new Set(
    c.cursor.batches.flatMap((b, i) => (done.has(i) ? b : [])).map((n) => c.cursor.aliasIds[n - 1]),
  );
  const leftovers = c.photos.filter((p) => needsCuration(p) && !covered.has(p.id));
  const rows = ruleCurationRows(c.photos, leftovers);
  if (rows.length) {
    await save(c);
    await c.deps.writeCuration(c.book.id, rows);
    applyRows(c.photos, rows);
  }
  c.cursor.curationDone = true;
}

/** Storyteller failures worth attempt 2 (T9): invalid plans and transient / malformed answers. */
function retryableStoryFailure(code: StepErrorCode, retryable: boolean): boolean {
  return retryable || code === "parse_failed" || code === "schema_invalid";
}

async function storytellerStep(c: Tick): Promise<void> {
  const attempt = c.cursor.storyAttempt + 1;
  if (attempt > MAX_STORY_ATTEMPTS) {
    if (!c.cursor.album) {
      pushFailure(c.cursor, "storyteller_attempts");
      c.cursor.album = { kind: "rule", reason: "storyteller_attempts" };
    }
    c.state = "captioning";
    await save(c);
    return;
  }
  const transport = needTransport(c);
  // Reserve the attempt before the call: a resumed tick logs attempt + 1, never a duplicate.
  c.cursor.storyAttempt = attempt;
  await save(c);

  const photos = storyPhotosOf(c.photos);
  const book = storyBookOf(c.book);
  const result = await planAlbum({
    runId: c.runId,
    stepKey: "storyteller",
    attempt,
    photos,
    book,
    aliasOf: aliasOfMap(c.cursor),
    transport,
    logger: c.logger,
    previousIssues: c.cursor.issues.length ? c.cursor.issues : undefined,
    memory: c.cursor.memory,
    design: bookDesignOf(c.book),
    retry: stepRetry(c),
  });
  c.heavyDone = true;

  let failure: string | null = null;
  let retry = false;
  if (result.ok) {
    const out = planToDoc(result.data, {
      aliasToId: aliasToIdMap(c.cursor),
      photos,
      book,
      runId: c.runId,
      generatorVersion: STORYTELLER_PROMPT_VERSION,
      design: bookDesignOf(c.book),
    });
    if ("doc" in out) {
      c.cursor.album = { kind: "ai", plan: result.data };
      c.cursor.issues = [];
    } else {
      c.cursor.issues = out.issues.slice(0, MAX_RETRY_ISSUES);
      failure = "storyteller_invalid";
      retry = true;
    }
  } else {
    c.cursor.issues = [];
    failure = `storyteller_${result.code}`;
    retry = retryableStoryFailure(result.code, result.retryable);
  }

  if (failure) {
    if (retry && attempt < MAX_STORY_ATTEMPTS) {
      await save(c); // stay in storytelling; attempt 2 runs on the next tick (alone)
      return;
    }
    pushFailure(c.cursor, failure);
    c.cursor.album = { kind: "rule", reason: failure };
  }
  c.state = "captioning";
  await save(c);
}

/**
 * One `skipped` agent_steps row (step key "{agent}:skipped"), no model call. Idempotent: the key
 * is recorded in the cursor and checkpointed BEFORE the insert, so a resumed tick never writes a
 * second row (a tick dying between the two loses the cosmetic row, never duplicates it).
 */
async function skippedStep(c: Tick, agent: AgentName, reason: string): Promise<void> {
  const stepKey = `${agent}:skipped`;
  if (c.cursor.skippedSteps.includes(stepKey)) return;
  c.cursor.skippedSteps.push(stepKey);
  await save(c);
  await c.logger.insertStep({
    runId: c.runId,
    agent,
    stepKey,
    attempt: 1,
    retries: 0,
    status: "skipped",
    inputSummary: { reason },
    output: null,
    model: AI_MODEL,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    stopReason: null,
    error: null,
  });
}

// ---------------------------------------------------------------------------------------------
// Captions (M4): captioning → critiquing → repairing

type StepOutcome = "next" | "yield";

/** The AI doc of the stored plan + the photo view it was built from. */
interface PlanDoc {
  doc: BookDoc;
  photos: StoryPhoto[];
  photosById: Map<string, StoryPhoto>;
  specs: CaptionBatchSpec[];
}

/**
 * Rebuilds the (uncaptioned) AI doc of the stored plan. Photos the plan uses count as kept and
 * photos deleted since get a neutral stand-in, so the page structure — and with it every caption
 * key "m{n}:{k}" — stays exactly as planned while photos change under the run; validating maps
 * the captions onto the pruned doc (captionsForDoc). null for rule albums.
 */
function planDocOf(c: Tick): PlanDoc | null {
  if (c.planDoc !== undefined) return c.planDoc;
  c.planDoc = null;
  const album = c.cursor.album;
  if (album?.kind !== "ai" || !album.plan) return null;
  const aliasToId = aliasToIdMap(c.cursor);
  const used = new Set<string>();
  const addAlias = (a: string) => {
    const id = aliasToId.get(a);
    if (id) used.add(id);
  };
  for (const m of album.plan.moments) for (const pg of m.pages) pg.photoIds.forEach(addAlias);
  addAlias(album.plan.coverPhotoId);
  const photos = storyPhotosOf(c.photos).map((p) => (used.has(p.id) && !p.keep ? { ...p, keep: true } : p));
  const have = new Set(photos.map((p) => p.id));
  for (const id of used) {
    if (!have.has(id)) photos.push({ id, width: 1, height: 1, takenAt: null, place: null, keep: true, analysis: null });
  }
  const out = planToDoc(album.plan, {
    aliasToId,
    photos,
    book: storyBookOf(c.book),
    runId: c.runId,
    generatorVersion: STORYTELLER_PROMPT_VERSION,
    design: bookDesignOf(c.book),
  });
  if (!("doc" in out)) return null;
  // Grounded titles: the Caption Writer and the Critic see the same neutral titles the book gets.
  out.doc = groundedDoc(c, out.doc, photos);
  const specs = captionBatches(out.doc, {
    lang: asCaptionLang(c.book.caption_lang),
    maxBatches: limitsFor(c.book.is_paid === true).maxCaptionBatchesPerBuild,
  });
  c.planDoc = { doc: out.doc, photos, photosById: new Map(photos.map((p) => [p.id, p])), specs };
  return c.planDoc;
}

const refOf = (s: CaptionBatchSpec): CaptionBatchRef => ({ moments: s.moments.map((m) => m.momentId), keys: [...s.keys] });
const sameRefs = (a: CaptionBatchRef[], b: CaptionBatchRef[]) => JSON.stringify(a) === JSON.stringify(b);

/** No new model call in this tick after the soft budget once a call already ran. */
const pastSoftBudget = (c: Tick) => c.heavyDone && elapsed(c) > c.budgetMs * CAPTION_WAVE_CUTOFF;

function captionBook(c: Tick) {
  const b = storyBookOf(c.book);
  return { occasion: b.occasion, tone: b.tone, captionLang: b.captionLang, title: b.title };
}

/** Caption Writer failures worth a second attempt (transient / malformed); refusals are final. */
const retryableCaptionFailure = retryableStoryFailure;

/** Ends the caption phases without (more) captions: straight to validating. */
async function skipCaptions(c: Tick): Promise<void> {
  c.cursor.captionsDone = true;
  c.cursor.critiqueDone = true;
  c.cursor.repairDone = true;
  c.state = "validating";
  await save(c);
}

/**
 * Pre-check context from user data + metadata only (SF3): the USER's title (books.title, never the
 * AI cover title), GPS places of the photos and chapters, names the user typed (memory), photo
 * dates. Storyteller chapter titles are AI text and never allowlist anything.
 */
function metaCaptionContext(c: Tick, photos: readonly StoryPhoto[], chapters: BookDoc["chapters"] = []): CaptionCheckContext {
  return buildCaptionContext({
    lang: asCaptionLang(c.book.caption_lang),
    bookTitle: c.book.title,
    chapters: chapters.map((ch) => ({ place: ch.place })),
    photoPlaces: photos.map((p) => p.place),
    knownNames: c.cursor.memory?.knownNames ?? [],
    dates: photos.map((p) => p.takenAt),
  });
}

/** Pre-check context of the whole book (plan doc). */
function bookCaptionContext(c: Tick, pd: PlanDoc): CaptionCheckContext {
  return metaCaptionContext(c, pd.photos, pd.doc.chapters);
}

/** SF3: Storyteller chapter titles / subtitle that fail the pre-check become neutral (pure). */
function groundedDoc(c: Tick, doc: BookDoc, photos: readonly StoryPhoto[]): BookDoc {
  return groundStoryText(doc, metaCaptionContext(c, photos, doc.chapters), {
    lang: asCaptionLang(c.book.caption_lang),
    dates: photos.filter((p) => p.keep).map((p) => p.takenAt),
  }).doc;
}

// --- D-035 run budget -------------------------------------------------------------------------

/** USD spent by the run so far (agent_steps sum). */
async function runSpentUsd(c: Tick): Promise<number> {
  const v = await c.deps.getRunCostUsd(c.runId);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

const runCapUsd = (c: Tick) => limitsFor(c.book.is_paid === true).maxRunCostUsd;

/** Pessimistic cost of one Caption Writer call over `spec` (full or repair). */
const captionCallEstimate = (spec: CaptionBatchSpec) =>
  estimateCallCostUsd(AI_MODEL, {
    inputTokens: CAPTION_CALL_INPUT_TOKENS(spec.keys.length),
    maxOutputTokens: captionWriterMaxTokens(spec.keys.length),
  });

/** Pessimistic cost of the Critic call over a doc with `pages` pages. */
const criticCallEstimate = (pages: number) =>
  estimateCallCostUsd(AI_MODEL, { inputTokens: CRITIC_CALL_INPUT_TOKENS(pages), maxOutputTokens: criticMaxTokens(pages) });

/** Captions of the cursor in book order (keys of the plan doc). */
function captionsInOrder(c: Tick, pd: PlanDoc): Array<{ key: string; text: string }> {
  return pageCaptionKeys(pd.doc)
    .filter((k): k is string => k !== null && typeof c.cursor.captions[k] === "string")
    .map((k) => ({ key: k, text: c.cursor.captions[k] }));
}

const asIssues = (key: string, codes: readonly string[]): CaptionIssue[] =>
  codes
    .filter((code): code is CaptionIssue["code"] => (CAPTION_ISSUE_CODES as readonly string[]).includes(code))
    .map((code) => ({ code, key }));

/** Records one Caption Writer answer for `keys` / `momentIds` (missing → removed: null caption). */
function mergeCaptionResult(c: Tick, keys: readonly string[], momentIds: readonly string[], r: WriteCaptionsResult): void {
  for (const k of keys) {
    const text = r.captions.get(k);
    if (text) c.cursor.captions[k] = text;
    else delete c.cursor.captions[k];
  }
  for (const m of momentIds) {
    const h = r.headings.get(m);
    if (h) c.cursor.headings[m] = h;
    else delete c.cursor.headings[m];
  }
}

/** captioning: plan the batches once, then waves of Caption Writer calls (D-029). */
async function captioningStep(c: Tick): Promise<StepOutcome> {
  if (c.cursor.captionsDone) {
    c.state = "critiquing";
    await save(c);
    return "next";
  }
  const pd = planDocOf(c);
  if (!pd) {
    // Rule album (Storyteller failed / gave up): no captions in M4 (D-031).
    const reason = c.cursor.album?.kind === "ai" ? "plan_unusable" : "rule_album";
    if (reason !== "rule_album") pushFailure(c.cursor, "captions_plan_unusable");
    await skippedStep(c, "caption_writer", reason);
    await skipCaptions(c);
    return "next";
  }
  const refs = pd.specs.map(refOf);
  if (c.cursor.captionBatches === null) {
    c.cursor.captionBatches = refs;
    c.cursor.captionAttempts = refs.map(() => 0);
    await save(c);
  } else if (!sameRefs(c.cursor.captionBatches, refs)) {
    // Cannot happen with an unchanged plan; never mix keys of two different batchings.
    c.cursor.captionFailures++;
    pushFailure(c.cursor, "caption_batches_changed");
    await skipCaptions(c);
    return "next";
  }

  const done = new Set(c.cursor.captionBatchesDone);
  const pending = pd.specs.map((s) => s.index).filter((i) => !done.has(i));
  if (pending.length === 0) {
    c.cursor.captionsDone = true;
    c.state = "critiquing";
    await save(c);
    return "next";
  }
  if (pastSoftBudget(c) || !callFits(c, AGENT_TIMEOUT_MS.caption_writer)) return "yield";
  await captionWave(c, pd, pending.slice(0, waveSize(done.size)));
  return "next";
}

async function captionWave(c: Tick, pd: PlanDoc, indices: number[]): Promise<void> {
  const transport = needTransport(c);
  // 1. Reserve one attempt per call (checkpointed before any call) — only for calls that fit the
  //    run budget (D-035); a batch that does not fit stays pending for the next wave.
  const spent = await runSpentUsd(c);
  const cap = runCapUsd(c);
  let planned = 0;
  let overBudget = 0;
  const calls: Array<{ bi: number; attempt: number }> = [];
  for (const bi of indices) {
    const used = c.cursor.captionAttempts[bi] ?? 0;
    if (used >= MAX_CAPTION_ATTEMPTS) {
      // Attempts used up (dead ticks / failures): this batch stays uncaptioned.
      c.cursor.captionBatchesDone.push(bi);
      c.cursor.captionFailures++;
      pushFailure(c.cursor, "caption_writer_attempts");
      continue;
    }
    const est = captionCallEstimate(pd.specs[bi]);
    if (spent + planned + est > cap) {
      overBudget++;
      continue;
    }
    planned += est;
    c.cursor.captionAttempts[bi] = used + 1;
    calls.push({ bi, attempt: used + 1 });
  }
  if (!calls.length && overBudget > 0) {
    // Nothing fits the run budget any more: the remaining batches stay uncaptioned.
    const done = new Set(c.cursor.captionBatchesDone);
    for (const s of pd.specs) if (!done.has(s.index)) c.cursor.captionBatchesDone.push(s.index);
    c.cursor.captionFailures++;
    pushFailureOnce(c.cursor, "run_budget");
    c.cursor.captionsDone = true;
    c.state = "critiquing";
  }
  await save(c);
  if (!calls.length) return;

  // 2. The calls (parallel). Earlier batches' captions guard against repetition.
  const book = captionBook(c);
  const aliasOf = aliasOfMap(c.cursor);
  const results = await Promise.all(
    calls.map(async ({ bi, attempt }) => {
      const spec = pd.specs[bi];
      const own = new Set(spec.keys);
      const otherCaptions = captionsInOrder(c, pd)
        .filter((x) => !own.has(x.key))
        .map((x) => x.text);
      const result = await writeCaptions({
        runId: c.runId,
        stepKey: `caption_writer:${bi}`,
        attempt,
        spec,
        book,
        photosById: pd.photosById,
        aliasOf,
        memory: c.cursor.memory,
        otherCaptions,
        transport,
        logger: c.logger,
        retry: stepRetry(c),
      });
      return { bi, attempt, result };
    }),
  );
  c.heavyDone = true;

  // 3. Record (cursor only; the doc is written at validating).
  for (const { bi, attempt, result } of results.sort((x, y) => x.bi - y.bi)) {
    const spec = pd.specs[bi];
    if (result.ok) {
      mergeCaptionResult(
        c,
        spec.keys,
        spec.moments.filter((m) => m.wantHeading).map((m) => m.momentId),
        result,
      );
      for (const [k, list] of result.issues) {
        const codes = [...new Set(list.map((i) => i.code))];
        if (codes.length) c.cursor.captionIssues[k] = codes;
      }
      c.cursor.captionBatchesDone.push(bi);
      continue;
    }
    const failure = result.failure;
    const retry = failure ? retryableCaptionFailure(failure.code, failure.retryable) : false;
    if (retry && attempt < MAX_CAPTION_ATTEMPTS) continue; // stays pending: next wave
    c.cursor.captionBatchesDone.push(bi);
    c.cursor.captionFailures++;
    pushFailure(c.cursor, `caption_writer_${failure?.code ?? "error"}`);
  }
  await save(c);
}

/** critiquing: captions applied, whole-book pre-check, one Critic call, the repair plan (D-030). */
async function critiquingStep(c: Tick): Promise<StepOutcome> {
  if (c.cursor.critiqueDone) {
    c.state = "repairing";
    await save(c);
    return "next";
  }
  const pd = planDocOf(c);
  if (!pd || !c.cursor.captionsDone) {
    // Rule album, or a run that reached this state before M4 (no caption phase).
    await skipCaptions(c);
    return "next";
  }
  const lang = asCaptionLang(c.book.caption_lang);
  const doc = applyCaptions(pd.doc, new Map(Object.entries(c.cursor.captions)), new Map(Object.entries(c.cursor.headings)), {
    lang,
    ctx: bookCaptionContext(c, pd),
  });

  // Pre-check over the whole book (cross-batch duplicates / openings) + what the batches rejected.
  const precheck = checkBookCaptions(captionsInOrder(c, pd), bookCaptionContext(c, pd));
  for (const [k, codes] of Object.entries(c.cursor.captionIssues)) {
    if (!precheck.has(k)) {
      const list = asIssues(k, codes);
      if (list.length) precheck.set(k, list);
    }
  }

  let critique: Parameters<typeof planRepair>[0] = null;
  let score: number | null = null;
  const attempt = c.cursor.criticAttempts + 1;
  let callCritic = false;
  if (Object.keys(c.cursor.captions).length === 0) {
    // SF6: nothing to judge (no AI caption survived) — no Critic call, not a failure.
    await skippedStep(c, "critic", "no_captions");
  } else if (attempt > MAX_CRITIC_ATTEMPTS) {
    c.cursor.criticFailures++;
    pushFailure(c.cursor, "critic_attempts");
  } else {
    if (pastSoftBudget(c) || !callFits(c, AGENT_TIMEOUT_MS.critic)) return "yield";
    if ((await runSpentUsd(c)) + criticCallEstimate(doc.pages.length) > runCapUsd(c)) {
      // D-035: no Critic over the run budget (captions stay; pre-check targets are still planned).
      c.cursor.criticFailures++;
      pushFailureOnce(c.cursor, "run_budget");
      await skippedStep(c, "critic", "run_budget");
    } else callCritic = true;
  }
  if (callCritic) {
    c.cursor.criticAttempts = attempt;
    await save(c);
    const book = storyBookOf(c.book);
    const result = await critiqueBook({
      runId: c.runId,
      stepKey: "critic",
      attempt,
      doc,
      aliasOf: aliasOfMap(c.cursor),
      photosById: pd.photosById,
      metadata: {
        title: c.book.title,
        places: pd.photos.map((p) => p.place),
        dates: pd.photos.map((p) => p.takenAt),
        knownNames: c.cursor.memory?.knownNames ?? [],
      },
      precheck,
      book: { occasion: book.occasion, tone: book.tone, captionLang: book.captionLang },
      transport: needTransport(c),
      logger: c.logger,
      retry: stepRetry(c),
    });
    c.heavyDone = true;
    if (result.ok) {
      critique = result.data;
      score = result.data.score;
      c.cursor.critique = {
        score: result.data.score,
        issues: result.data.issues.map((i) => ({ type: i.type, pageIndex: i.pageIndex, fix: i.fix })),
      };
    } else {
      // No critique: pre-check failures are still repaired. The run is partial, the book is not
      // (its captions are all there) — SF5.
      c.cursor.criticFailures++;
      pushFailure(c.cursor, `critic_${result.code}`);
    }
  }

  // The repair plan, decided once. planRepair groups by a moment's FIRST batch; a long moment's
  // later pages live in a later batch, so page targets are re-grouped by the batch holding the key.
  const byMoment = batchIndexOfMoment(pd.specs);
  const byKey = batchIndexOfKey(pd.specs);
  const plan = planRepair(critique, precheck, doc, { photos: storyPhotosOf(c.photos), batchIndexOf: byMoment });
  const targets: CursorRepairTarget[] = [];
  for (const list of plan.rewrite.values()) {
    for (const t of list) {
      const m = momentIdOfKey(t.key);
      const batch = t.key.endsWith(":heading") ? (m ? byMoment(m) : undefined) : (byKey(t.key) ?? (m ? byMoment(m) : undefined));
      if (batch === undefined) continue;
      targets.push({ batch, key: t.key, codes: reasonCodes(t.reason) });
    }
  }
  c.cursor.repairTargets = targets;
  c.cursor.coverSwap = plan.coverSwap;
  c.cursor.critiqueDone = true;
  c.state = "repairing";
  await save(c, score === null ? {} : { critic_score: score });
  return "next";
}

/** "pre-check: too_long, unknown_name; critic: caption_mismatch" → ["too_long", "unknown_name", "caption_mismatch"]. */
function reasonCodes(reason: string): string[] {
  return [...new Set(reason.split(/[;,\s]+/).filter((t) => CODE_RE.test(t)))];
}

/** repairing: one targeted Caption Writer call per affected batch, one round only (D-030). */
async function repairingStep(c: Tick): Promise<StepOutcome> {
  if (c.cursor.repairDone) {
    c.state = "validating";
    await save(c);
    return "next";
  }
  const pd = planDocOf(c);
  if (!pd || !c.cursor.critiqueDone) {
    await skipCaptions(c);
    return "next";
  }
  const done = new Set(c.cursor.repairBatchesDone);
  const pending = [...new Set(c.cursor.repairTargets.map((t) => t.batch))]
    .filter((bi) => !done.has(bi) && bi >= 0 && bi < pd.specs.length)
    .sort((a, b) => a - b);
  if (pending.length === 0) {
    finalizeCaptions(c, pd);
    c.cursor.repairDone = true;
    c.state = "validating";
    await save(c);
    return "next";
  }
  if (pastSoftBudget(c) || !callFits(c, AGENT_TIMEOUT_MS.caption_writer)) return "yield";
  await repairWave(c, pd, pending.slice(0, CURATOR_CONCURRENCY));
  return "next";
}

/** Drops a target's caption / heading (still failing → null; the Storyteller title stays). */
function dropTargets(c: Tick, targets: readonly CursorRepairTarget[]): void {
  for (const t of targets) {
    if (t.key.endsWith(":heading")) {
      const m = momentIdOfKey(t.key);
      if (m) delete c.cursor.headings[m];
    } else delete c.cursor.captions[t.key];
  }
}

async function repairWave(c: Tick, pd: PlanDoc, indices: number[]): Promise<void> {
  const transport = needTransport(c);
  const maxRepairs = limitsFor(c.book.is_paid === true).maxCaptionRepairsPerBatch;
  const spent = await runSpentUsd(c);
  const cap = runCapUsd(c);
  let planned = 0;
  const calls: Array<{ bi: number; attempt: number; targets: CursorRepairTarget[] }> = [];
  for (const bi of indices) {
    const targets = c.cursor.repairTargets.filter((t) => t.batch === bi);
    const used = c.cursor.repairAttempts[bi] ?? 0;
    if (used >= maxRepairs) {
      // The repair for this batch was already spent (e.g. lost in a dead tick): never a second one.
      dropTargets(c, targets);
      c.cursor.repairBatchesDone.push(bi);
      continue;
    }
    const est = captionCallEstimate(pd.specs[bi]);
    if (spent + planned + est > cap) {
      // D-035: over the run budget — this batch's flagged captions become null (no repair call).
      dropTargets(c, targets);
      c.cursor.repairBatchesDone.push(bi);
      c.cursor.captionFailures++;
      pushFailureOnce(c.cursor, "run_budget");
      continue;
    }
    planned += est;
    c.cursor.repairAttempts[bi] = used + 1;
    calls.push({ bi, attempt: used + 1, targets });
  }
  await save(c);
  if (!calls.length) return;

  const book = captionBook(c);
  const aliasOf = aliasOfMap(c.cursor);
  const allTargets = new Set(c.cursor.repairTargets.map((t) => t.key));
  const otherCaptions = captionsInOrder(c, pd)
    .filter((x) => !allTargets.has(x.key))
    .map((x) => x.text);
  const results = await Promise.all(
    calls.map(async ({ bi, attempt, targets }) => ({
      bi,
      targets,
      result: await writeCaptions({
        runId: c.runId,
        stepKey: `caption_writer:repair:${bi}`,
        attempt,
        spec: pd.specs[bi],
        book,
        photosById: pd.photosById,
        aliasOf,
        memory: c.cursor.memory,
        otherCaptions,
        repairTargets: targets.map((t) => ({ key: t.key, reason: t.codes })),
        transport,
        logger: c.logger,
        retry: stepRetry(c),
      }),
    })),
  );
  c.heavyDone = true;

  for (const { bi, targets, result } of results.sort((x, y) => x.bi - y.bi)) {
    if (result.ok) {
      // Answers already passed the pre-check (writeCaptions → precheckBatch); others → null.
      const pageKeys = targets.filter((t) => !t.key.endsWith(":heading")).map((t) => t.key);
      const momentIds = targets
        .filter((t) => t.key.endsWith(":heading"))
        .map((t) => momentIdOfKey(t.key))
        .filter((m): m is string => m !== null);
      mergeCaptionResult(c, pageKeys, momentIds, result);
    } else {
      dropTargets(c, targets);
      c.cursor.captionFailures++;
      pushFailure(c.cursor, `caption_repair_${result.failure?.code ?? "error"}`);
    }
    c.cursor.repairBatchesDone.push(bi);
  }
  await save(c);
}

/** Last code check over the whole book after the repair round: anything still failing → null. */
function finalizeCaptions(c: Tick, pd: PlanDoc): void {
  const issues = checkBookCaptions(captionsInOrder(c, pd), bookCaptionContext(c, pd));
  for (const k of issues.keys()) delete c.cursor.captions[k];
}

/**
 * Captions/headings of the plan doc mapped onto `target` (the doc actually saved, pruned when
 * photos were removed mid-run): a caption follows its page only when the page kept the same
 * layout and photos; a heading follows its moment (found via the moment's first photo).
 */
function captionsForDoc(c: Tick, pd: PlanDoc, target: BookDoc): { captions: Map<string, string>; headings: Map<string, string> } {
  const sig = (p: BookDoc["pages"][number]) => `${p.layout}|${p.slots.map((s) => s.photoId ?? "").join(",")}`;
  const baseKeys = pageCaptionKeys(pd.doc);
  const keyBySig = new Map<string, string>();
  const momentOfPhoto = new Map<string, string>();
  pd.doc.pages.forEach((p, i) => {
    const k = baseKeys[i];
    if (!k) return;
    keyBySig.set(sig(p), k);
    const m = momentIdOfKey(k);
    if (m) for (const s of p.slots) if (s.photoId) momentOfPhoto.set(s.photoId, m);
  });
  const captions = new Map<string, string>();
  const headings = new Map<string, string>();
  const targetKeys = pageCaptionKeys(target);
  target.pages.forEach((p, i) => {
    const tk = targetKeys[i];
    if (!tk) return;
    const bk = keyBySig.get(sig(p));
    const text = bk ? c.cursor.captions[bk] : undefined;
    if (text) captions.set(tk, text);
    const tm = momentIdOfKey(tk);
    if (tm && !headings.has(tm) && tk === `${tm}:0`) {
      const first = p.slots.find((s) => s.photoId)?.photoId;
      const bm = first ? momentOfPhoto.get(first) : undefined;
      const h = bm ? c.cursor.headings[bm] : undefined;
      if (h) headings.set(tm, h);
    }
  });
  return { captions, headings };
}

/** The AI doc to save with captions, headings and the cover swap (each only if the doc stays valid). */
function withCaptions(c: Tick, target: BookDoc): BookDoc {
  const pd = planDocOf(c);
  if (!pd) return target;
  const { captions, headings } = captionsForDoc(c, pd, target);
  let doc = target;
  if (captions.size || headings.size) {
    // applyCaptions never touches a source 'user' caption (D-031) — defensive: AI docs have none.
    const next = applyCaptions(target, captions, headings, {
      lang: asCaptionLang(c.book.caption_lang),
      ctx: bookCaptionContext(c, pd),
    });
    if (docIssues(next, c.photos, c.book).length === 0) doc = next;
  }
  const swap = c.cursor.coverSwap;
  if (swap && swap !== doc.cover.photoId && c.photos.some((p) => p.id === swap && p.status === "kept")) {
    const next = { ...doc, cover: { ...doc.cover, photoId: swap } };
    if (docIssues(next, c.photos, c.book).length === 0) doc = next;
  }
  return doc;
}

/**
 * Run ai_status. `forBook` = the books.ai_status view (SF5): Critic-only failures (refusal, error,
 * budget skip) do not make the BOOK partial — its album and captions are complete.
 */
export function computeAiStatus(
  cursor: Pick<RunCursor, "aiFailures" | "captionFailures" | "criticFailures" | "batchesAi">,
  aiPlanUsed: boolean,
  forBook = false,
): RunAiStatus {
  const criticOk = forBook || cursor.criticFailures === 0;
  if (aiPlanUsed && cursor.aiFailures === 0 && cursor.captionFailures === 0 && criticOk) return "ok";
  if (aiPlanUsed || cursor.batchesAi > 0) return "partial";
  return "failed";
}

/** Ends the run without further model calls: rule curation for the rest + the rule album. */
async function finishWithRuleAlbum(c: Tick, reason: "mode_changed"): Promise<AdvanceResult> {
  await finishCuration(c);
  c.cursor.album = { kind: "rule", reason };
  c.cursor.issues = [];
  c.state = "validating";
  await save(c);
  return validateAndSave(c);
}

async function validateAndSave(c: Tick): Promise<AdvanceResult> {
  let doc: BookDoc | null = null;
  let aiPlanUsed = false;
  const album = c.cursor.album;
  if (album?.kind === "ai" && album.plan) {
    const photos = storyPhotosOf(c.photos);
    const aliasToId = aliasToIdMap(c.cursor);
    // Photos the user removed while the run was going leave the plan; the rest of it is kept.
    const pruned = prunePlan(album.plan, { aliasToId, photos, design: bookDesignOf(c.book) });
    const out = planToDoc(pruned.plan, {
      aliasToId,
      photos,
      book: storyBookOf(c.book),
      runId: c.runId,
      generatorVersion: STORYTELLER_PROMPT_VERSION,
      design: bookDesignOf(c.book),
    });
    if ("doc" in out && docIssues(out.doc, c.photos, c.book).length === 0) {
      // SF3: Storyteller titles / subtitle that fail the pre-check become neutral, then captions.
      doc = withCaptions(c, groundedDoc(c, out.doc, photos));
      aiPlanUsed = true;
    } else {
      pushFailure(c.cursor, "plan_stale");
    }
  } else if (album?.kind === "ai") {
    pushFailure(c.cursor, "plan_missing");
  }
  if (!doc) {
    doc = ruleDoc(c.photos, c.book, c.runId);
    if (docIssues(doc, c.photos, c.book).length) throw new OrchestratorError("rule_album_invalid");
  }

  await save(c); // lease check right before the doc write
  const fresh = await c.deps.getBookForRun(c.book.id);
  const w: WriteDocResult = fresh
    ? await c.deps.writeDocIfReplaceable(c.book.id, docJson(doc), doc.pages.length, { updatedAt: fresh.updated_at })
    : { ok: false, reason: "not_found" };

  if (!w.ok && w.reason === "conflict" && c.cursor.writeConflicts < MAX_WRITE_CONFLICTS) {
    c.cursor.writeConflicts++;
    await save(c);
    return yieldTick(c); // reload + retry on the next tick
  }

  const progress = progressOf(c.cursor, "done");
  if (!w.ok) {
    // The previous doc stays → so does the book's previous ai_status (the run keeps the code).
    const state: RunState = w.reason === "not_found" ? "failed" : "done";
    const errorCode = w.reason === "conflict" ? "write_conflict" : w.reason;
    return finishRun(c.deps, c.runId, c.token, w.reason === "not_found" ? null : c.book.id, c.cursor, {
      state,
      aiStatus: "failed",
      errorCode,
      progress: { ...progress, phase: state },
      bookStatus: c.cursor.prevBookStatus,
    });
  }
  const aiStatus = computeAiStatus(c.cursor, aiPlanUsed);
  const forced = album?.kind === "rule" && album.reason === "mode_changed" ? "mode_changed" : null;
  const errorCode = forced ?? (aiStatus === "ok" ? null : runErrorCode(c.cursor));
  return finishRun(c.deps, c.runId, c.token, c.book.id, c.cursor, {
    state: "done",
    aiStatus,
    errorCode,
    progress,
    bookStatus: bookStatusOf(computeAiStatus(c.cursor, aiPlanUsed, true)),
  });
}

async function finishRun(
  deps: OrchestratorDeps,
  runId: string,
  token: string,
  bookId: string | null,
  cursor: RunCursor | null,
  out: {
    state: RunState;
    aiStatus: RunAiStatus;
    errorCode: string | null;
    progress: RunProgress;
    /** books.ai_status to set (null = leave as is). */
    bookStatus: BookAiStatus | null;
  },
): Promise<AdvanceResult> {
  // AI text (plan titles, captions, headings, critique) and the memory snapshot leave the cursor
  // once the run is over (privacy).
  const finalCursor = cursor ? stripCursorText(cursor) : undefined;
  if (bookId && out.bookStatus) await deps.setBookAiStatus(bookId, out.bookStatus);
  const ok = await deps.checkpointRun(runId, token, {
    state: out.state,
    ai_status: out.aiStatus,
    error_code: out.errorCode,
    progress: toJson(out.progress),
    ...(finalCursor ? { cursor: toJson(finalCursor) } : {}),
    finished_at: new Date(deps.now()).toISOString(),
  });
  if (!ok) throw new StaleLeaseError();
  return { state: out.state, progress: out.progress, done: true, aiStatus: out.aiStatus, errorCode: out.errorCode };
}

/**
 * Unexpected exception: never block the user. Mark the run failed (with our lease — a stale tick
 * stops here), then, if the book has no album yet, write the rule album. The book shows 'failed'
 * only when it has no other album; a kept previous doc keeps its previous ai_status. Every step
 * after the checkpoint is best effort.
 */
async function crash(
  deps: OrchestratorDeps,
  run: RunForTick,
  token: string,
  ctx: Tick | null,
  code: string,
): Promise<AdvanceResult> {
  const progress = { ...(ctx ? progressOf(ctx.cursor, "failed") : parseProgress(run.progress, "failed")), phase: "failed" as const };
  const cursor = ctx?.cursor;
  const saved = await deps
    .checkpointRun(run.id, token, {
      state: "failed",
      ai_status: "failed",
      error_code: code,
      progress: toJson(progress),
      ...(cursor ? { cursor: toJson(stripCursorText(cursor, null)) } : {}),
      finished_at: new Date(deps.now()).toISOString(),
    })
    .catch(() => null);
  if (saved === false) return { leased: true };

  const bookId = run.book_id;
  if (bookId) {
    let status: BookAiStatus = "failed";
    try {
      const book = await deps.getBookForRun(bookId);
      if (book && isEmptyDoc(book.doc)) {
        const photos = (await deps.listPhotosForCuration(bookId)).map(toCurationPhoto);
        const doc = ruleDoc(photos, book, run.id);
        if (docIssues(doc, photos, book).length === 0) {
          await deps.writeDocIfReplaceable(bookId, docJson(doc), doc.pages.length, { updatedAt: book.updated_at });
        }
      } else if (book) {
        status = cursor ? cursor.prevBookStatus : restorableStatus(book.ai_status);
      }
    } catch {
      // best effort
    }
    await deps.setBookAiStatus(bookId, status).catch(() => undefined);
  }
  return { state: "failed", progress, done: true, aiStatus: "failed", errorCode: code };
}

// ---------------------------------------------------------------------------------------------
// getProgress

/** Owner-scoped (RLS) progress for GET /api/ai/runs/[id]; null when missing or not the owner's. */
export async function getProgress(runId: string, deps: Pick<OrchestratorDeps, "getRunForOwner"> = defaultDeps()): Promise<ProgressView | null> {
  const run = await deps.getRunForOwner(runId);
  // Rewrite runs are not build progress (M5 review B1) → null → 404.
  if (!run || !agentRunsDb.isBuildRunTrigger(run.trigger)) return null;
  const state = run.state as RunState;
  return {
    state,
    progress: parseProgress(run.progress, state),
    aiStatus: (run.ai_status as RunAiStatus | null) ?? null,
    errorCode: run.error_code ?? null,
    mode: run.mode as RunMode,
    done: isFinished(state),
  };
}
