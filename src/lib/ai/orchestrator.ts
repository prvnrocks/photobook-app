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
// its checkpoint) is marked done without a call. Re-logged steps (same step_key + attempt) are
// ignored by the step logger.
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
import { isEmptyDoc, isReplaceableDoc } from "@/lib/book/replaceable";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import * as agentRunsDb from "@/lib/db/agent-runs";
import type {
  CreateRunInput,
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
import { AI_MODEL, CURATOR_CONCURRENCY, resolveAiMode, type AiMode } from "./client";
import {
  ensureAtLeastOneKept,
  isDropReason,
  ruleCurate,
  type CurationPhoto,
  type DropReason,
} from "./fallback";
import { limitsFor } from "./limits";
import { planToDoc } from "./plan-to-doc";
import { STORYTELLER_PROMPT_VERSION } from "./prompts/storyteller";
import type { StepErrorCode, StepLogger } from "./run-step";
import { AlbumPlanStrictSchema, MOODS, SCENES, type AlbumPlan } from "./schemas";
import type { StoryAnalysis, StoryBook, StoryPhoto } from "./story";
import { getTransport } from "./transport-factory";
import type { AgentName, AgentTransport } from "./transport";

// ---------------------------------------------------------------------------------------------
// Tunables (tick timing — see the HANDOFF in .agentos/runs/m3.md)

/** DB lease per tick (claim_agent_run). Must exceed budget + one in-flight call (AI_TIMEOUT_MS). */
export const LEASE_SECONDS = 90;
/** Default work budget of one advance() call (route maxDuration should be ≥ 60 s). */
export const DEFAULT_TICK_BUDGET_MS = 40_000;
/** No new Curator wave starts after this fraction of the budget (a wave can take ~AI_TIMEOUT). */
export const CURATOR_WAVE_CUTOFF = 0.5;
/** The Storyteller (one long call) starts only before this fraction, unless nothing ran yet. */
export const STORYTELLER_START_CUTOFF = 0.25;
/** Storyteller attempts per run (attempt 2 gets the validation issues of attempt 1). */
export const MAX_STORY_ATTEMPTS = 2;
/** Optimistic-lock conflicts tolerated when saving the doc (each retried on the next tick). */
export const MAX_WRITE_CONFLICTS = 1;
export const CURSOR_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
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
  createRun(input: CreateRunInput): Promise<{ id: string } | { error: "already_running" }>;
  claimRun(runId: string, leaseSeconds: number): Promise<boolean>;
  releaseRun(runId: string): Promise<void>;
  checkpointRun(runId: string, patch: RunCheckpointPatch): Promise<void>;
  getRunForTick(runId: string): Promise<RunForTick | null>;
  getRunForOwner(runId: string): Promise<OwnerRun | null>;
  countLiveRuns(input: { userId: string; since: string; triggers?: RunTrigger[] }): Promise<number>;
  countLiveRebuilds(bookId: string): Promise<number>;
  stepLogger(runId: string): StepLogger;
  // AI
  resolveMode(): AiMode;
  transportFor(mode: "live" | "replay"): AgentTransport | null;
  // clock (ms since epoch)
  now(): number;
}

export function defaultDeps(): OrchestratorDeps {
  return {
    getBookForRun: booksDb.getBookForRun,
    setBookAiStatus: booksDb.setBookAiStatus,
    writeDocIfReplaceable: booksDb.writeDocIfReplaceable,
    listPhotosForCuration: photosDb.listPhotosForCuration,
    writeCuration: photosDb.writeCuration,
    loadThumbBase64: photosDb.loadThumbBase64,
    createRun: agentRunsDb.createRun,
    claimRun: agentRunsDb.claimRun,
    releaseRun: agentRunsDb.releaseRun,
    checkpointRun: agentRunsDb.checkpointRun,
    getRunForTick: agentRunsDb.getRunForTick,
    getRunForOwner: agentRunsDb.getRunForOwner,
    countLiveRuns: agentRunsDb.countLiveRuns,
    countLiveRebuilds: agentRunsDb.countLiveRebuilds,
    stepLogger: agentRunsDb.stepLogger,
    resolveMode: () => resolveAiMode(),
    transportFor: (mode) => getTransport(mode),
    now: () => Date.now(),
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
  /** Batches answered by the model (usedAi). */
  batchesAi: number;
  /** Batches that fell back to rule decisions (refusal / error / no loadable thumbs). */
  aiFailures: number;
  photosCapped: number;
  curationDone: boolean;
  /** Storyteller attempts made (0..MAX_STORY_ATTEMPTS). */
  storyAttempt: number;
  /** Validation issues of the last Storyteller attempt (no user text). */
  issues: string[];
  album: AlbumChoice | null;
  /** Failure codes in order, e.g. "curator_refusal" (codes only). */
  failures: string[];
  writeConflicts: number;
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
    batchesAi: num("batchesAi"),
    aiFailures: num("aiFailures"),
    photosCapped: num("photosCapped"),
    curationDone: c.curationDone === true,
    storyAttempt: num("storyAttempt"),
    issues: isStrArr(c.issues) ? c.issues : [],
    album,
    failures: isStrArr(c.failures) ? c.failures : [],
    writeConflicts: num("writeConflicts"),
  };
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
export function initialCursor(photos: CurationPhoto[], maxAnalyzedPhotos: number): RunCursor {
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
    batchesAi: 0,
    aiFailures: 0,
    photosCapped: candidates.length - selected.length,
    curationDone: false,
    storyAttempt: 0,
    issues: [],
    album: null,
    failures: [],
    writeConflicts: 0,
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
  if (!isReplaceableDoc(book.doc)) return { ok: false, error: "user_edited" };

  const aiMode = deps.resolveMode();
  const transport = aiMode === "off" ? null : deps.transportFor(aiMode);
  if (aiMode === "off" || !transport) return startRuleRun(input, book, deps);

  // Limits BEFORE creating the run (CLAUDE.md: enforce limits before calling). Only live runs count.
  const limits = limitsFor(book.is_paid === true);
  const since = new Date(deps.now() - DAY_MS).toISOString();
  if ((await deps.countLiveRuns({ userId: input.userId, since })) >= limits.maxLiveBuildsPerUserPerDay) {
    return { ok: false, error: "limit", limit: "daily_builds" };
  }
  if (input.trigger === "rebuild" && (await deps.countLiveRebuilds(book.id)) >= limits.maxRebuilds) {
    return { ok: false, error: "limit", limit: "rebuilds" };
  }

  const photos = (await deps.listPhotosForCuration(book.id)).map(toCurationPhoto);
  const created = await deps.createRun({ bookId: book.id, userId: input.userId, trigger: input.trigger, mode: aiMode });
  if ("error" in created) return { ok: false, error: "already_running" };

  const cursor = initialCursor(photos, limits.maxAnalyzedPhotos);
  await deps.checkpointRun(created.id, {
    state: "queued",
    cursor: toJson(cursor),
    progress: toJson(progressOf(cursor, "queued")),
  });
  return { ok: true, runId: created.id, mode: aiMode, state: "queued" };
}

/** AI off (D-024): rule curation + rule album, synchronously. The run is logged with mode 'rule'. */
async function startRuleRun(input: StartInput, book: BookForRun, deps: OrchestratorDeps): Promise<StartResult> {
  const created = await deps.createRun({ bookId: book.id, userId: input.userId, trigger: input.trigger, mode: "rule" });
  if ("error" in created) return { ok: false, error: "already_running" };
  const runId = created.id;
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
    await deps.setBookAiStatus(book.id, "idle");
    await deps.checkpointRun(runId, {
      state: "done",
      ai_status: null,
      error_code: errorCode,
      progress: toJson(progress),
      finished_at: new Date(deps.now()).toISOString(),
    });
    return { ok: true, runId, mode: "rule", state: "done" };
  } catch (e) {
    await deps
      .checkpointRun(runId, {
        state: "failed",
        ai_status: null,
        error_code: errorCodeOf(e),
        progress: toJson(emptyProgress("failed")),
        finished_at: new Date(deps.now()).toISOString(),
      })
      .catch(() => undefined);
    return { ok: true, runId, mode: "rule", state: "failed" };
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
  const claimed = await deps.claimRun(runId, LEASE_SECONDS);
  if (!claimed) {
    // Lease held by another tick — or the run is finished / missing (claim refuses those too).
    const run = await deps.getRunForTick(runId);
    if (!run) return { notFound: true };
    if (isFinished(run.state)) return finishedResult(run);
    return { leased: true };
  }
  try {
    return await tick(runId, budgetMs, deps);
  } finally {
    await deps.releaseRun(runId).catch(() => undefined);
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

interface Tick {
  deps: OrchestratorDeps;
  runId: string;
  run: RunForTick;
  book: BookForRun;
  photos: CurationPhoto[];
  cursor: RunCursor;
  state: RunState;
  transport: AgentTransport;
  logger: StepLogger;
  t0: number;
  budgetMs: number;
  /** A model call (wave / Storyteller) already ran in this tick. */
  heavyDone: boolean;
}

async function tick(runId: string, budgetMs: number, deps: OrchestratorDeps): Promise<AdvanceResult> {
  const t0 = deps.now();
  const run = await deps.getRunForTick(runId);
  if (!run) return { notFound: true };
  if (isFinished(run.state)) return finishedResult(run);

  let ctx: Tick | null = null;
  try {
    const book = run.book_id ? await deps.getBookForRun(run.book_id) : null;
    if (!book || book.user_id !== run.user_id) {
      return await finishRun(deps, runId, null, null, {
        state: "failed",
        aiStatus: "failed",
        errorCode: "not_found",
        progress: { ...parseProgress(run.progress, "failed"), phase: "failed" },
      });
    }
    const cursor = parseCursor(run.cursor);
    if (!cursor) throw new OrchestratorError("bad_cursor");
    if (run.mode !== "live" && run.mode !== "replay") throw new OrchestratorError("bad_mode");
    const transport = deps.transportFor(run.mode);
    if (!transport) throw new OrchestratorError("ai_unavailable");

    const photos = (await deps.listPhotosForCuration(book.id)).map(toCurationPhoto);
    extendAliases(cursor, photos);
    ctx = {
      deps,
      runId,
      run,
      book,
      photos,
      cursor,
      state: run.state as RunState,
      transport,
      logger: deps.stepLogger(runId),
      t0,
      budgetMs,
      heavyDone: false,
    };
    return await loop(ctx);
  } catch (e) {
    return crash(deps, run, ctx, errorCodeOf(e));
  }
}

const elapsed = (c: Tick) => c.deps.now() - c.t0;

async function save(c: Tick, extra: RunCheckpointPatch = {}): Promise<void> {
  await c.deps.checkpointRun(c.runId, {
    state: c.state,
    cursor: toJson(c.cursor),
    progress: toJson(progressOf(c.cursor, c.state)),
    ...extra,
  });
}

function yieldTick(c: Tick): AdvanceResult {
  return { state: c.state, progress: progressOf(c.cursor, c.state), done: false, aiStatus: null, errorCode: null };
}

async function loop(c: Tick): Promise<AdvanceResult> {
  for (;;) {
    switch (c.state) {
      case "queued":
        c.state = "curating";
        await c.deps.setBookAiStatus(c.book.id, "analyzing");
        await save(c);
        continue;

      case "curating": {
        const done = new Set(c.cursor.batchesDone);
        const pending = c.cursor.batches.map((_, i) => i).filter((i) => !done.has(i));
        if (pending.length) {
          if (c.heavyDone && elapsed(c) > c.budgetMs * CURATOR_WAVE_CUTOFF) return yieldTick(c);
          await curatorWave(c, pending.slice(0, CURATOR_CONCURRENCY));
          continue;
        }
        await finishCuration(c);
        c.state = "storytelling";
        await c.deps.setBookAiStatus(c.book.id, "planning");
        await save(c);
        continue;
      }

      case "storytelling":
        if (c.heavyDone && elapsed(c) > c.budgetMs * STORYTELLER_START_CUTOFF) return yieldTick(c);
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

async function curatorWave(c: Tick, indices: number[]): Promise<void> {
  const byId = new Map(c.photos.map((p) => [p.id, p]));
  const aliasOf = aliasOfMap(c.cursor);
  const occasion = asOccasion(c.book.occasion);

  const outcomes = await Promise.all(
    indices.map(async (bi) => {
      const batch = c.cursor.batches[bi]
        .map((n) => byId.get(c.cursor.aliasIds[n - 1]))
        .filter((p): p is CurationPhoto => p !== undefined);
      // Photos gone, or notes already written by a tick that died before its checkpoint.
      if (batch.length === 0 || batch.every((p) => !needsCuration(p))) return { bi, result: null };
      const result = await curateBatch({
        runId: c.runId,
        stepKey: `curator:${bi}`,
        attempt: 1,
        batch,
        occasion,
        aliasOf,
        transport: c.transport,
        logger: c.logger,
        deps: { loadThumbs: c.deps.loadThumbBase64 },
        retry: { retries: 0 },
      });
      return { bi, result };
    }),
  );
  c.heavyDone = true;

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

  for (const { bi, result } of outcomes) {
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

/** Book-level: rule-curate leftovers (over the cap / added later), then guarantee ≥ 1 kept. */
async function finishCuration(c: Tick): Promise<void> {
  if (c.cursor.curationDone) return;
  const batched = new Set(c.cursor.batches.flat().map((n) => c.cursor.aliasIds[n - 1]));
  const leftovers = c.photos.filter((p) => needsCuration(p) && !batched.has(p.id));
  const rows = ruleCurationRows(c.photos, leftovers);
  if (rows.length) {
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
    c.cursor.album = c.cursor.album ?? { kind: "rule", reason: "storyteller_attempts" };
    c.state = "captioning";
    await save(c);
    return;
  }
  const photos = storyPhotosOf(c.photos);
  const book = storyBookOf(c.book);
  const result = await planAlbum({
    runId: c.runId,
    stepKey: "storyteller",
    attempt,
    photos,
    book,
    aliasOf: aliasOfMap(c.cursor),
    transport: c.transport,
    logger: c.logger,
    previousIssues: c.cursor.issues.length ? c.cursor.issues : undefined,
    retry: { retries: 0 },
  });
  c.heavyDone = true;
  c.cursor.storyAttempt = attempt;

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
      await save(c); // stay in storytelling; attempt 2 runs now or on the next tick
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

async function validateAndSave(c: Tick): Promise<AdvanceResult> {
  let doc: BookDoc | null = null;
  let aiPlanUsed = false;
  const album = c.cursor.album;
  if (album?.kind === "ai" && album.plan) {
    const out = planToDoc(album.plan, {
      aliasToId: aliasToIdMap(c.cursor),
      photos: storyPhotosOf(c.photos),
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
    const state: RunState = w.reason === "not_found" ? "failed" : "done";
    const errorCode = w.reason === "conflict" ? "write_conflict" : w.reason;
    return finishRun(c.deps, c.runId, w.reason === "not_found" ? null : c.book.id, c.cursor, {
      state,
      aiStatus: "failed",
      errorCode,
      progress: { ...progress, phase: state },
    });
  }
  const aiStatus = computeAiStatus(c.cursor, aiPlanUsed);
  const errorCode = aiStatus === "ok" ? null : (c.cursor.failures[0] ?? null);
  return finishRun(c.deps, c.runId, c.book.id, c.cursor, { state: "done", aiStatus, errorCode, progress });
}

async function finishRun(
  deps: OrchestratorDeps,
  runId: string,
  bookId: string | null,
  cursor: RunCursor | null,
  out: { state: RunState; aiStatus: RunAiStatus; errorCode: string | null; progress: RunProgress },
): Promise<AdvanceResult> {
  // The AI plan (titles) is dropped from the cursor once the run is over (privacy).
  const finalCursor = cursor
    ? { ...cursor, album: cursor.album?.kind === "ai" ? { kind: "ai" as const } : cursor.album }
    : undefined;
  if (bookId) await deps.setBookAiStatus(bookId, bookStatusOf(out.aiStatus));
  await deps.checkpointRun(runId, {
    state: out.state,
    ai_status: out.aiStatus,
    error_code: out.errorCode,
    progress: toJson(out.progress),
    ...(finalCursor ? { cursor: toJson(finalCursor) } : {}),
    finished_at: new Date(deps.now()).toISOString(),
  });
  return { state: out.state, progress: out.progress, done: true, aiStatus: out.aiStatus, errorCode: out.errorCode };
}

/**
 * Unexpected exception: never block the user. If the book has no album yet, write the rule
 * album; then mark the run failed. Every step is best effort.
 */
async function crash(deps: OrchestratorDeps, run: RunForTick, ctx: Tick | null, code: string): Promise<AdvanceResult> {
  const progress = { ...(ctx ? progressOf(ctx.cursor, "failed") : parseProgress(run.progress, "failed")), phase: "failed" as const };
  const bookId = run.book_id;
  if (bookId) {
    try {
      const book = await deps.getBookForRun(bookId);
      if (book && isEmptyDoc(book.doc)) {
        const photos = (await deps.listPhotosForCuration(bookId)).map(toCurationPhoto);
        const doc = ruleDoc(photos, book, run.id);
        if (docIssues(doc, photos, book).length === 0) {
          await deps.writeDocIfReplaceable(bookId, toJson(doc), doc.pages.length, { updatedAt: book.updated_at });
        }
      }
    } catch {
      // best effort
    }
    await deps.setBookAiStatus(bookId, "failed").catch(() => undefined);
  }
  const cursor = ctx?.cursor;
  await deps
    .checkpointRun(run.id, {
      state: "failed",
      ai_status: "failed",
      error_code: code,
      progress: toJson(progress),
      ...(cursor ? { cursor: toJson({ ...cursor, album: null }) } : {}),
      finished_at: new Date(deps.now()).toISOString(),
    })
    .catch(() => undefined);
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
