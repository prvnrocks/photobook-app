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
// States: queued → curating → storytelling → captioning → critiquing → validating → done
//         (captioning / critiquing are M4: they only log a `skipped` step today)
//         any unexpected exception → failed (the rule album is written if the book had no doc).
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
// Privacy (D-027): nothing here logs. Error codes are short code strings; cursor / progress hold
// ids, counts and codes only — except `cursor.album.plan` (AI titles) between storytelling and
// validating, which is removed when the run finishes.

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
import type { BookAiStatus, BookForRun, WriteDocResult } from "@/lib/db/books";
import * as photosDb from "@/lib/db/photos";
import type { CurationPhotoRow, CurationWrite } from "@/lib/db/photos";
import type { Json } from "@/lib/supabase/database.types";
import { curateBatch, needsCuration, CURATOR_PROMPT_VERSION } from "./agents/curator";
import { MAX_RETRY_ISSUES, planAlbum } from "./agents/storyteller";
import { buildBatches } from "./batches";
import { AGENT_TIMEOUT_MS, AI_MODEL, CURATOR_CONCURRENCY, resolveAiMode, type AiMode } from "./client";
import {
  ensureAtLeastOneKept,
  isDropReason,
  ruleCurate,
  type CurationPhoto,
  type DropReason,
} from "./fallback";
import { limitsFor } from "./limits";
import { planToDoc, prunePlan } from "./plan-to-doc";
import { STORYTELLER_PROMPT_VERSION } from "./prompts/storyteller";
import type { RetryOptions, StepErrorCode, StepLogger } from "./run-step";
import { AlbumPlanStrictSchema, MOODS, SCENES, type AlbumPlan } from "./schemas";
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
    createRunCapped: agentRunsDb.createRunCapped,
    claimRun: agentRunsDb.claimRun,
    releaseRun: agentRunsDb.releaseRun,
    checkpointRun: agentRunsDb.checkpointRun,
    getRunForTick: agentRunsDb.getRunForTick,
    getRunForOwner: agentRunsDb.getRunForOwner,
    hasFinishedLiveAiRun: agentRunsDb.hasFinishedLiveAiRun,
    stepLogger: agentRunsDb.stepLogger,
    resolveMode: () => resolveAiMode(),
    transportFor: (mode) => getTransport(mode),
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  };
}

// ---------------------------------------------------------------------------------------------
// Public result shapes

export type StartInput = { bookId: string; userId: string; trigger: "build" | "rebuild" };

export type StartLimit = "daily_builds" | "rebuilds" | "analysed_photos";

export type StartResult =
  | { ok: true; runId: string; mode: RunMode; state: RunState }
  | {
      ok: false;
      error: "not_found" | "already_running" | "user_edited" | "limit";
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
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isIntArr = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n));
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

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
  };
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
  return { phase, photosTotal: 0, photosDone: 0, batchesTotal: 0, batchesDone: 0, photosCapped: 0 };
}

export function parseProgress(raw: unknown, phase: RunState): RunProgress {
  const p = emptyProgress(phase);
  if (!isObj(raw)) return p;
  for (const k of ["photosTotal", "photosDone", "batchesTotal", "batchesDone", "photosCapped"] as const) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) p[k] = v;
  }
  return p;
}

function progressOf(cursor: RunCursor, phase: RunState): RunProgress {
  const done = new Set(cursor.batchesDone);
  return {
    phase,
    photosTotal: cursor.batches.reduce((n, b) => n + b.length, 0),
    photosDone: cursor.batches.reduce((n, b, i) => n + (done.has(i) ? b.length : 0), 0),
    batchesTotal: cursor.batches.length,
    batchesDone: done.size,
    photosCapped: cursor.photosCapped,
  };
}

const toJson = (v: unknown) => v as Json;

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

function ruleDoc(photos: CurationPhoto[], book: BookForRun, runId: string | null): BookDoc {
  return autolayout(photos.map(toAutoPhoto), {
    occasion: asOccasion(book.occasion),
    title: book.title,
    captionLang: asCaptionLang(book.caption_lang),
    isPaid: book.is_paid === true,
    runId,
  });
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
  const code = isObj(e) && typeof e.code === "string" && /^[\w-]{1,32}$/.test(e.code) ? e.code : null;
  return code ? `internal_${code}` : "internal_error";
}

const isFinished = (s: string) => s === "done" || s === "failed";
const bookStatusOf = (s: RunAiStatus): BookAiStatus => (s === "ok" ? "done" : s);

function pushFailure(c: RunCursor, code: string): void {
  if (c.failures.length < MAX_FAILURE_CODES) c.failures.push(code);
}

// ---------------------------------------------------------------------------------------------
// startRun

export async function startRun(input: StartInput, deps: OrchestratorDeps = defaultDeps()): Promise<StartResult> {
  const book = await deps.getBookForRun(input.bookId);
  if (!book || book.user_id !== input.userId) return { ok: false, error: "not_found" };
  if (!isAiReplaceableDoc(book.doc)) return { ok: false, error: "user_edited" }; // D-018 + D-031

  const aiMode = deps.resolveMode();
  const transport = aiMode === "off" ? null : deps.transportFor(aiMode);
  if (aiMode === "off" || !transport) return startRuleRun(input, book, deps);

  // Limits are enforced atomically by createRunCapped BEFORE any model call (live runs only).
  // The route derives the trigger server-side; defensively, a "build" on a book whose album the
  // AI already made (or that already had a finished live AI run) counts as a rebuild.
  const trigger = await effectiveTrigger(input.trigger, book, aiMode, deps);
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
    const w = await deps.writeDocIfReplaceable(book.id, toJson(doc), doc.pages.length, { updatedAt: fresh.updated_at });
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
}

async function tick(runId: string, token: string, t0: number, budgetMs: number, deps: OrchestratorDeps): Promise<AdvanceResult> {
  const run = await deps.getRunForTick(runId);
  if (!run) return { notFound: true };
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
    const photos = (await deps.listPhotosForCuration(book.id)).map(toCurationPhoto);
    let cursor = parseCursor(run.cursor);
    if (!cursor && run.state === "queued" && isBlankCursor(run.cursor)) {
      cursor = initialCursor(photos, limitsFor(book.is_paid === true).maxAnalyzedPhotos, book.ai_status);
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
    };
    if (modeChanged) return await finishWithRuleAlbum(ctx, "mode_changed");
    return await loop(ctx);
  } catch (e) {
    if (e instanceof StaleLeaseError) return { leased: true };
    return crash(deps, run, token, ctx, errorCodeOf(e));
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

/** Checkpoint with our lease token; throws StaleLeaseError when the lease was taken over. */
async function save(c: Tick, extra: RunCheckpointPatch = {}): Promise<void> {
  const ok = await c.deps.checkpointRun(c.runId, c.token, {
    state: c.state,
    cursor: toJson(c.cursor),
    progress: toJson(progressOf(c.cursor, c.state)),
    ...extra,
  });
  if (!ok) throw new StaleLeaseError();
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
    switch (c.state) {
      case "queued":
        c.state = "curating";
        await save(c);
        await c.deps.setBookAiStatus(c.book.id, "analyzing");
        continue;

      case "curating": {
        const done = new Set(c.cursor.batchesDone);
        const pending = c.cursor.batches.map((_, i) => i).filter((i) => !done.has(i));
        if (pending.length) {
          if (c.heavyDone && elapsed(c) > c.budgetMs * CURATOR_WAVE_CUTOFF) return yieldTick(c);
          if (!callFits(c, AGENT_TIMEOUT_MS.curator)) return yieldTick(c);
          await curatorWave(c, pending.slice(0, waveSize(done.size)));
          continue;
        }
        await finishCuration(c);
        c.state = "storytelling";
        await save(c);
        await c.deps.setBookAiStatus(c.book.id, "planning");
        continue;
      }

      case "storytelling":
        // The Storyteller is one long request: it runs alone, at the start of its own tick.
        if (c.heavyDone || !callFits(c, AGENT_TIMEOUT_MS.storyteller)) return yieldTick(c);
        await storytellerStep(c);
        continue;

      case "captioning":
        await skippedStep(c, "caption_writer");
        c.state = "critiquing";
        await save(c);
        continue;

      case "critiquing":
      case "repairing":
        await skippedStep(c, "critic");
        c.state = "validating";
        await save(c);
        continue;

      case "validating":
        return validateAndSave(c);

      default:
        throw new OrchestratorError("bad_state");
    }
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
        deps: { loadThumbs: c.deps.loadThumbBase64 },
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

/** M4 placeholder: one `skipped` agent_steps row, no model call (idempotent on resume). */
async function skippedStep(c: Tick, agent: AgentName): Promise<void> {
  await c.logger.insertStep({
    runId: c.runId,
    agent,
    stepKey: agent,
    attempt: 1,
    retries: 0,
    status: "skipped",
    inputSummary: { reason: "not_implemented_m4" },
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

function computeAiStatus(cursor: RunCursor, aiPlanUsed: boolean): RunAiStatus {
  if (aiPlanUsed && cursor.aiFailures === 0) return "ok";
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
    const pruned = prunePlan(album.plan, { aliasToId, photos });
    const out = planToDoc(pruned.plan, {
      aliasToId,
      photos,
      book: storyBookOf(c.book),
      runId: c.runId,
      generatorVersion: STORYTELLER_PROMPT_VERSION,
    });
    if ("doc" in out && docIssues(out.doc, c.photos, c.book).length === 0) {
      doc = out.doc;
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
    ? await c.deps.writeDocIfReplaceable(c.book.id, toJson(doc), doc.pages.length, { updatedAt: fresh.updated_at })
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
  const errorCode = forced ?? (aiStatus === "ok" ? null : (c.cursor.failures[0] ?? null));
  return finishRun(c.deps, c.runId, c.token, c.book.id, c.cursor, {
    state: "done",
    aiStatus,
    errorCode,
    progress,
    bookStatus: bookStatusOf(aiStatus),
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
  // The AI plan (titles) is dropped from the cursor once the run is over (privacy).
  const finalCursor = cursor
    ? { ...cursor, album: cursor.album?.kind === "ai" ? { kind: "ai" as const } : cursor.album }
    : undefined;
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
      ...(cursor ? { cursor: toJson({ ...cursor, album: null }) } : {}),
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
          await deps.writeDocIfReplaceable(bookId, toJson(doc), doc.pages.length, { updatedAt: book.updated_at });
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
  if (!run) return null;
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
