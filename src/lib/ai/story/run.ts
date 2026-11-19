import "server-only";
// Storybook generation job (Task 8): one job = one agent_runs row with trigger 'storybook'
// (migration 2800), driven by the client in resumable ticks — the same D-022 model as the album
// orchestrator (src/lib/ai/orchestrator.ts):
//
//   start   → create_agent_run_capped (one active run per book, daily cap for live runs) → state
//             'discovering', empty cursor. A second start while one runs = already_running + its id.
//   tick    → claim the lease → bounded work → checkpoint cursor + progress under the lease token
//             → release. A tick that loses its lease (expired, re-claimed, or Stop) writes nothing
//             more and answers "leased".
//   stages  → discovering  analyzePhotos (Task 3, cached per image) in batches, then
//                          clusterPhotosIntoMoments (Task 4: quality ≤ 150 per call, duplicates)
//             organizing   moments + planStory (Task 6; the plan is kept in the cursor)
//             writing      writeStoryStep — ONE chapter group per tick (Task 6 hook), the written
//                          blocks are kept in the cursor until the version is stored
//             designing    composeStorybookPages (Task 7) — saves books.doc only if the job still
//                          holds its lease right before the save (beforeSave)
//   cancel  → state failed + error_code 'cancelled', lease AND token cleared → the running tick's
//             next checkpoint fails and it stops before any further model call / doc write.
//   resume  → "Try again" starts a NEW run; its first tick copies the finished stages of the
//             previous failed / cancelled run of the book (same photos) and continues from there.
//
// Idempotent by construction: analyses are cached per image (only photos without a stored
// analysis are sent), moments are recomputed (no model), the plan and every written chapter live
// in the cursor (a repeated tick never repeats their calls), a model call is reserved in the
// cursor BEFORE it is made (attempt counters bound dead ticks), the composed doc is saved with
// optimistic concurrency. AI off, over budget or over a limit → the rule plan + a story without
// text + the deterministic composer still produce a book, and the outcome says so plainly.
//
// Nothing here logs ids, text or photo data: error codes only.

import { checkDailyAiBudget } from "@/lib/ai/budget";
import { resolveAiMode, type AiMode } from "@/lib/ai/client";
import { limitsFor } from "@/lib/ai/limits";
import { analyzePhotos, PhotoIntelligenceError, type AnalyzePhotosResult } from "@/lib/ai/photo-intelligence/analyze";
import { readPhotoAiConfig } from "@/lib/ai/photo-intelligence/config";
import { bookDesignOf, isSupportedDesign } from "@/lib/book/book-design";
import { parseBookDoc } from "@/lib/book/schema";
import * as agentRunsDb from "@/lib/db/agent-runs";
import type { CreateRunCappedInput, CreateRunCappedResult, RunCheckpointPatch, RunForTick } from "@/lib/db/agent-runs";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getMyBook, type MyBook } from "@/lib/db/books";
import { listPhotosForOrganize, listVision, type OrganizePhotoRow } from "@/lib/db/photo-organize";
import { getCurrentStorybook } from "@/lib/db/storybooks";
import { clusterPhotosIntoMoments, OrganizeError } from "@/lib/photos/organize";
import { userOwnedElements } from "@/lib/storybook/compose";
import {
  CANCELLED_CODE,
  emptyStoryProgress,
  isStoryRunState,
  parseStoryProgress,
  STORY_RUN_STATES,
  storyRunViewOf,
  type OutcomeNote,
  type StoryRunOutcome,
  type StoryRunProgress,
  type StoryRunStage,
  type StoryRunState,
  type StoryRunView,
} from "@/lib/storybook/run/progress";
import type { Storybook } from "@/lib/storybook/types";
import type { Json } from "@/lib/supabase/database.types";
import { isSupabaseTimeout, SupabaseUnavailableError } from "@/lib/supabase/deadline";
import { composeStorybookPages, ComposeError, type ComposeAiStatus } from "./compose";
import { StoryPlanSchema, type StoryPlan } from "./plan";
import { newStoryWriteState, planStory, StoryError, storyWriteGroups, StoryWriteStateSchema, writeStoryStep, type StoryWriteState } from "./service";

// ---------------------------------------------------------------------------------------------
// Tunables

/** Lease per tick: covers the longest single unit (a plan / chapter call with its re-ask). ≤ 300 (claim_agent_run). */
export const STORY_LEASE_SECONDS = 240;
/** Soft budget of one tick: no new unit of work starts after it once one unit ran. */
export const STORY_TICK_BUDGET_MS = 40_000;
/** Model calls reserved per chapter group before it is given up ("stalled" → chapter_failed). */
export const MAX_GROUP_ATTEMPTS = 2;
/** planStory attempts before the rule planner is used without asking the model again. */
export const MAX_PLAN_ATTEMPTS = 2;
/** compose attempts (optimistic-lock conflicts / dead ticks) before the run fails. */
export const MAX_COMPOSE_ATTEMPTS = 3;
/** clusterPhotosIntoMoments calls (≤ 150 quality scores each) before the rest stays provisional. */
export const MAX_QUALITY_CALLS = 5;
/** Retryable analysis failures per photo before it is left out of the analysis. */
export const MAX_PHOTO_RETRIES = 2;
/** Book-level storybook story conflicts (a concurrent version append) before the run fails. */
export const MAX_WRITE_CONFLICTS = 2;

const STOP_ANALYSIS = new Set(["budget_exhausted", "ai_off", "cache_unavailable", "limit_reached"]);

// ---------------------------------------------------------------------------------------------
// Dependencies (injected in tests)

/** The signed-in owner's book (+ their user id). */
export type StoryRunBook = Pick<MyBook, "id" | "is_paid" | "doc" | "format" | "design_style"> & { user_id: string };

export interface StoryRunDeps {
  getBook(bookId: string): Promise<StoryRunBook | null>;
  listPhotos(bookId: string, userId: string): Promise<OrganizePhotoRow[]>;
  listVision(bookId: string, userId: string): Promise<Map<string, unknown>>;
  getCurrentStorybook(bookId: string, userId: string): Promise<Storybook | null>;
  createRunCapped(input: CreateRunCappedInput): Promise<CreateRunCappedResult>;
  claimRun(runId: string, leaseSeconds: number): Promise<string | null>;
  releaseRun(runId: string, token: string): Promise<void>;
  checkpointRun(runId: string, token: string, patch: RunCheckpointPatch): Promise<boolean>;
  getRunForTick(runId: string): Promise<RunForTick | null>;
  getPreviousStoryRun: typeof agentRunsDb.getPreviousStoryRun;
  cancelStoryRunRow(runId: string, progress: Json): Promise<boolean>;
  analyzePhotos(photoIds: readonly string[]): Promise<AnalyzePhotosResult[]>;
  clusterPhotosIntoMoments(bookId: string): Promise<{ moments: readonly unknown[]; pending: { quality: number } }>;
  planStory(bookId: string, opts: { rule: boolean }): Promise<StoryPlan>;
  writeStoryStep: typeof writeStoryStep;
  composeStorybookPages(bookId: string, opts: { rule: boolean; beforeSave: () => Promise<boolean> }): Promise<{ pages: number; warnings: number; ai: ComposeAiStatus; saved: boolean }>;
  resolveMode(): AiMode;
  /** True when the global daily AI budget is used up. Never throws (fails open). */
  isOverDailyAiBudget(): Promise<boolean>;
  /** Photos analysed per batch (2 × the photo concurrency). */
  analysisBatch(): number;
  now(): number;
}

export function defaultStoryRunDeps(): StoryRunDeps {
  return {
    getBook: async (bookId) => {
      const [user, book] = await Promise.all([getCurrentUser(), getMyBook(bookId)]);
      return user && book ? { ...book, user_id: user.id } : null;
    },
    listPhotos: listPhotosForOrganize,
    listVision,
    getCurrentStorybook,
    createRunCapped: agentRunsDb.createRunCapped,
    claimRun: agentRunsDb.claimRun,
    releaseRun: agentRunsDb.releaseRun,
    checkpointRun: agentRunsDb.checkpointRun,
    getRunForTick: agentRunsDb.getRunForTick,
    getPreviousStoryRun: agentRunsDb.getPreviousStoryRun,
    cancelStoryRunRow: agentRunsDb.cancelStoryRunRow,
    analyzePhotos: (ids) => analyzePhotos(ids),
    clusterPhotosIntoMoments: (bookId) => clusterPhotosIntoMoments(bookId),
    planStory: (bookId, opts) => planStory(bookId, opts.rule ? { mode: "off" } : {}),
    writeStoryStep,
    composeStorybookPages: async (bookId, opts) => {
      const r = await composeStorybookPages(bookId, { beforeSave: opts.beforeSave }, opts.rule ? { mode: "off" } : {});
      return { pages: r.doc.pages.length, warnings: r.report.warnings.length, ai: r.report.ai.status, saved: r.rev !== null };
    },
    resolveMode: () => resolveAiMode(),
    isOverDailyAiBudget: async () => {
      try {
        return !(await checkDailyAiBudget()).allowed;
      } catch {
        return false;
      }
    },
    analysisBatch: () => readPhotoAiConfig().concurrency * 2,
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------------------------
// Cursor (server-only; clients can never read agent_runs.cursor — 0700 column grants)

export type StoryCursor = {
  v: 1;
  /** false until the first tick set the run up (and maybe resumed a previous run). */
  initialized: boolean;
  notes: OutcomeNote[];
  analysis: { done: boolean; analysed: number; total: number; failed: string[]; retries: Record<string, number> };
  quality: { done: boolean; calls: number };
  moments: number | null;
  plan: StoryPlan | null;
  planAttempts: number;
  /** Sorted ready-photo ids the plan was made from (a resumed run only reuses a plan for the same photos). */
  photoSig: string | null;
  replanned: boolean;
  write: {
    state: StoryWriteState | null;
    attempts: Record<string, number>;
    conflicts: number;
    done: boolean;
    /** How the story was stored: AI text ("ai"), without text ("textless"), or not at all — the current version was kept ("kept"). */
    how: "ai" | "textless" | "kept" | null;
  };
  compose: { attempts: number; done: boolean; pages: number | null; warnings: number; ai: ComposeAiStatus | null };
  resumedFrom: string | null;
};

export function initialStoryCursor(): StoryCursor {
  return {
    v: 1,
    initialized: false,
    notes: [],
    analysis: { done: false, analysed: 0, total: 0, failed: [], retries: {} },
    quality: { done: false, calls: 0 },
    moments: null,
    plan: null,
    planAttempts: 0,
    photoSig: null,
    replanned: false,
    write: { state: null, attempts: {}, conflicts: 0, done: false, how: null },
    compose: { attempts: 0, done: false, pages: null, warnings: 0, ai: null },
    resumedFrom: null,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nat = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const numRecord = (v: unknown): Record<string, number> => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "number").map(([k, n]) => [k, nat(n)])) : {});

/** Parses a stored cursor; null when it is not a storybook cursor (blank `{}` included). */
export function parseStoryCursor(raw: unknown): StoryCursor | null {
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.analysis) || !isObj(raw.write) || !isObj(raw.compose) || !isObj(raw.quality)) return null;
  const base = initialStoryCursor();
  const plan = raw.plan === null || raw.plan === undefined ? null : StoryPlanSchema.safeParse(raw.plan);
  if (plan && !plan.success) return null;
  const wsRaw = raw.write.state;
  const ws = wsRaw === null || wsRaw === undefined ? null : StoryWriteStateSchema.safeParse(wsRaw);
  if (ws && !ws.success) return null;
  const how = raw.write.how;
  const ai = raw.compose.ai;
  return {
    v: 1,
    initialized: raw.initialized === true,
    notes: Array.isArray(raw.notes) ? (raw.notes.filter((n) => typeof n === "string") as OutcomeNote[]) : [],
    analysis: {
      done: raw.analysis.done === true,
      analysed: nat(raw.analysis.analysed),
      total: nat(raw.analysis.total),
      failed: Array.isArray(raw.analysis.failed) ? raw.analysis.failed.filter((x): x is string => typeof x === "string") : [],
      retries: numRecord(raw.analysis.retries),
    },
    quality: { done: raw.quality.done === true, calls: nat(raw.quality.calls) },
    moments: typeof raw.moments === "number" ? nat(raw.moments) : null,
    plan: plan ? plan.data : null,
    planAttempts: nat(raw.planAttempts),
    photoSig: typeof raw.photoSig === "string" ? raw.photoSig : null,
    replanned: raw.replanned === true,
    write: {
      state: ws ? ws.data : null,
      attempts: numRecord(raw.write.attempts),
      conflicts: nat(raw.write.conflicts),
      done: raw.write.done === true,
      how: how === "ai" || how === "textless" || how === "kept" ? how : null,
    },
    compose: {
      attempts: nat(raw.compose.attempts),
      done: raw.compose.done === true,
      pages: typeof raw.compose.pages === "number" ? nat(raw.compose.pages) : null,
      warnings: nat(raw.compose.warnings),
      ai: typeof ai === "string" ? (ai as ComposeAiStatus) : null,
    },
    resumedFrom: typeof raw.resumedFrom === "string" ? raw.resumedFrom : base.resumedFrom,
  };
}

/** Ready + kept photos the story is made from (sorted ids = the plan's photo signature). */
function storyPhotos(rows: readonly OrganizePhotoRow[]): OrganizePhotoRow[] {
  return rows.filter((r) => r.status === "kept");
}
function photoSigOf(rows: readonly OrganizePhotoRow[]): string {
  return storyPhotos(rows)
    .map((r) => r.id)
    .sort()
    .join(",");
}

/**
 * The cursor a resumed run starts from: the previous run's finished stages, as long as they still
 * describe the same photos. Attempt counters start fresh (a new "Try again" may call again), the
 * analysis is always re-checked (cheap: cached analyses are skipped), notes are re-collected.
 * Returns the cursor and the stage to continue at.
 */
export function resumeCursor(prev: StoryCursor, photoSig: string, prevRunId: string): { cursor: StoryCursor; stage: StoryRunStage } {
  const c = initialStoryCursor();
  c.initialized = true;
  c.resumedFrom = prevRunId;
  c.analysis = { ...prev.analysis, done: false, retries: {} };
  c.quality = { done: prev.quality.done, calls: 0 };
  c.moments = prev.moments;
  const samePhotos = prev.photoSig !== null && prev.photoSig === photoSig;
  if (!samePhotos || !prev.plan) return { cursor: c, stage: "discovering" };
  c.plan = prev.plan;
  c.photoSig = prev.photoSig;
  c.notes = prev.notes.filter((n) => n === "plan_rule" || n === "photos_unanalysed");
  if (prev.write.done) {
    c.write = { ...prev.write, attempts: {}, conflicts: 0 };
    c.notes.push(...prev.notes.filter((n) => n === "chapter_failed" || n === "story_kept" || n === "budget_exhausted" || n === "limit_reached" || n === "ai_off" || n === "usage_unavailable"));
    // the story is stored: re-check the photos quickly, then go straight to the design stage
    return { cursor: c, stage: "discovering" };
  }
  // keep every chapter that has an answer; a group that failed is asked again
  if (prev.write.state) {
    const groups = Object.fromEntries(Object.entries(prev.write.state.groups).filter(([, g]) => g.status === "ok"));
    c.write.state = { ...prev.write.state, groups };
  }
  return { cursor: c, stage: "discovering" };
}

// ---------------------------------------------------------------------------------------------
// Progress (what the owner may read)

function chaptersWritten(c: StoryCursor): number {
  if (!c.plan || !c.write.state) return 0;
  return c.plan.chapters.filter((ch) => c.write.state!.groups[ch.id] !== undefined).length;
}

/** Builds agent_runs.progress from the cursor and the run state. `failedAt` marks the stage a failure stopped at. */
export function storyProgressOf(c: StoryCursor, state: StoryRunState, mode: string, failedAt: StoryRunStage | null = null, outcome: StoryRunOutcome | null = null): StoryRunProgress {
  const p = emptyStoryProgress(state);
  const order = STORY_RUN_STATES;
  const at = state === "done" ? order.length : state === "failed" ? (failedAt ? order.indexOf(failedAt) : -1) : order.indexOf(state);
  const statusOf = (s: StoryRunStage): StoryRunProgress["stages"][StoryRunStage]["status"] => {
    const i = order.indexOf(s);
    if (state === "failed" && failedAt === null) return "pending";
    if (i < at) return "done";
    if (i === at) return state === "failed" ? "failed" : "running";
    return "pending";
  };
  const rule = mode === "rule";
  p.stages.discovering = { status: statusOf("discovering"), done: c.analysis.analysed, total: c.analysis.total };
  if (rule && p.stages.discovering.status === "done") p.stages.discovering = { status: "skipped" };
  p.stages.organizing = { status: statusOf("organizing"), moments: c.moments, chapters: c.plan ? c.plan.chapters.length : null };
  const groups = c.plan ? storyWriteGroups(c.plan) : [];
  const written = chaptersWritten(c);
  const closingNext = !!c.plan && written >= c.plan.chapters.length && groups.includes("closing") && !c.write.state?.groups.closing;
  p.stages.writing = { status: statusOf("writing"), done: written, chapters: c.plan ? c.plan.chapters.length : null, ...(closingNext && statusOf("writing") === "running" ? { closing: true } : {}) };
  if ((c.write.how === "textless" || c.write.how === "kept") && p.stages.writing.status === "done") p.stages.writing = { status: "skipped", chapters: c.plan?.chapters.length ?? null };
  p.stages.designing = { status: statusOf("designing"), pages: c.compose.pages };
  p.outcome = outcome;
  return p;
}

/** How much of the finished book the AI made, from what actually happened (never from the mode alone). */
export function storyOutcome(c: StoryCursor, mode: string): StoryRunOutcome {
  const notes = [...new Set(c.notes)];
  if (mode === "rule") {
    if (!notes.some((n) => n === "budget_exhausted" || n === "limit_reached")) notes.unshift("ai_off");
    return { ai: "none", notes, warnings: c.compose.warnings };
  }
  const planAi = c.plan?.source === "ai";
  const textAi = c.write.how === "ai";
  const pagesAi = c.compose.ai === "used";
  if (!planAi && !textAi && !pagesAi) return { ai: "none", notes, warnings: c.compose.warnings };
  const full = planAi && textAi && (pagesAi || c.compose.ai === null) && !notes.some((n) => n !== "pages_rule");
  return { ai: full ? "full" : "partial", notes, warnings: c.compose.warnings };
}

function viewOf(run: Pick<RunForTick, "id" | "state" | "progress" | "ai_status" | "error_code" | "mode">): StoryRunView {
  return storyRunViewOf(run);
}

/** Public view of a storybook run row (status route, wizard data). */
export function storyRunView(run: Pick<RunForTick, "id" | "state" | "progress" | "ai_status" | "error_code" | "mode">): StoryRunView {
  return viewOf(run);
}

// ---------------------------------------------------------------------------------------------
// start

export type StartStoryResult =
  | { ok: true; runId: string; mode: "live" | "replay" | "rule"; view: StoryRunView }
  | { ok: false; error: "not_found" | "already_running" | "user_edited" | "unsupported_design" | "no_photos" };

export async function startStoryRun(input: { bookId: string; userId: string }, deps: StoryRunDeps = defaultStoryRunDeps()): Promise<StartStoryResult> {
  const book = await deps.getBook(input.bookId);
  if (!book || book.user_id !== input.userId) return { ok: false, error: "not_found" };
  if (!isSupportedDesign(bookDesignOf(book))) return { ok: false, error: "unsupported_design" };
  // A doc the user edited that is not a composed storybook is never replaced (compose would refuse it too).
  const parsed = parseBookDoc(book.doc);
  if (!userOwnedElements(parsed.ok ? parsed.doc : null, book.doc).ok) return { ok: false, error: "user_edited" };
  const photos = storyPhotos(await deps.listPhotos(book.id, input.userId));
  if (photos.length === 0) return { ok: false, error: "no_photos" };

  const aiMode = deps.resolveMode();
  const notes: OutcomeNote[] = [];
  let mode: "live" | "replay" | "rule" = aiMode === "off" ? "rule" : aiMode;
  // D-059: over the daily AI budget → still make the book, without AI (and say so).
  if (mode === "live" && (await deps.isOverDailyAiBudget())) {
    mode = "rule";
    notes.push("budget_exhausted");
  }
  const limits = limitsFor(book.is_paid === true);
  const create = (m: typeof mode) =>
    deps.createRunCapped({ bookId: book.id, userId: input.userId, trigger: "storybook", mode: m, dailyCap: limits.maxLiveBuildsPerUserPerDay, rebuildCap: limits.maxRebuilds, enforce: m === "live" });
  let created = await create(mode);
  if ("error" in created && created.error === "limit") {
    // Out of AI builds today: the first draft is still made, without AI.
    mode = "rule";
    notes.push("limit_reached");
    created = await create(mode);
  }
  if ("error" in created) return { ok: false, error: "already_running" };
  const runId = created.id;
  if (notes.length) {
    // Remember why this run is a rule run (shown on completion). Best effort: a missed note only
    // makes the final line say "made without AI" in general terms.
    const token = await deps.claimRun(runId, 15).catch(() => null);
    if (token) {
      const cursor = { ...initialStoryCursor(), notes };
      await deps.checkpointRun(runId, token, { cursor: cursor as unknown as Json, progress: storyProgressOf(cursor, "discovering", mode) as unknown as Json }).catch(() => false);
      await deps.releaseRun(runId, token).catch(() => undefined);
    }
  }
  const progress = emptyStoryProgress("discovering");
  return { ok: true, runId, mode, view: { runId, state: "discovering", progress, done: false, aiStatus: null, errorCode: null, mode } };
}

// ---------------------------------------------------------------------------------------------
// cancel

export type CancelStoryResult = { view: StoryRunView } | { notFound: true };

/** Stop: the run becomes failed / 'cancelled' at once; a finished run is returned as it is. */
export async function cancelStoryRun(runId: string, deps: Pick<StoryRunDeps, "getRunForTick" | "cancelStoryRunRow"> = defaultStoryRunDeps()): Promise<CancelStoryResult> {
  const run = await deps.getRunForTick(runId);
  if (!run || !agentRunsDb.isStoryRunTrigger(run.trigger)) return { notFound: true };
  if (run.state === "done" || run.state === "failed") return { view: viewOf(run) };
  const state = isStoryRunState(run.state) ? run.state : "discovering";
  const before = parseStoryProgress(run.progress, state);
  const stopped: StoryRunProgress = { ...before, phase: "failed", stages: { ...before.stages } };
  for (const s of STORY_RUN_STATES) if (stopped.stages[s].status === "running") stopped.stages[s] = { ...stopped.stages[s], status: "failed" };
  const changed = await deps.cancelStoryRunRow(runId, stopped as unknown as Json);
  const after = changed ? null : await deps.getRunForTick(runId);
  if (after) return { view: viewOf(after) };
  return { view: viewOf({ ...run, state: "failed", progress: stopped as unknown as Json, error_code: CANCELLED_CODE }) };
}

// ---------------------------------------------------------------------------------------------
// advance (one tick)

export type StoryAdvanceResult = { view: StoryRunView } | { leased: true } | { notFound: true };

class StaleLease extends Error {
  constructor() {
    super("story run: stale lease");
    this.name = "StaleLease";
  }
}

class RunFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly stage: StoryRunStage,
  ) {
    super(code);
    this.name = "RunFailure";
  }
}

type Ctx = {
  deps: StoryRunDeps;
  run: RunForTick;
  token: string;
  bookId: string;
  userId: string;
  mode: string;
  cursor: StoryCursor;
  state: StoryRunState;
  t0: number;
  budgetMs: number;
  /** A unit of work (batch / plan / chapter / compose) already ran in this tick. */
  worked: boolean;
};

const overBudget = (ctx: Ctx) => ctx.worked && ctx.deps.now() - ctx.t0 >= ctx.budgetMs;

async function save(ctx: Ctx, extra: RunCheckpointPatch = {}): Promise<void> {
  const ok = await ctx.deps.checkpointRun(ctx.run.id, ctx.token, {
    state: ctx.state,
    cursor: ctx.cursor as unknown as Json,
    progress: storyProgressOf(ctx.cursor, ctx.state, ctx.mode) as unknown as Json,
    ...extra,
  });
  if (!ok) throw new StaleLease();
}

/** True while this tick still holds the lease (a Stop clears the token). */
async function stillOurs(ctx: Ctx): Promise<boolean> {
  return ctx.deps.checkpointRun(ctx.run.id, ctx.token, {});
}

function note(ctx: Ctx, n: OutcomeNote): void {
  if (!ctx.cursor.notes.includes(n)) ctx.cursor.notes.push(n);
}

export async function advanceStoryRun(runId: string, opts: { budgetMs?: number } = {}, deps: StoryRunDeps = defaultStoryRunDeps()): Promise<StoryAdvanceResult> {
  const pre = await deps.getRunForTick(runId);
  if (!pre || !agentRunsDb.isStoryRunTrigger(pre.trigger)) return { notFound: true };
  if (pre.state === "done" || pre.state === "failed") return { view: viewOf(pre) };
  const t0 = deps.now();
  const token = await deps.claimRun(runId, STORY_LEASE_SECONDS);
  if (!token) {
    const run = await deps.getRunForTick(runId);
    if (!run) return { notFound: true };
    if (run.state === "done" || run.state === "failed") return { view: viewOf(run) };
    return { leased: true };
  }
  let stale = false;
  try {
    const out = await tick(runId, token, t0, opts.budgetMs ?? STORY_TICK_BUDGET_MS, deps);
    if ("leased" in out) stale = true;
    return out;
  } finally {
    if (!stale) await deps.releaseRun(runId, token).catch(() => undefined);
  }
}

async function tick(runId: string, token: string, t0: number, budgetMs: number, deps: StoryRunDeps): Promise<StoryAdvanceResult> {
  const run = await deps.getRunForTick(runId);
  if (!run || !agentRunsDb.isStoryRunTrigger(run.trigger)) return { notFound: true };
  if (run.state === "done" || run.state === "failed") return { view: viewOf(run) };
  const state: StoryRunState = isStoryRunState(run.state) ? run.state : "discovering";
  let ctx: Ctx | null = null;
  try {
    const book = run.book_id ? await deps.getBook(run.book_id) : null;
    if (!book || !run.user_id || book.user_id !== run.user_id) throw new RunFailure("not_found", state === "done" || state === "failed" ? "discovering" : state);
    let cursor = parseStoryCursor(run.cursor);
    let stage: StoryRunState = state;
    if (!cursor || !cursor.initialized) {
      // First real tick: maybe continue a failed / cancelled run of this book (same photos).
      const notes = cursor?.notes ?? [];
      cursor = cursor ?? initialStoryCursor();
      const prev = await deps.getPreviousStoryRun(book.id, run.id);
      const prevCursor = prev && prev.state === "failed" ? parseStoryCursor(prev.cursor) : null;
      if (prev && prevCursor) {
        const rows = await deps.listPhotos(book.id, book.user_id);
        const resumed = resumeCursor(prevCursor, photoSigOf(rows), prev.id);
        cursor = { ...resumed.cursor, notes: [...new Set([...notes, ...resumed.cursor.notes])] };
        stage = resumed.stage;
      }
      cursor.initialized = true;
    }
    ctx = { deps, run, token, bookId: book.id, userId: book.user_id, mode: run.mode, cursor, state: stage, t0, budgetMs, worked: false };
    return await loop(ctx);
  } catch (e) {
    if (e instanceof StaleLease) return { leased: true };
    if (isSupabaseTimeout(e)) throw e instanceof SupabaseUnavailableError ? e : new SupabaseUnavailableError("story run tick (SUPABASE_TIMEOUT)");
    const code = e instanceof RunFailure ? e.code : codeOf(e);
    const stage = e instanceof RunFailure ? e.stage : ctx && ctx.state !== "done" && ctx.state !== "failed" ? ctx.state : "discovering";
    return fail(deps, run, token, ctx?.cursor ?? parseStoryCursor(run.cursor) ?? initialStoryCursor(), code, stage);
  }
}

function codeOf(e: unknown): string {
  if (e instanceof StoryError || e instanceof ComposeError || e instanceof OrganizeError || e instanceof PhotoIntelligenceError) return e.code;
  return "internal_error";
}

async function fail(deps: StoryRunDeps, run: RunForTick, token: string, cursor: StoryCursor, code: string, stage: StoryRunStage): Promise<StoryAdvanceResult> {
  const progress = storyProgressOf(cursor, "failed", run.mode, stage);
  const ok = await deps
    .checkpointRun(run.id, token, {
      state: "failed",
      ai_status: run.mode === "rule" ? null : "failed",
      error_code: code,
      cursor: cursor as unknown as Json,
      progress: progress as unknown as Json,
      finished_at: new Date(deps.now()).toISOString(),
    })
    .catch(() => false);
  if (!ok) return { leased: true };
  return { view: viewOf({ ...run, state: "failed", progress: progress as unknown as Json, ai_status: run.mode === "rule" ? null : "failed", error_code: code }) };
}

async function loop(ctx: Ctx): Promise<StoryAdvanceResult> {
  for (;;) {
    if (overBudget(ctx)) break;
    const before = ctx.state;
    // A stage change ends the tick, so the client shows the new stage
    // BEFORE the next tick starts its (possibly long) model call.
    const changed = () => ctx.state !== before;
    if (ctx.state === "discovering") {
      if ((await discover(ctx)) && !changed()) continue;
      break;
    }
    if (ctx.state === "organizing") {
      if ((await organize(ctx)) && !changed()) continue;
      break;
    }
    if (ctx.state === "writing") {
      if ((await write(ctx)) && !changed()) continue;
      break;
    }
    if (ctx.state === "designing") {
      if (await design(ctx)) return finish(ctx);
      break;
    }
    break;
  }
  await save(ctx);
  return { view: viewOf({ ...ctx.run, state: ctx.state, progress: storyProgressOf(ctx.cursor, ctx.state, ctx.mode) as unknown as Json, ai_status: null, error_code: null }) };
}

// ---- stage 1: discovering ------------------------------------------------------------------------

/** One unit of stage 1. Returns true to keep looping in this tick. */
async function discover(ctx: Ctx): Promise<boolean> {
  const c = ctx.cursor;
  if (ctx.mode !== "rule" && !c.analysis.done) {
    const [rows, vision] = await Promise.all([ctx.deps.listPhotos(ctx.bookId, ctx.userId), ctx.deps.listVision(ctx.bookId, ctx.userId)]);
    const photos = storyPhotos(rows).filter((r) => r.thumb_path);
    const failed = new Set(c.analysis.failed);
    c.analysis.total = photos.length;
    c.analysis.analysed = photos.filter((p) => vision.has(p.id)).length;
    const pending = photos.filter((p) => !vision.has(p.id) && !failed.has(p.id));
    if (pending.length === 0) {
      c.analysis.done = true;
      if (c.analysis.failed.length > 0) note(ctx, "photos_unanalysed");
      await save(ctx);
      return true;
    }
    if (!(await stillOurs(ctx))) throw new StaleLease();
    const batch = pending.slice(0, Math.max(1, ctx.deps.analysisBatch()));
    const results = await ctx.deps.analyzePhotos(batch.map((p) => p.id));
    ctx.worked = true;
    for (const r of results) {
      if (r.ok) {
        c.analysis.analysed++;
        delete c.analysis.retries[r.photoId];
        continue;
      }
      if (STOP_ANALYSIS.has(r.error)) {
        c.analysis.done = true;
        if (r.error === "budget_exhausted") note(ctx, "budget_exhausted");
        note(ctx, "photos_unanalysed");
        continue;
      }
      const tries = (c.analysis.retries[r.photoId] ?? 0) + 1;
      if (r.retryable && tries < MAX_PHOTO_RETRIES) c.analysis.retries[r.photoId] = tries;
      else {
        delete c.analysis.retries[r.photoId];
        if (!c.analysis.failed.includes(r.photoId)) c.analysis.failed.push(r.photoId);
      }
    }
    await save(ctx);
    return true;
  }
  if (!c.quality.done) {
    if (!(await stillOurs(ctx))) throw new StaleLease();
    let res: Awaited<ReturnType<StoryRunDeps["clusterPhotosIntoMoments"]>>;
    try {
      res = await ctx.deps.clusterPhotosIntoMoments(ctx.bookId);
    } catch (e) {
      if (e instanceof OrganizeError && e.code === "not_found") throw new RunFailure("not_found", "discovering");
      throw e;
    }
    ctx.worked = true;
    c.quality.calls++;
    c.moments = res.moments.length;
    if (res.pending.quality === 0 || c.quality.calls >= MAX_QUALITY_CALLS) c.quality.done = true;
    await save(ctx);
    return true;
  }
  ctx.state = "organizing";
  await save(ctx);
  return true;
}

// ---- stage 2: organizing -------------------------------------------------------------------------

async function organize(ctx: Ctx): Promise<boolean> {
  const c = ctx.cursor;
  if (c.plan) {
    ctx.state = c.write.done ? "designing" : "writing";
    await save(ctx);
    return true;
  }
  if (c.moments === null) {
    const res = await ctx.deps.clusterPhotosIntoMoments(ctx.bookId);
    c.moments = res.moments.length;
  }
  // Reserve the call BEFORE making it (a dead tick counts): after MAX_PLAN_ATTEMPTS, the rule planner.
  c.planAttempts++;
  await save(ctx);
  const rule = ctx.mode === "rule" || c.planAttempts > MAX_PLAN_ATTEMPTS;
  let plan: StoryPlan;
  try {
    plan = await ctx.deps.planStory(ctx.bookId, { rule });
  } catch (e) {
    if (e instanceof StoryError && (e.code === "no_photos" || e.code === "not_found")) throw new RunFailure(e.code, "organizing");
    throw e;
  }
  ctx.worked = true;
  const rows = await ctx.deps.listPhotos(ctx.bookId, ctx.userId);
  c.plan = plan;
  c.photoSig = photoSigOf(rows);
  if (plan.source !== "ai" && ctx.mode !== "rule") {
    note(ctx, "plan_rule");
    const r = plan.fallbackReason;
    if (r === "budget_exhausted" || r === "limit_reached" || r === "usage_unavailable") note(ctx, r);
  }
  ctx.state = "writing";
  await save(ctx);
  return true;
}

// ---- stage 3: writing ----------------------------------------------------------------------------

async function write(ctx: Ctx): Promise<boolean> {
  const c = ctx.cursor;
  const plan = c.plan;
  if (!plan) {
    ctx.state = "organizing";
    await save(ctx);
    return true;
  }
  if (c.write.done) {
    ctx.state = "designing";
    await save(ctx);
    return true;
  }
  if (ctx.mode === "rule") return storeWithoutNewText(ctx, plan);

  const state = c.write.state ?? newStoryWriteState();
  const groups = storyWriteGroups(plan);
  const skip = groups.filter((g) => !state.groups[g] && (c.write.attempts[g] ?? 0) >= MAX_GROUP_ATTEMPTS);
  // the group this step will call the model for (writeStoryStep skips the given-up ones first)
  const target = groups.find((g) => !state.groups[g] && !skip.includes(g));
  if (target) c.write.attempts[target] = (c.write.attempts[target] ?? 0) + 1;
  c.write.state = state;
  await save(ctx); // the reservation (and the state) is stored before the call
  if (!(await stillOurs(ctx))) throw new StaleLease();
  let r: Awaited<ReturnType<typeof writeStoryStep>>;
  try {
    r = await ctx.deps.writeStoryStep(ctx.bookId, plan, { state, maxGroups: 1, skip });
  } catch (e) {
    if (!(e instanceof StoryError)) throw e;
    ctx.worked = true;
    switch (e.code) {
      case "no_photos":
      case "not_found":
        throw new RunFailure(e.code, "writing");
      case "conflict":
        c.write.conflicts++;
        if (c.write.conflicts > MAX_WRITE_CONFLICTS) throw new RunFailure("conflict", "writing");
        await save(ctx);
        return true;
      case "invalid_plan":
        if (!c.replanned) {
          // the photos changed under the plan: plan once more
          c.replanned = true;
          c.plan = null;
          c.write.state = null;
          ctx.state = "organizing";
          await save(ctx);
          return true;
        }
        return storeWithoutNewText(ctx, plan);
      case "ai_off":
      case "usage_unavailable":
      case "limit_reached":
      case "budget_exhausted":
        note(ctx, e.code);
        return storeWithoutNewText(ctx, plan);
      default:
        // every chapter failed (nothing usable), or the draft didn't validate
        note(ctx, "chapter_failed");
        return storeWithoutNewText(ctx, plan);
    }
  }
  ctx.worked = true;
  c.write.state = r.state;
  if (r.kind === "pending") {
    await save(ctx);
    return true;
  }
  if (r.result.issues.some((i) => i.code === "chapter_failed" || i.code === "run_budget")) note(ctx, "chapter_failed");
  c.write.done = true;
  c.write.how = "ai";
  ctx.state = "designing";
  await save(ctx);
  return true;
}

/**
 * No (more) model text: keep what this run already wrote, else keep the book's current story,
 * else store the plan's pages without text — the design stage then still makes a book.
 */
async function storeWithoutNewText(ctx: Ctx, plan: StoryPlan): Promise<boolean> {
  const c = ctx.cursor;
  const written = c.write.state ? Object.values(c.write.state.groups).some((g) => g.status === "ok") : false;
  if (!written) {
    const current = await ctx.deps.getCurrentStorybook(ctx.bookId, ctx.userId);
    if (current) {
      note(ctx, "story_kept");
      c.write.done = true;
      c.write.how = "kept";
      ctx.state = "designing";
      await save(ctx);
      return true;
    }
  }
  if (!(await stillOurs(ctx))) throw new StaleLease();
  try {
    const r = await ctx.deps.writeStoryStep(ctx.bookId, plan, { state: written && c.write.state ? c.write.state : newStoryWriteState(), textless: true });
    if (r.kind === "done") c.write.state = r.state;
  } catch (e) {
    if (e instanceof StoryError && (e.code === "no_photos" || e.code === "not_found")) throw new RunFailure(e.code, "writing");
    if (e instanceof StoryError && e.code === "conflict") {
      c.write.conflicts++;
      if (c.write.conflicts > MAX_WRITE_CONFLICTS) throw new RunFailure("conflict", "writing");
      await save(ctx);
      return true;
    }
    throw e;
  }
  ctx.worked = true;
  c.write.done = true;
  c.write.how = written ? "ai" : "textless";
  if (written) note(ctx, "chapter_failed");
  ctx.state = "designing";
  await save(ctx);
  return true;
}

// ---- stage 4: designing --------------------------------------------------------------------------

/** Returns true when the doc was composed and saved (the run is done). */
async function design(ctx: Ctx): Promise<boolean> {
  const c = ctx.cursor;
  c.compose.attempts++;
  if (c.compose.attempts > MAX_COMPOSE_ATTEMPTS) throw new RunFailure("conflict", "designing");
  await save(ctx);
  try {
    const r = await ctx.deps.composeStorybookPages(ctx.bookId, { rule: ctx.mode === "rule", beforeSave: () => stillOurs(ctx) });
    ctx.worked = true;
    if (!r.saved) throw new StaleLease(); // stopped (or lease lost) right before the save: nothing written
    c.compose = { attempts: c.compose.attempts, done: true, pages: r.pages, warnings: r.warnings, ai: r.ai };
    if (ctx.mode !== "rule" && r.ai !== "used" && r.ai !== "off") note(ctx, "pages_rule");
    ctx.state = "done";
    return true;
  } catch (e) {
    if (!(e instanceof ComposeError)) throw e;
    ctx.worked = true;
    if (e.code === "conflict" && c.compose.attempts < MAX_COMPOSE_ATTEMPTS) {
      await save(ctx);
      return false;
    }
    throw new RunFailure(e.code, "designing");
  }
}

async function finish(ctx: Ctx): Promise<StoryAdvanceResult> {
  const outcome = storyOutcome(ctx.cursor, ctx.mode);
  const aiStatus = ctx.mode === "rule" ? null : outcome.ai === "full" ? "ok" : outcome.ai === "partial" ? "partial" : "failed";
  // The cursor keeps the plan (a later "Regenerate" starts fresh); written text is dropped.
  const cursor: StoryCursor = { ...ctx.cursor, write: { ...ctx.cursor.write, state: ctx.cursor.write.state ? { ...ctx.cursor.write.state, groups: {} } : null } };
  const progress = storyProgressOf(cursor, "done", ctx.mode, null, outcome);
  const ok = await ctx.deps.checkpointRun(ctx.run.id, ctx.token, {
    state: "done",
    ai_status: aiStatus,
    error_code: null,
    cursor: cursor as unknown as Json,
    progress: progress as unknown as Json,
    finished_at: new Date(ctx.deps.now()).toISOString(),
  });
  if (!ok) return { leased: true };
  return { view: viewOf({ ...ctx.run, state: "done", progress: progress as unknown as Json, ai_status: aiStatus, error_code: null }) };
}
