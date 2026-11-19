import "server-only";
// AI Story Planner + Narrative Writer for Balanced Storybooks (Task 6).
//
//   planStory(bookId)                         ONE model call → a StoryPlan (outline + page skeleton)
//   writeStory(bookId, plan, { chapterId? })  one model call PER CHAPTER (+ one for the closing page,
//                                             + at most one repair call per chapter) → a new
//                                             storybook version
//   rewriteNarrativeBlock(blockId, how)       ONE model call (one retry) → a new version in which
//                                             only that block changed, or a proposal
//
// Every function first proves that the signed-in user owns the book; someone else's book is
// `not_found` and nothing is read or sent. Every model call goes through runAgentStep (timeout,
// retries with backoff, stop_reason handling, strict zod validation, cost) and is written to
// story_ai_calls (tokens, cost, latency, error code — no text).
//
// What the model returns is never trusted: an outline is validated and re-asked once before the
// deterministic rule planner takes over; every block of narrative has to pass grounding.ts
// against the sources it cites, is re-asked once, and is DROPPED if it still fails — an
// ungrounded block is never stored. User-written text, user titles and locked pages are never
// overwritten (mergeAiDraft / the protected checks below).
//
// Nothing here logs prompts, answers, descriptions, generated text, ids or paths: codes only.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { checkDailyAiBudget } from "@/lib/ai/budget";
import { AGENT_TIMEOUT_MS, EFFORT, resolveAiMode, type AiMode } from "@/lib/ai/client";
import { estimateCallCostUsd } from "@/lib/ai/cost";
import { isOverDailyBudget, LIMITS, limitsFor, readDailyBudgetUsd } from "@/lib/ai/limits";
import { runAgentStep, type AgentStepRecord, type StepLogger, type StepResult } from "@/lib/ai/run-step";
import { cachedSystem, type AgentName, type AgentRequest, type AgentTransport, type Effort } from "@/lib/ai/transport";
import { getTransport } from "@/lib/ai/transport-factory";
import { ReplayTransport } from "@/lib/ai/transport-replay";
import { getCurrentUser } from "@/lib/auth/current-user";
import { BOOK_FORMATS, DESIGN_STYLES } from "@/lib/book/schema";
import { getMyBook } from "@/lib/db/books";
import { getTodayPhotoAnalysisSpendUsd } from "@/lib/db/photo-analyses";
import { listDuplicateGroups, listMoments, listPhotosForOrganize, listVision } from "@/lib/db/photo-organize";
import { countStoryRuns, getTodayStorySpendUsd, recordStoryCall, storyUsageAvailable, type StoryCallKind, type StoryCallRecord, type StoryCallScope, type StoryUsageCounts } from "@/lib/db/story-ai-calls";
import { appendStorybookVersion, getCurrentStorybook, getMemoryContext } from "@/lib/db/storybooks";
import { isStoryTone, type StoryTone } from "@/lib/story/questions";
import { balanceOf, storybookBalance, type StoryBalance } from "@/lib/storybook/balance";
import { STORY_BALANCE, STORY_LIMITS, StorybookSchema } from "@/lib/storybook/schemas";
import type { Chapter, Moment, NarrativeBlock, NarrativeKind, StoryPage, StoryPageKind, Storybook } from "@/lib/storybook/types";
import { aiProvenance, aiRewrite, isProtectedPage, isUserOwned, mergeAiDraft, userEdit, type MergeReport } from "@/lib/storybook/versioning";
import { clipText, codePointLength } from "@/lib/text/clip";
import { isUuid } from "@/lib/uuid";
import { isOverSpendCap } from "@/lib/ai/spend-caps";
import { createUsageMeter } from "@/lib/ai/usage/meter";
import type { UsageMeter } from "@/lib/ai/usage/types";
import { getEntitlementTier } from "@/lib/entitlements";
import { readStoryAiConfig, type StoryAiConfig } from "./config";
import { MAX_FACT_REFS, MAX_PHOTO_REFS, WORD_BOUNDS, checkBlock, countWords, type BlockDraft, type GroundingContext, type GroundingIssue, type GroundingIssueCode } from "./grounding";
import { buildStoryInputs, factRefsToStore, groundingFacts, groundingPhoto, type StoryInputs, type StoryPhoto } from "./inputs";
import { StoryPlanSchema, acceptedBookTitle, assemblePlan, chapterCountRange, checkOutline, checkPlanAgainstBook, ruleOutline, wantsClosing, type PlanFallbackReason, type PlanOutline, type StoryPlan } from "./plan";
import {
  REWRITE_KINDS,
  STORY_MAX_TOKENS,
  STORY_PIPELINE,
  STORY_PLANNER_PROMPT_VERSION,
  STORY_PLANNER_SYSTEM_PROMPT,
  STORY_REWRITER_PROMPT_VERSION,
  STORY_REWRITER_SYSTEM_PROMPT,
  STORY_WRITER_PROMPT_VERSION,
  STORY_WRITER_SYSTEM_PROMPT,
  StoryBlocksAiSchema,
  StoryBlocksStrictSchema,
  StoryPlanAiSchema,
  StoryPlanStrictSchema,
  StoryRewriteAiSchema,
  StoryRewriteStrictSchema,
  blocksLogOutput,
  planLogOutput,
  plannerUserText,
  rewriteLogOutput,
  rewriterUserText,
  writerUserText,
  type RewriteKind,
  type StoryBlockOutput,
  type StoryPlanOutput,
  type WriterSlot,
} from "./prompts";
import { previewSelection } from "./preview";
import { storyPlanReplaySynth, storyRewriteReplaySynth, storyWriteReplaySynth } from "./replay";
import { SKELETON_SHARES } from "./skeleton";

export const STORY_ERRORS = [
  "not_found", // no such book / block, malformed id, or not the caller's book
  "no_photos", // the book has no kept photo
  "ai_off", // AI mode is off (planStory returns the rule plan instead)
  "invalid_plan", // the plan failed validation against the book (detail: which check)
  "no_story", // regenerating a chapter needs an existing story version
  "invalid_instruction", // rewrite instruction malformed
  "usage_unavailable", // migration 2600 not applied: live calls are refused
  "limit_reached", // per-book story limit (writes / chapter regenerations / block rewrites)
  "budget_exhausted", // daily AI budget, or the per-run ceiling before the first call
  "protected", // the block is user-written or its page is locked
  "ungrounded", // a rewrite failed the grounding check twice
  "refused", // the model declined
  "model_error", // timeout / rate limit / 5xx after retries, or unusable output
  "invalid_result", // the assembled storybook failed validation — nothing stored
  "conflict", // another version was appended meanwhile — nothing stored
] as const;
export type StoryErrorCode = (typeof STORY_ERRORS)[number];

/** `message` is the code plus an optional sub-code — never ids, paths or content. */
export class StoryError extends Error {
  constructor(
    public readonly code: StoryErrorCode,
    public readonly detail?: string,
    /** Worth trying again later (transient model / network failure, or a concurrent write). */
    public readonly retryable = false,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "StoryError";
  }
}

export type StoryBook = { id: string; title: string | null; occasion: string | null; caption_lang: string; is_paid: boolean; format: string | null; design_style: string | null };

export type StoryDeps = {
  /** The signed-in owner and the book, or null (not signed in / not the owner / no such book). */
  ownerOf?: (bookId: string) => Promise<{ userId: string; book: StoryBook } | null>;
  listPhotos?: typeof listPhotosForOrganize;
  listVision?: typeof listVision;
  listMoments?: typeof listMoments;
  listDuplicateGroups?: typeof listDuplicateGroups;
  getContext?: typeof getMemoryContext;
  getCurrent?: typeof getCurrentStorybook;
  appendVersion?: typeof appendStorybookVersion;
  /** False while migration 2600 is missing. */
  usageAvailable?: () => Promise<boolean>;
  usageCounts?: (bookId: string, userId: string) => Promise<StoryUsageCounts>;
  record?: (rec: StoryCallRecord) => Promise<void>;
  /** True when the daily AI budget is used up (pipeline + photo analysis + story spend). */
  budgetExhausted?: () => Promise<boolean>;
  /** Task 9: true when a per-book / per-user spending cap is reached (never throws). */
  overSpendCap?: (owner: { userId: string; book: StoryBook }) => Promise<boolean>;
  /**
   * Task 9 (server-chosen, never from a client): the page budget a plan is made for. A free preview
   * plans the WHOLE paid book (LIMITS.paid.maxPages) so that completing it after payment reuses the
   * plan. Default: the book's own limit (limitsFor(is_paid).maxPages).
   */
  planMaxPages?: number;
  /** Task 9: usage ledger factory per call kind (default: ai_usage_ledger, bucket from the entitlement). */
  meterFor?: (owner: { userId: string; bookId: string }, kind: StoryCallKind) => UsageMeter | undefined;
  mode?: AiMode;
  transport?: AgentTransport | null;
  config?: StoryAiConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newRunId?: () => string;
};

export type StoryWriteResult = {
  storybook: Storybook;
  /** What a merge with the previous version kept; null for the first version. */
  merge: MergeReport | null;
  balance: StoryBalance;
  /**
   * Blocks that were dropped (their final grounding issues) and run-level problems: code
   * "chapter_failed" / "run_budget" with `blockId` = the chapter id or "closing".
   */
  issues: GroundingIssue[];
};

export type RewriteNarrativeInstruction = {
  kind: RewriteKind;
  /** Required for kind "tone". */
  tone?: StoryTone;
  /** The user's own steer, ≤ 200 code points. Passed to the model as quoted data. */
  note?: string;
};
export type NarrativeProposal = { blockId: string; kind: NarrativeKind; text: string; lang: "en" | "ar"; groundedIn: string[]; factRefs: string[] };
export type RewriteNarrativeResult = { proposal: NarrativeProposal; stored: boolean; /** The new version when stored. */ storybook: Storybook | null };

export const REWRITE_NOTE_MAX = 200;

// ---------------------------------------------------------------------------- shared plumbing

async function defaultOwnerOf(bookId: string): Promise<{ userId: string; book: StoryBook } | null> {
  if (!isUuid(bookId)) return null;
  const [user, book] = await Promise.all([getCurrentUser(), getMyBook(bookId)]);
  if (!user || !book) return null;
  return { userId: user.id, book: { id: book.id, title: book.title, occasion: book.occasion, caption_lang: book.caption_lang, is_paid: book.is_paid, format: book.format, design_style: book.design_style } };
}

/** Pipeline spend + photo-analysis spend + story spend against AI_DAILY_BUDGET_USD. Fails open like checkDailyAiBudget. */
async function defaultBudgetExhausted(): Promise<boolean> {
  const budget = readDailyBudgetUsd();
  if (budget === null) return false;
  const pipeline = await checkDailyAiBudget();
  if (!pipeline.allowed) return true;
  try {
    const { getTodaySpendUsd } = await import("@/lib/db/ai-spend");
    const [a, b, c] = await Promise.all([getTodaySpendUsd(), getTodayPhotoAnalysisSpendUsd(), getTodayStorySpendUsd()]);
    return isOverDailyBudget(a + b + c, budget);
  } catch {
    return false;
  }
}

async function defaultOverSpendCap(owner: { userId: string; book: StoryBook }): Promise<boolean> {
  return isOverSpendCap({ userId: owner.userId, bookId: owner.book.id, tier: await getEntitlementTier(owner.book.id) });
}

/** A directory that never holds fixtures: the shared tests/fixtures/ai files answer the ALBUM pipeline's agents. */
const NO_FIXTURES_DIR = "/nonexistent/story-replay";

function transportFor(mode: AiMode): AgentTransport | null {
  if (mode === "replay") {
    return new ReplayTransport({ scenario: "ok", fixturesDir: NO_FIXTURES_DIR, synths: { storyteller: storyPlanReplaySynth, caption_writer: storyWriteReplaySynth, rewriter: storyRewriteReplaySynth } });
  }
  return getTransport(mode);
}

type Session = {
  userId: string;
  book: StoryBook;
  mode: AiMode;
  live: boolean;
  config: StoryAiConfig;
  deps: StoryDeps;
  now: () => number;
  runId: string;
  scope: StoryCallScope;
  /** Version being written (null for a plan). */
  version: number | null;
  transport: AgentTransport;
  /** False in replay mode while the usage table is missing: nothing is recorded. */
  canRecord: boolean;
  /** Real cost of this run so far (USD). */
  spent: number;
  okCalls: number;
};

async function openBook(bookId: string, deps: StoryDeps): Promise<{ userId: string; book: StoryBook }> {
  const owner = typeof bookId === "string" ? await (deps.ownerOf ?? defaultOwnerOf)(bookId) : null;
  if (!owner) throw new StoryError("not_found");
  return owner;
}

async function loadInputs(owner: { userId: string; book: StoryBook }, deps: StoryDeps, current: Storybook | null): Promise<StoryInputs> {
  const { userId, book } = owner;
  const [photos, vision, storedMoments, duplicateGroups, context] = await Promise.all([
    (deps.listPhotos ?? listPhotosForOrganize)(book.id, userId),
    (deps.listVision ?? listVision)(book.id, userId),
    (deps.listMoments ?? listMoments)(book.id, userId),
    (deps.listDuplicateGroups ?? listDuplicateGroups)(book.id, userId),
    (deps.getContext ?? getMemoryContext)(book.id, userId),
  ]);
  return buildStoryInputs({ book, photos, vision, storedMoments, duplicateGroups, context, knownFacts: current?.facts ?? [] });
}

/**
 * Checks that must pass before a LIVE call, in order: usage table, per-book limit, daily budget.
 * Returns the reason a live call is not allowed, or null. Replay costs nothing and is never refused.
 */
async function liveGate(
  owner: { userId: string; book: StoryBook },
  deps: StoryDeps,
  scope: StoryCallScope,
  /** Task 8 (writeStoryStep): runs of this scope already counted that are THIS run (0 or 1) — a resumed step is not a new write. */
  ownCounted = 0,
): Promise<{ block: "usage_unavailable" | "limit_reached" | "budget_exhausted" | null; canRecord: boolean }> {
  const available = await (deps.usageAvailable ?? storyUsageAvailable)();
  if (!available) return { block: "usage_unavailable", canRecord: false };
  const counts = await (deps.usageCounts ?? countStoryRuns)(owner.book.id, owner.userId);
  const limits = limitsFor(owner.book.is_paid);
  const over =
    scope === "plan"
      ? counts.plans >= limits.maxStoryPlans
      : scope === "book"
        ? counts.writes - ownCounted >= limits.maxStoryWrites
        : scope === "chapter"
          ? counts.chapterRegens >= limits.maxStoryChapterRegens
          : counts.rewrites >= limits.maxStoryBlockRewrites;
  if (over) return { block: "limit_reached", canRecord: true };
  if (await (deps.budgetExhausted ?? defaultBudgetExhausted)()) return { block: "budget_exhausted", canRecord: true };
  // Task 9: per-book / per-user spending caps → the same plain "budget" outcome, no call
  if (await (deps.overSpendCap ?? defaultOverSpendCap)(owner)) return { block: "budget_exhausted", canRecord: true };
  return { block: null, canRecord: true };
}

type CallArgs<T, S> = {
  agent: AgentName;
  stepKey: string;
  kind: StoryCallKind;
  chapterId: string | null;
  promptVersion: string;
  system: string;
  userText: string;
  schema: AgentRequest<T>["schema"];
  strictSchema: Parameters<typeof runAgentStep<T, S>>[0]["strictSchema"];
  toLogOutput: (d: S) => unknown;
  effort: Effort;
  maxTokens: number;
  timeoutMs: number;
  retries: number;
  inputSummary: Record<string, unknown>;
  scenarioMeta: Record<string, unknown>;
};

/** Pessimistic USD estimate of a call that has not happened yet (run ceiling). ~3 chars per token. */
function estimateCost(s: Session, a: Pick<CallArgs<unknown, unknown>, "system" | "userText" | "maxTokens">): number {
  return estimateCallCostUsd(s.config.model, { inputTokens: Math.ceil((a.system.length + a.userText.length) / 3), maxOutputTokens: a.maxTokens });
}

/** One model call through runAgentStep, recorded in story_ai_calls. Never throws for a model failure. */
async function call<T, S>(s: Session, a: CallArgs<T, S>): Promise<StepResult<S>> {
  let step: AgentStepRecord | null = null;
  const logger: StepLogger = {
    insertStep: async (row) => {
      step = row;
    },
    addRunTotals: async () => {},
    meter: s.deps.meterFor ? s.deps.meterFor({ userId: s.userId, bookId: s.book.id }, a.kind) : createUsageMeter({ userId: s.userId, bookId: s.book.id, flow: "storybook", operation: a.kind }),
  };
  const result = await runAgentStep<T, S>({
    runId: s.runId,
    agent: a.agent,
    stepKey: a.stepKey,
    inputSummary: { ...a.inputSummary, promptVersion: a.promptVersion },
    request: {
      agent: a.agent,
      system: cachedSystem(a.system),
      messages: [{ role: "user", content: a.userText }],
      schema: a.schema,
      effort: a.effort,
      maxTokens: a.maxTokens,
      model: s.config.model,
      timeoutMs: a.timeoutMs,
      scenarioMeta: a.scenarioMeta,
    },
    strictSchema: a.strictSchema,
    toLogOutput: a.toLogOutput,
    transport: s.transport,
    logger,
    retry: { retries: a.retries, sleep: s.deps.sleep },
    now: s.now,
  });
  const logged = step as AgentStepRecord | null;
  const cost = s.live ? result.costUsd : 0;
  s.spent += cost;
  if (result.ok) s.okCalls++;
  if (s.canRecord) {
    const base = {
      userId: s.userId,
      bookId: s.book.id,
      runId: s.runId,
      kind: a.kind,
      scope: s.scope,
      chapterId: a.chapterId,
      storybookVersion: s.version,
      model: s.config.model,
      promptVersion: a.promptVersion,
      mode: s.live ? ("live" as const) : ("replay" as const),
      usage: { input: logged?.inputTokens ?? 0, output: logged?.outputTokens ?? 0, cacheRead: logged?.cacheReadTokens ?? 0, cacheWrite: logged?.cacheWriteTokens ?? 0 },
      costUsd: cost,
      latencyMs: logged?.latencyMs ?? 0,
    };
    try {
      await (s.deps.record ?? recordStoryCall)(result.ok ? { ...base, status: "ok" } : { ...base, status: "error", error: String(result.code).replace(/[^a-z_]/g, "_") });
    } catch {
      console.error("[story] record_failed");
    }
  }
  return result;
}

/** A server-chosen page budget (1–100), else the fallback. */
function pageBudget(wanted: number | undefined, fallback: number): number {
  return typeof wanted === "number" && Number.isInteger(wanted) && wanted >= 1 && wanted <= LIMITS.paid.maxPages ? wanted : fallback;
}

function failureOf(r: Extract<StepResult<unknown>, { ok: false }>): StoryError {
  return r.status === "refused" ? new StoryError("refused") : new StoryError("model_error", String(r.code), r.retryable);
}

// ---------------------------------------------------------------------------- planStory

function outlineFromModel(out: StoryPlanOutput, inputs: StoryInputs): PlanOutline {
  const idByAlias = new Map(inputs.photos.map((p) => [p.alias, p.id]));
  const momentById = new Map(inputs.moments.map((m) => [m.id, m]));
  return {
    title: out.title,
    subtitle: out.subtitle,
    chapters: out.chapters.map((c, i) => {
      const moments = c.momentIds.map((id) => momentById.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
      const own = new Set(moments.flatMap((m) => m.photoIds));
      const hero = idByAlias.get(c.heroPhoto);
      // a hero outside the chapter is a cheap mistake: fixed in code, not worth a second call
      const fallback = [...moments].sort((a, b) => b.photoIds.length - a.photoIds.length)[0];
      const heroPhotoId = hero && own.has(hero) ? hero : (fallback?.heroPhotoId ?? fallback?.photoIds[0] ?? inputs.photos[0]!.id);
      return { id: `c${i + 1}`, title: c.title, arc: c.arc, momentIds: c.momentIds, beats: { heroPhotoId, narrativeMomentIds: c.paragraphMoments.filter((m) => c.momentIds.includes(m)) } };
    }),
  };
}

/**
 * Plans the story of the signed-in user's book: ONE model call (re-asked once when the outline
 * is unusable), else the deterministic rule plan. Never throws for an AI failure — `plan.source`
 * says who planned and `plan.fallbackReason` why the rule planner was used. Throws StoryError
 * only for `not_found` and `no_photos`.
 */
export async function planStory(bookId: string, deps: StoryDeps = {}): Promise<StoryPlan> {
  const config = deps.config ?? readStoryAiConfig();
  const mode = deps.mode ?? resolveAiMode();
  const owner = await openBook(bookId, deps);
  const inputs = await loadInputs(owner, deps, null);
  if (inputs.photos.length === 0) throw new StoryError("no_photos");

  const maxPages = pageBudget(deps.planMaxPages, limitsFor(owner.book.is_paid).maxPages);
  const base = { bookId: owner.book.id, inputs, maxPages, promptVersion: STORY_PLANNER_PROMPT_VERSION };
  const rule = (reason: PlanFallbackReason) => assemblePlan({ ...base, outline: ruleOutline(inputs), source: "rule", fallbackReason: reason, model: null });
  if (mode === "off") return rule("ai_off");

  const live = mode === "live";
  let canRecord = true;
  if (live) {
    const gate = await liveGate(owner, deps, "plan");
    if (gate.block) return rule(gate.block);
  } else canRecord = await (deps.usageAvailable ?? storyUsageAvailable)().catch(() => false);
  const transport = deps.transport === undefined ? transportFor(mode) : deps.transport;
  if (!transport) return rule("ai_off");

  const s: Session = { ...owner, mode, live, config, deps, now: deps.now ?? Date.now, runId: (deps.newRunId ?? randomUUID)(), scope: "plan", version: null, transport, canRecord, spent: 0, okCalls: 0 };
  const range = chapterCountRange(inputs.photos.length, inputs.moments.length);
  const closing = wantsClosing(inputs.photos.length);
  const aliasById = new Map(inputs.photos.map((p) => [p.id, p.alias]));
  const replayOutline = ruleOutline(inputs);
  const scenarioMeta = {
    lang: inputs.lang,
    chapters: replayOutline.chapters.map((c) => ({ title: c.title, arc: c.arc, momentIds: c.momentIds, heroPhoto: aliasById.get(c.beats.heroPhotoId), paragraphMoments: c.beats.narrativeMomentIds })),
  };

  let feedback: { codes: string[] } | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await call(s, {
      agent: "storyteller",
      stepKey: `story-plan:${attempt}`,
      kind: "plan",
      chapterId: null,
      promptVersion: STORY_PLANNER_PROMPT_VERSION,
      system: STORY_PLANNER_SYSTEM_PROMPT,
      userText: plannerUserText(inputs, range, closing, feedback),
      schema: StoryPlanAiSchema,
      strictSchema: StoryPlanStrictSchema,
      toLogOutput: planLogOutput,
      effort: EFFORT.storyteller,
      maxTokens: STORY_MAX_TOKENS.planner,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      inputSummary: { photos: inputs.photos.length, moments: inputs.moments.length, facts: inputs.facts.length, attempt },
      scenarioMeta,
    });
    if (!result.ok) {
      if (result.status === "refused") return rule("refused");
      if (result.code !== "schema_invalid" && result.code !== "parse_failed") return rule("model_error");
      feedback = { codes: ["invalid_output"] };
      continue;
    }
    const outline = outlineFromModel(result.data, inputs);
    const issues = checkOutline(outline, inputs);
    if (issues.length === 0) {
      const titled: PlanOutline = { ...outline, title: acceptedBookTitle(outline.title, inputs), subtitle: acceptedBookTitle(outline.subtitle, inputs) };
      if (titled.title === null) titled.subtitle = null;
      return assemblePlan({ ...base, outline: titled, source: "ai", fallbackReason: null, model: result.model });
    }
    feedback = { codes: [...new Set(issues.flatMap((i) => [i.code, ...(i.grounding ?? []).map((g) => g.code)]))] };
  }
  return rule("invalid_output");
}

// ---------------------------------------------------------------------------- writing

type Accepted = { kind: NarrativeKind; text: string; photoIds: string[]; factRefs: string[] };
type Slot = WriterSlot & { pageId: string };

type WriteContext = {
  s: Session;
  inputs: StoryInputs;
  plan: StoryPlan;
  photoByAlias: Map<string, StoryPhoto>;
  bookAliases: Set<string>;
  /** Text of every block that will be in the book — grows as blocks are accepted. */
  bookTexts: string[];
  maxRunCostUsd: number;
};

function groundingContext(w: WriteContext, allowed: readonly StoryPhoto[]): GroundingContext {
  return { lang: w.inputs.lang, photos: new Map(allowed.map((p) => [p.alias, groundingPhoto(p)])), bookPhotos: w.bookAliases, facts: groundingFacts(w.inputs.facts), otherTexts: w.bookTexts, avoid: w.inputs.avoid, narrator: w.inputs.narrator };
}

/** First three words of every text already in the book, de-duplicated (at most 60). */
function openingsOf(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    const words = t.trim().split(/\s+/).slice(0, 3).join(" ").replace(/[,.;:!?…،]+$/u, "");
    if (words) out.add(words);
  }
  return [...out].slice(0, 60);
}

type SlotsOutcome =
  | { ok: true; accepted: Map<string, Accepted>; issues: GroundingIssue[] }
  | { ok: false; error: StoryError }
  | { ok: false; error: null; budget: true };

/**
 * Writes one group of blocks (a chapter, or the closing page): one call, the grounding check,
 * ONE repair call for the blocks that failed, then the still-failing blocks are dropped.
 */
async function writeSlots(
  w: WriteContext,
  a: { chapterId: string | null; scopeId: string; slots: readonly Slot[]; promptPhotos: readonly StoryPhoto[]; allowed: readonly StoryPhoto[]; alreadyWritten: readonly { label: string; text: string }[]; chapterTexts?: readonly string[] },
): Promise<SlotsOutcome> {
  const { s, inputs, plan } = w;
  const ctx = groundingContext(w, a.allowed);
  const request = (slots: readonly Slot[], repair?: { blockId: string; codes: string[] }[], written: readonly { label: string; text: string }[] = a.alreadyWritten) => ({
    agent: "caption_writer" as const,
    chapterId: a.scopeId,
    promptVersion: STORY_WRITER_PROMPT_VERSION,
    system: STORY_WRITER_SYSTEM_PROMPT,
    userText: writerUserText({ inputs, plan, chapterId: a.chapterId, slots, photos: a.promptPhotos, alreadyWritten: written, repair, usedOpenings: openingsOf(w.bookTexts) }),
    schema: StoryBlocksAiSchema,
    strictSchema: StoryBlocksStrictSchema,
    toLogOutput: blocksLogOutput,
    timeoutMs: s.config.timeoutMs,
    retries: s.config.retries,
    inputSummary: { blocks: slots.length, photos: a.promptPhotos.length, facts: inputs.facts.length, repair: !!repair },
    scenarioMeta: { lang: inputs.lang, chapter: a.scopeId, blocks: slots.map((x) => ({ id: x.blockId, kind: x.kind, photos: x.pagePhotos })), photos: a.promptPhotos.map((p) => p.alias) },
  });

  const first = { ...request(a.slots), stepKey: `story-write:${a.scopeId}`, kind: "write" as const, effort: EFFORT.caption_writer, maxTokens: STORY_MAX_TOKENS.writer };
  if (s.live && s.spent + estimateCost(s, first) > w.maxRunCostUsd) return { ok: false, error: null, budget: true };
  const result = await call(s, first);
  if (!result.ok) return { ok: false, error: failureOf(result) };

  const accepted = new Map<string, Accepted>();
  /** Accepted texts of this chapter so far (v2 near-duplicate check), plus its protected pages' texts. */
  const chapterTexts: string[] = [...(a.chapterTexts ?? [])];
  const check = (slot: Slot, blocks: readonly StoryBlockOutput[]): GroundingIssue[] => {
    const out = blocks.find((b) => b.blockId === slot.blockId);
    if (!out) return [{ blockId: slot.blockId, code: "empty", detail: "missing" }];
    const draft: BlockDraft = { blockId: slot.blockId, kind: slot.kind, text: out.text, photoRefs: out.photoRefs, factRefs: out.factRefs };
    const issues = checkBlock(draft, { ...ctx, chapterTexts });
    if (issues.length === 0) {
      accepted.set(slot.blockId, {
        kind: slot.kind,
        text: out.text,
        photoIds: [...new Set(out.photoRefs.map((r) => w.photoByAlias.get(r)?.id).filter((x): x is string => !!x))].slice(0, MAX_PHOTO_REFS),
        factRefs: out.factRefs.slice(0, MAX_FACT_REFS),
      });
      w.bookTexts.push(out.text);
      chapterTexts.push(out.text);
    }
    return issues;
  };

  const failed: { slot: Slot; issues: GroundingIssue[] }[] = [];
  for (const slot of a.slots) {
    const issues = check(slot, result.data.blocks);
    if (issues.length) failed.push({ slot, issues });
  }
  if (failed.length === 0) return { ok: true, accepted, issues: [] };

  // ONE repair call for all failed blocks of this chapter
  const written = [...a.alreadyWritten, ...[...accepted.entries()].map(([id, b]) => ({ label: id, text: b.text }))];
  const repair = {
    ...request(failed.map((f) => f.slot), failed.map((f) => ({ blockId: f.slot.blockId, codes: [...new Set(f.issues.map((i) => i.code))] })), written),
    stepKey: `story-repair:${a.scopeId}`,
    kind: "repair" as const,
    effort: EFFORT.caption_repair,
    maxTokens: STORY_MAX_TOKENS.repair,
  };
  const dropped: GroundingIssue[] = [];
  if (s.live && s.spent + estimateCost(s, repair) > w.maxRunCostUsd) {
    for (const f of failed) dropped.push(...f.issues);
    dropped.push({ blockId: a.scopeId, code: "run_budget", detail: "repair" });
    return { ok: true, accepted, issues: dropped };
  }
  const second = await call(s, repair);
  for (const f of failed) {
    if (!second.ok) dropped.push(...f.issues);
    else dropped.push(...check(f.slot, second.data.blocks));
  }
  return { ok: true, accepted, issues: dropped };
}

const DEFAULT_SHARE: Record<NarrativeKind, number> = { intro: SKELETON_SHARES.opener, paragraph: SKELETON_SHARES.mixed, caption: SKELETON_SHARES.caption, pull_quote: SKELETON_SHARES.caption, closing: SKELETON_SHARES.closing };

/**
 * A page with its text, or — when its block was dropped — the same page without: the photos
 * stay, the text area becomes 0 and a mixed page becomes a photo page (StoryPageSchema stays valid).
 */
function composePage(base: Pick<StoryPage, "id" | "chapterId" | "momentId" | "photoIds" | "layoutId" | "userLocked">, plannedKind: StoryPageKind, plannedShare: number, blocks: NarrativeBlock[]): StoryPage | null {
  if (blocks.length > 0) {
    const share = plannedShare > 0 ? plannedShare : Math.max(...blocks.map((b) => DEFAULT_SHARE[b.kind]));
    const kind: StoryPageKind = plannedKind === "photo" && share > 0.2 ? "mixed" : plannedKind;
    return { ...base, kind, blocks, narrativeShare: share };
  }
  if (base.photoIds.length === 0) return plannedKind === "chapter_opener" ? { ...base, kind: plannedKind, blocks: [], narrativeShare: 0 } : null; // an empty page is not kept
  return { ...base, kind: plannedKind === "mixed" || plannedKind === "narrative" || plannedKind === "closing" ? "photo" : plannedKind, blocks: [], narrativeShare: 0 };
}

const mean = (xs: readonly number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10000) / 10000 : 0);

function toBlock(id: string, a: Accepted, lang: "en" | "ar", provenance: NarrativeBlock["provenance"]): NarrativeBlock {
  return { id, kind: a.kind, text: a.text, lang, provenance, groundedIn: a.photoIds, ...(a.factRefs.length ? { factRefs: a.factRefs } : {}) };
}

function citedFacts(pages: readonly StoryPage[]): Set<string> {
  return new Set(pages.flatMap((p) => p.blocks.flatMap((b) => b.factRefs ?? [])));
}

const DEFAULT_TITLE: Record<"en" | "ar", string> = { en: "A story in photographs", ar: "حكاية في صور" };

function beatOf(i: number, n: number, isHero: boolean): Moment["beat"] {
  if (i === 0) return "opening";
  if (i === n - 1) return "closing";
  return isHero ? "highlight" : "build";
}

/**
 * After mergeAiDraft: make the kept (user) pages and the fresh pages consistent again — a photo
 * is placed once (the user's page wins), block ids are unique (the fresh side is renumbered),
 * and a kept page never points at a chapter / moment / photo the new story no longer has.
 */
function reconcile(s: Storybook, keptPageIds: ReadonlySet<string>): Storybook {
  const chapterIds = new Set(s.chapters.map((c) => c.id));
  const momentIds = new Set(s.moments.map((m) => m.id));
  const known = new Set(s.moments.flatMap((m) => m.photoIds));
  const keptPhotos = new Set<string>();
  const keptBlocks = new Set<string>();
  let maxBlock = 0;
  for (const p of s.pages) {
    for (const b of p.blocks) maxBlock = Math.max(maxBlock, Number(b.id.slice(1)));
    if (!keptPageIds.has(p.id)) continue;
    for (const id of p.photoIds) keptPhotos.add(id);
    for (const b of p.blocks) keptBlocks.add(b.id);
  }
  const pages: StoryPage[] = [];
  for (const p of s.pages) {
    if (keptPageIds.has(p.id)) {
      const photoIds = p.photoIds.filter((id) => known.has(id));
      const page: StoryPage = { ...p, photoIds, chapterId: p.chapterId && chapterIds.has(p.chapterId) ? p.chapterId : null, momentId: p.momentId && momentIds.has(p.momentId) ? p.momentId : null };
      // only when a photo of the page left the book does a kept page change shape
      if (photoIds.length === p.photoIds.length && page.chapterId === p.chapterId && page.momentId === p.momentId) pages.push(p);
      else if (photoIds.length === 0 && (p.kind === "photo" || p.kind === "mixed")) pages.push({ ...page, kind: "narrative", narrativeShare: 1 });
      else pages.push(page);
      continue;
    }
    const photoIds = p.photoIds.filter((id) => !keptPhotos.has(id));
    const blocks = p.blocks.map((b) => (keptBlocks.has(b.id) ? { ...b, id: `b${++maxBlock}` } : b));
    if (photoIds.length === p.photoIds.length) pages.push(blocks.some((b, i) => b !== p.blocks[i]) ? { ...p, blocks } : p);
    else if (photoIds.length > 0) pages.push({ ...p, photoIds, blocks });
    else if (p.kind === "chapter_opener" || p.kind === "closing" || p.kind === "narrative") pages.push({ ...p, photoIds, blocks });
    // a photo / mixed page whose photos all live on a user page is dropped
  }
  return { ...s, pages: pages.slice(0, STORY_LIMITS.pagesPerBook) };
}

function storeOrThrow(candidate: Storybook): Storybook {
  const parsed = StorybookSchema.safeParse(candidate);
  if (!parsed.success) throw new StoryError("invalid_result", `${parsed.error.issues.length}_issues`);
  return parsed.data;
}

async function append(s: Session, storybook: Storybook): Promise<void> {
  const outcome = await (s.deps.appendVersion ?? appendStorybookVersion)(storybook, s.userId);
  if (outcome !== "ok") throw new StoryError("conflict", undefined, true);
}

const enumOr = <T extends string>(list: readonly T[], v: string | null, fallback: T): T => ((list as readonly string[]).includes(v ?? "") ? (v as T) : fallback);

/**
 * Writes the narrative for a plan and stores it as the next story version.
 *
 * Whole book (default): one model call per chapter and one for the closing page, each followed by
 * the grounding check and at most one repair call. A chapter whose call fails is left without
 * text and reported; the others are unaffected. When a current version exists the draft is
 * merged into it (user-written blocks, user titles and locked pages survive unchanged).
 *
 * `opts.chapterId`: regenerate ONE chapter of the current version — only its AI-owned blocks on
 * unprotected pages are rewritten (one call); every other page is carried over untouched.
 *
 * Throws StoryError; nothing is stored unless the result validates and the append succeeds.
 */
export async function writeStory(bookId: string, storyPlan: StoryPlan, opts: { chapterId?: string } = {}, deps: StoryDeps = {}): Promise<StoryWriteResult> {
  const out = await writeStoryImpl(bookId, storyPlan, opts, deps, null);
  if (out.kind !== "done") throw new StoryError("invalid_result", "pending"); // unreachable without a step control
  return out.result;
}

// ---------------------------------------------------------------------------- writeStoryStep (Task 8)

const AcceptedSchema = z.strictObject({ kind: z.enum(["intro", "paragraph", "pull_quote", "caption", "closing"]), text: z.string().min(1).max(4000), photoIds: z.array(z.string().max(64)).max(MAX_PHOTO_REFS), factRefs: z.array(z.string().max(64)).max(MAX_FACT_REFS) });
const IssueSchema = z.strictObject({ blockId: z.string().max(64), code: z.string().max(40), detail: z.string().max(64).optional() });
const GroupStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), blocks: z.array(z.tuple([z.string().regex(/^b[1-9]\d{0,3}$/), AcceptedSchema])).max(200), issues: z.array(IssueSchema).max(100) }),
  z.strictObject({ status: z.literal("failed"), code: z.string().max(40), detail: z.string().max(64).optional() }),
  z.strictObject({ status: z.literal("budget") }),
]);
/**
 * What writeStoryStep has written so far (kept by the caller between steps — e.g. in an agent_runs
 * cursor): one entry per finished group (chapter id or "closing"), the run id the calls are
 * recorded under (one "write" for the per-book limit, however many steps), the run's real cost
 * and the number of usable answers. Text of accepted blocks lives here until the version is stored.
 */
export const StoryWriteStateSchema = z.strictObject({
  v: z.literal(1),
  runId: z.string().uuid(),
  spentUsd: z.number().min(0).max(1000),
  okCalls: z.number().int().min(0).max(1000),
  groups: z.record(z.string().regex(/^(c[1-9]\d{0,3}|closing)$/), GroupStateSchema),
});
export type StoryWriteState = z.infer<typeof StoryWriteStateSchema>;

export function newStoryWriteState(runId: string = randomUUID()): StoryWriteState {
  return { v: 1, runId, spentUsd: 0, okCalls: 0, groups: {} };
}

/**
 * Groups (chapters + closing) a plan's whole-book write consists of, in writing order — the same
 * list writeStory walks. Pages the user protected are not known here, so a group may turn out to
 * have nothing to write (it is then skipped without a call).
 */
export function storyWriteGroups(plan: Pick<StoryPlan, "chapters" | "skeleton">): string[] {
  const ids = plan.chapters.map((c) => c.id);
  return plan.skeleton.pages.some((p) => p.kind === "closing") ? [...ids, "closing"] : ids;
}

export type StoryWriteStepOptions = {
  /** Carried between steps (newStoryWriteState() for the first). */
  state: StoryWriteState;
  /** New groups written by this call (default 1). */
  maxGroups?: number;
  /** Groups to give up on (each reported as chapter_failed "stalled", never called again). */
  skip?: readonly string[];
  /**
   * No model call at all: store the plan's pages without text (AI off, over budget, every chapter
   * failed). Allowed in every AI mode; the version is still merged with the current one (user
   * blocks / locked pages survive).
   */
  textless?: boolean;
  /** Task 9: the page budget the plan was made for (planStory planMaxPages). Default: the book's limit. */
  planMaxPages?: number;
  /**
   * Task 9: free preview — write only the chapters of previewSelection(plan, previewPages) and
   * store only those pages (no closing page). Absent = the whole book.
   */
  previewPages?: number;
};

export type StoryWriteStepResult =
  | { kind: "pending"; state: StoryWriteState; written: number; total: number }
  | { kind: "done"; state: StoryWriteState; result: StoryWriteResult; written: number; total: number };

/**
 * writeStory(bookId, plan) for the whole book, in bounded steps (Task 8: one chapter per request
 * fits the route limit). Each call writes at most `maxGroups` groups that `state` has no answer for
 * yet and returns `pending` with the updated state; the call that finds nothing left assembles,
 * merges and stores the version exactly like writeStory and returns `done`. Repeating a call with
 * the same state never repeats a finished group's model call. Throws StoryError like writeStory
 * (the live gate runs before every step that calls the model; a resumed run is not a new write).
 */
export async function writeStoryStep(bookId: string, storyPlan: StoryPlan, opts: StoryWriteStepOptions, deps: StoryDeps = {}): Promise<StoryWriteStepResult> {
  const parsed = StoryWriteStateSchema.safeParse(opts.state);
  if (!parsed.success) throw new StoryError("invalid_instruction", "state");
  const control: StepControl = {
    state: structuredClone(parsed.data),
    maxGroups: Math.max(1, Math.floor(opts.maxGroups ?? 1)),
    skip: new Set(opts.skip ?? []),
    textless: opts.textless === true,
    planMaxPages: opts.planMaxPages,
    previewPages: opts.previewPages,
  };
  const out = await writeStoryImpl(bookId, storyPlan, {}, deps, control);
  return out.kind === "pending" ? out : { kind: "done", state: control.state, result: out.result, written: out.written, total: out.total };
}

type StepControl = { state: StoryWriteState; maxGroups: number; skip: Set<string>; textless: boolean; planMaxPages?: number; previewPages?: number };
type ImplResult = StoryWriteStepResult | { kind: "done"; result: StoryWriteResult; state: null; written: number; total: number };

/** Never called: a textless step makes no model call. */
const NO_CALL_TRANSPORT: AgentTransport = {
  kind: "replay",
  parse: async () => {
    throw new StoryError("ai_off");
  },
};

async function writeStoryImpl(bookId: string, storyPlan: StoryPlan, opts: { chapterId?: string }, deps: StoryDeps, step: StepControl | null): Promise<ImplResult> {
  const config = deps.config ?? readStoryAiConfig();
  const mode = deps.mode ?? resolveAiMode();
  const now = deps.now ?? Date.now;
  const owner = await openBook(bookId, deps);
  const textless = step?.textless === true;
  if (mode === "off" && !textless) throw new StoryError("ai_off");

  const parsedPlan = StoryPlanSchema.safeParse(storyPlan);
  if (!parsedPlan.success) throw new StoryError("invalid_plan", "schema");
  const plan = parsedPlan.data;
  if (plan.bookId !== owner.book.id) throw new StoryError("invalid_plan", "stale");

  const current = await (deps.getCurrent ?? getCurrentStorybook)(owner.book.id, owner.userId);
  const inputs = await loadInputs(owner, deps, current);
  if (inputs.photos.length === 0) throw new StoryError("no_photos");
  const limits = limitsFor(owner.book.is_paid);
  const planIssues = checkPlanAgainstBook(plan, owner.book.id, inputs, pageBudget(step?.planMaxPages, limits.maxPages));
  if (planIssues.length) throw new StoryError("invalid_plan", planIssues[0]!.code);

  const chapterMode = opts.chapterId !== undefined;
  const planChapter = chapterMode ? plan.chapters.find((c) => c.id === opts.chapterId) : undefined;
  if (chapterMode && !planChapter) throw new StoryError("invalid_plan", "chapter");
  if (chapterMode && (!current || !current.chapters.some((c) => c.id === opts.chapterId))) throw new StoryError("no_story");

  const live = mode === "live" && !textless;
  const scope: StoryCallScope = chapterMode ? "chapter" : "book";
  let canRecord = true;
  if (textless) canRecord = false;
  else if (live) {
    const gate = await liveGate(owner, deps, scope, step && step.state.okCalls > 0 ? 1 : 0);
    if (gate.block) throw new StoryError(gate.block);
  } else canRecord = await (deps.usageAvailable ?? storyUsageAvailable)().catch(() => false);
  const transport = textless ? NO_CALL_TRANSPORT : deps.transport === undefined ? transportFor(mode) : deps.transport;
  if (!transport) throw new StoryError("ai_off");

  const version = (current?.version ?? 0) + 1;
  const runId = step ? step.state.runId : (deps.newRunId ?? randomUUID)();
  const s: Session = { ...owner, mode, live, config, deps, now, runId, scope, version, transport, canRecord, spent: step?.state.spentUsd ?? 0, okCalls: step?.state.okCalls ?? 0 };
  const photoByAlias = new Map(inputs.photos.map((p) => [p.alias, p]));
  const photoById = new Map(inputs.photos.map((p) => [p.id, p]));
  const aliasesOf = (ids: readonly string[]) => ids.map((id) => photoById.get(id)?.alias).filter((x): x is string => !!x);
  const w: WriteContext = { s, inputs, plan, photoByAlias, bookAliases: new Set(photoByAlias.keys()), bookTexts: [], maxRunCostUsd: limits.maxRunCostUsd };
  const nowIso = new Date(now()).toISOString();
  const generator = { pipeline: STORY_PIPELINE, model: config.model, prompts: { planner: plan.generator.promptVersion, writer: STORY_WRITER_PROMPT_VERSION } };
  const photosOfChapter = (momentIds: readonly string[]) => inputs.photos.filter((p) => momentIds.includes(p.momentId));

  // ------------------------------------------------------------------ one chapter of the current version
  if (chapterMode && current && planChapter) {
    const chapter = current.chapters.find((c) => c.id === planChapter.id)!;
    const currentMoments = new Map(current.moments.map((m) => [m.id, m]));
    const currentPhotoIds = new Set(chapter.momentIds.flatMap((id) => currentMoments.get(id)?.photoIds ?? []));
    const allowed = photosOfChapter(planChapter.momentIds);
    if (allowed.length !== currentPhotoIds.size || allowed.some((p) => !currentPhotoIds.has(p.id))) throw new StoryError("invalid_plan", "stale");

    const elsewhere = new Set(current.pages.filter((p) => p.chapterId !== chapter.id).flatMap((p) => p.blocks.map((b) => b.id)));
    const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    const targets = current.pages
      .filter((p) => p.chapterId === chapter.id && !isProtectedPage(p))
      .map((page) => {
        const sk = plan.skeleton.pages.find((x) => x.id === page.id && x.chapterId === chapter.id && sameIds(x.photoIds, page.photoIds) && x.blocks.every((b) => !elsewhere.has(b.id)));
        const planned = sk ? sk.blocks : page.blocks.map((b) => ({ id: b.id, kind: b.kind }));
        return { page, sk, slots: planned.map((b): Slot => ({ blockId: b.id, kind: b.kind, pageId: page.id, pagePhotos: aliasesOf(page.photoIds) })) };
      });
    const slots = targets.flatMap((t) => t.slots);
    const rewriting = new Set(targets.map((t) => t.page.id));
    w.bookTexts.push(...current.pages.filter((p) => !rewriting.has(p.id)).flatMap((p) => p.blocks.map((b) => b.text)));
    const earlier = current.chapters
      .slice(0, current.chapters.indexOf(chapter))
      .flatMap((c) => current.pages.filter((p) => p.chapterId === c.id && p.kind === "chapter_opener").flatMap((p) => p.blocks.filter((b) => b.kind === "intro").map((b) => ({ label: `${c.id} intro`, text: b.text }))));

    let accepted = new Map<string, Accepted>();
    const issues: GroundingIssue[] = [];
    if (slots.length > 0) {
      const kept = current.pages.filter((p) => p.chapterId === chapter.id && !rewriting.has(p.id)).flatMap((p) => p.blocks.map((b) => b.text));
      const outcome = await writeSlots(w, { chapterId: chapter.id, scopeId: chapter.id, slots, promptPhotos: allowed, allowed, alreadyWritten: earlier, chapterTexts: kept });
      if (!outcome.ok) throw outcome.error ?? new StoryError("budget_exhausted", "run_budget");
      accepted = outcome.accepted;
      issues.push(...outcome.issues);
    }
    const previous = new Map(current.pages.flatMap((p) => p.blocks.map((b) => [b.id, b] as const)));
    const replaced = new Map<string, StoryPage | null>();
    for (const t of targets) {
      const blocks = t.slots
        .filter((x) => accepted.has(x.blockId))
        .map((x) => {
          const prev = previous.get(x.blockId);
          return toBlock(x.blockId, accepted.get(x.blockId)!, inputs.lang, prev && !isUserOwned(prev.provenance) ? aiRewrite(prev.provenance, version) : aiProvenance(version));
        });
      const plannedKind = t.sk?.kind ?? (t.page.kind === "photo" && t.slots.some((x) => x.kind === "paragraph") ? "mixed" : t.page.kind);
      replaced.set(t.page.id, composePage(t.page, plannedKind, t.sk?.narrativeShare ?? t.page.narrativeShare, blocks));
    }
    const pages = current.pages.flatMap((p) => (replaced.has(p.id) ? (replaced.get(p.id) ? [replaced.get(p.id)!] : []) : [p]));
    const chapters = current.chapters.map((c) => (c.id === chapter.id ? { ...c, narrativeShare: mean(pages.filter((p) => p.chapterId === c.id).map((p) => p.narrativeShare)) } : c));
    const storybook = storeOrThrow({
      ...current,
      version,
      parentVersion: current.version,
      origin: "ai",
      generator: { ...generator, prompts: { ...current.generator.prompts, writer: STORY_WRITER_PROMPT_VERSION } },
      contextRev: inputs.contextRev ?? current.contextRev,
      chapters,
      pages,
      facts: factRefsToStore(inputs.facts, current.facts ?? [], citedFacts(pages)),
      createdAt: nowIso,
    });
    await append(s, storybook);
    const keptPages = current.pages.filter((p) => p.chapterId === chapter.id && isProtectedPage(p)).map((p) => p.id);
    return { kind: "done", state: null, written: 1, total: 1, result: { storybook, merge: { keptPages, keptBlocks: [], keptTitles: [], carriedPages: [] }, balance: storybookBalance(storybook), issues } };
  }

  // ------------------------------------------------------------------ the whole book
  // Pages the user locked or wrote on survive the merge whole (mergeAiDraft, by page id): their
  // blocks are not requested at all, and their text must not be repeated by the new draft.
  const protectedPages = (current?.pages ?? []).filter(isProtectedPage);
  const protectedIds = new Set(protectedPages.map((p) => p.id));
  w.bookTexts.push(...protectedPages.flatMap((p) => p.blocks.map((b) => b.text)));
  const accepted = new Map<string, Accepted>();
  const issues: GroundingIssue[] = [];
  const earlier: { label: string; text: string }[] = [];
  let lastError: StoryError | null = null;
  let outOfBudget = false;
  let attempted = 0;

  const groups: { chapterId: string | null; scopeId: string; slots: Slot[]; allowed: StoryPhoto[]; promptPhotos: StoryPhoto[] }[] = plan.chapters.map((c) => {
    const allowed = photosOfChapter(c.momentIds);
    const slots = plan.skeleton.pages.filter((p) => p.chapterId === c.id && !protectedIds.has(p.id)).flatMap((p) => p.blocks.map((b): Slot => ({ blockId: b.id, kind: b.kind, pageId: p.id, pagePhotos: aliasesOf(p.photoIds) })));
    return { chapterId: c.id, scopeId: c.id, slots, allowed, promptPhotos: allowed };
  });
  // Task 9: a free preview writes only the chapters it shows (and never the closing page)
  const preview = step?.previewPages ? previewSelection(plan, step.previewPages) : null;
  if (preview) {
    for (let i = groups.length - 1; i >= 0; i--) if (!preview.groups.includes(groups[i]!.scopeId)) groups.splice(i, 1);
  }
  const closingSlots = preview ? [] : plan.skeleton.pages.filter((p) => p.kind === "closing" && !protectedIds.has(p.id)).flatMap((p) => p.blocks.map((b): Slot => ({ blockId: b.id, kind: b.kind, pageId: p.id, pagePhotos: [] })));
  if (closingSlots.length) {
    const heroes = plan.chapters.map((c) => photoById.get(c.beats.heroPhotoId)).filter((p): p is StoryPhoto => !!p).slice(0, MAX_PHOTO_REFS);
    groups.push({ chapterId: null, scopeId: "closing", slots: closingSlots, allowed: inputs.photos, promptPhotos: heroes });
  }

  const total = groups.filter((g) => g.slots.length > 0).length;
  let written = 0;
  let newThisCall = 0;
  let pending = false;
  const keepAccepted = (g: (typeof groups)[number], got: ReadonlyMap<string, Accepted>) => {
    for (const [id, b] of got) accepted.set(id, b);
    const intro = g.slots.find((x) => x.kind === "intro" && got.has(x.blockId));
    if (intro) earlier.push({ label: `${g.scopeId} intro`, text: got.get(intro.blockId)!.text });
  };
  for (const g of groups) {
    if (g.slots.length === 0) continue;
    // Task 8 (writeStoryStep): a group finished in an earlier step is replayed from the state, never called again
    const done = step?.state.groups[g.scopeId];
    if (done) {
      written++;
      if (done.status === "ok") {
        attempted++;
        const got = new Map(done.blocks.filter(([id]) => g.slots.some((x) => x.blockId === id)));
        for (const b of got.values()) w.bookTexts.push(b.text);
        keepAccepted(g, got);
        issues.push(...(done.issues as GroundingIssue[]));
      } else if (done.status === "failed") {
        attempted++;
        lastError = new StoryError(STORY_ERRORS.includes(done.code as StoryErrorCode) ? (done.code as StoryErrorCode) : "model_error", done.detail);
        issues.push({ blockId: g.scopeId, code: "chapter_failed", detail: done.detail ?? done.code });
      } else {
        outOfBudget = true;
        issues.push({ blockId: g.scopeId, code: "run_budget" });
      }
      continue;
    }
    if (textless) continue;
    if (outOfBudget) {
      issues.push({ blockId: g.scopeId, code: "run_budget" });
      if (step) step.state.groups[g.scopeId] = { status: "budget" };
      written++;
      continue;
    }
    if (step?.skip.has(g.scopeId)) {
      attempted++;
      lastError = new StoryError("model_error", "stalled", true);
      issues.push({ blockId: g.scopeId, code: "chapter_failed", detail: "stalled" });
      step.state.groups[g.scopeId] = { status: "failed", code: "model_error", detail: "stalled" };
      written++;
      continue;
    }
    if (step && newThisCall >= step.maxGroups) {
      pending = true;
      break;
    }
    newThisCall++;
    attempted++;
    written++;
    const outcome = await writeSlots(w, { ...g, alreadyWritten: earlier, chapterTexts: protectedPages.filter((p) => g.chapterId !== null && p.chapterId === g.chapterId).flatMap((p) => p.blocks.map((b) => b.text)) });
    if (!outcome.ok) {
      if (outcome.error) {
        lastError = outcome.error;
        issues.push({ blockId: g.scopeId, code: "chapter_failed", detail: outcome.error.detail ?? outcome.error.code });
        if (step) step.state.groups[g.scopeId] = { status: "failed", code: outcome.error.code, ...(outcome.error.detail ? { detail: clipText(outcome.error.detail, 64) } : {}) };
      } else {
        outOfBudget = true;
        issues.push({ blockId: g.scopeId, code: "run_budget" });
        if (step) step.state.groups[g.scopeId] = { status: "budget" };
      }
      continue;
    }
    keepAccepted(g, outcome.accepted);
    issues.push(...outcome.issues);
    if (step) step.state.groups[g.scopeId] = { status: "ok", blocks: [...outcome.accepted.entries()], issues: outcome.issues.map((i) => ({ blockId: i.blockId, code: i.code, ...(i.detail ? { detail: clipText(i.detail, 64) } : {}) })) };
  }
  if (step) {
    step.state.spentUsd = Math.round(s.spent * 1_000_000) / 1_000_000;
    step.state.okCalls = s.okCalls;
  }
  if (step && pending) return { kind: "pending", state: step.state, written, total };
  // nothing usable came back at all → nothing is stored (when every page is the user's, nothing was asked)
  if (attempted > 0 && s.okCalls === 0) throw lastError ?? new StoryError("budget_exhausted", "run_budget");

  const heroIds = new Set(plan.chapters.map((c) => c.beats.heroPhotoId));
  const momentHero = new Map(inputs.moments.map((m) => [m.id, m.heroPhotoId]));
  const moments: Moment[] = plan.moments.map((m, i) => ({
    id: m.id,
    title: m.label,
    dateLabel: m.dateLabel,
    place: m.place,
    photoIds: m.photoIds,
    heroPhotoId: momentHero.get(m.id) ?? null,
    beat: beatOf(i, plan.moments.length, m.photoIds.some((id) => heroIds.has(id))),
    summary: null,
  }));
  const previewIds = preview ? new Set(preview.pageIds) : null;
  const pages: StoryPage[] = plan.skeleton.pages.filter((p) => !previewIds || previewIds.has(p.id)).flatMap((p) => {
    const blocks = p.blocks.filter((b) => accepted.has(b.id)).map((b) => toBlock(b.id, accepted.get(b.id)!, inputs.lang, aiProvenance(version)));
    const page = composePage({ id: p.id, chapterId: p.chapterId, momentId: p.momentId, photoIds: p.photoIds, layoutId: null, userLocked: false }, p.kind, p.narrativeShare, blocks);
    return page ? [page] : [];
  });
  const chapters: Chapter[] = plan.chapters.filter((c) => !preview || preview.groups.includes(c.id)).map((c) => ({
    id: c.id,
    title: { text: c.title, provenance: aiProvenance(version) },
    momentIds: c.momentIds,
    narrativeShare: mean(pages.filter((p) => p.chapterId === c.id).map((p) => p.narrativeShare)),
  }));
  const userTitle = owner.book.title?.replace(/\s+/g, " ").trim();
  const draft: Storybook = {
    v: 1,
    bookId: owner.book.id,
    version,
    parentVersion: current?.version ?? null,
    origin: "ai",
    generator,
    format: enumOr(BOOK_FORMATS, owner.book.format, "A5_PORTRAIT"),
    designStyle: enumOr(DESIGN_STYLES, owner.book.design_style, "classic"),
    lang: inputs.lang,
    title: userTitle ? { text: clipText(userTitle, STORY_LIMITS.title), provenance: userEdit(null, nowIso) } : { text: plan.title ?? DEFAULT_TITLE[inputs.lang], provenance: aiProvenance(version) },
    // a suggested subtitle belongs to the suggested title: not shown under the user's own title
    subtitle: !userTitle && plan.title && plan.subtitle ? { text: plan.subtitle, provenance: aiProvenance(version) } : null,
    coverPhotoId: plan.chapters[0]?.beats.heroPhotoId ?? null,
    contextRev: inputs.contextRev,
    target: { photoShare: STORY_BALANCE.photoShare, narrativeShare: STORY_BALANCE.narrativeShare },
    moments,
    chapters,
    pages,
    createdAt: nowIso,
  };

  let candidate = draft;
  let merge: MergeReport | null = null;
  if (current) {
    const merged = mergeAiDraft(current, draft, nowIso);
    merge = merged.report;
    candidate = reconcile(merged.storybook, new Set([...merge.keptPages, ...merge.carriedPages]));
    candidate = { ...candidate, chapters: candidate.chapters.map((c) => ({ ...c, narrativeShare: mean(candidate.pages.filter((p) => p.chapterId === c.id).map((p) => p.narrativeShare)) })) };
  }
  candidate = { ...candidate, facts: factRefsToStore(inputs.facts, current?.facts ?? [], citedFacts(candidate.pages)) };
  const storybook = storeOrThrow(candidate);
  await append(s, storybook);
  const result: StoryWriteResult = { storybook, merge, balance: balanceOf(storybook.pages, storybook.target), issues };
  return step ? { kind: "done", state: step.state, result, written, total } : { kind: "done", state: null, result, written, total };
}

// ---------------------------------------------------------------------------- rewriteNarrativeBlock

function parseBlockRef(blockId: unknown, bookId: unknown): { bookId: string; blockId: string } | null {
  if (typeof blockId !== "string") return null;
  const slash = blockId.indexOf("/");
  const book = slash >= 0 ? blockId.slice(0, slash) : typeof bookId === "string" ? bookId : "";
  const block = slash >= 0 ? blockId.slice(slash + 1) : blockId;
  if (slash >= 0 && typeof bookId === "string" && bookId !== book) return null;
  return isUuid(book) && /^b[1-9]\d{0,3}$/.test(block) ? { bookId: book, blockId: block } : null;
}

function cleanInstruction(i: RewriteNarrativeInstruction): { kind: RewriteKind; tone: StoryTone | null; note: string | null } {
  if (!i || typeof i !== "object" || !(REWRITE_KINDS as readonly string[]).includes(i.kind)) throw new StoryError("invalid_instruction", "kind");
  if (i.tone !== undefined && !isStoryTone(i.tone)) throw new StoryError("invalid_instruction", "tone");
  if (i.kind === "tone" && !i.tone) throw new StoryError("invalid_instruction", "tone");
  if (i.note !== undefined && typeof i.note !== "string") throw new StoryError("invalid_instruction", "note");
  // control characters out, whitespace collapsed; the note is only ever sent as a quoted string
  const note = (i.note ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  if (codePointLength(note) > REWRITE_NOTE_MAX) throw new StoryError("invalid_instruction", "note");
  return { kind: i.kind, tone: i.tone ?? null, note: note || null };
}

const collapse = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Rewrites ONE narrative block of the current story version. `blockId` is `"<bookId>/<blockId>"`
 * (e.g. `…uuid…/b12`), or a plain `b12` together with `opts.bookId`.
 *
 * AI-owned block on an unlocked page → a new version is stored in which only that block changed.
 * User-written block or locked page → `protected` (before any model call), unless
 * `opts.propose`: then the rewrite is returned as a proposal and nothing is stored.
 * The rewrite passes the same grounding check as written text (one retry, then `ungrounded`).
 */
export async function rewriteNarrativeBlock(blockId: string, instruction: RewriteNarrativeInstruction, opts: { bookId?: string; propose?: boolean } = {}, deps: StoryDeps = {}): Promise<RewriteNarrativeResult> {
  const ref = parseBlockRef(blockId, opts.bookId);
  if (!ref) throw new StoryError("not_found");
  const how = cleanInstruction(instruction);
  const config = deps.config ?? readStoryAiConfig();
  const mode = deps.mode ?? resolveAiMode();
  const now = deps.now ?? Date.now;
  const owner = await openBook(ref.bookId, deps);
  if (mode === "off") throw new StoryError("ai_off");

  const current = await (deps.getCurrent ?? getCurrentStorybook)(owner.book.id, owner.userId);
  const page = current?.pages.find((p) => p.blocks.some((b) => b.id === ref.blockId));
  const block = page?.blocks.find((b) => b.id === ref.blockId);
  if (!current || !page || !block) throw new StoryError("not_found");
  const isProtected = page.userLocked || isUserOwned(block.provenance);
  if (isProtected && !opts.propose) throw new StoryError("protected");

  const inputs = await loadInputs(owner, deps, current);
  const live = mode === "live";
  let canRecord = true;
  if (live) {
    const gate = await liveGate(owner, deps, "block");
    if (gate.block) throw new StoryError(gate.block);
  } else canRecord = await (deps.usageAvailable ?? storyUsageAvailable)().catch(() => false);
  const transport = deps.transport === undefined ? transportFor(mode) : deps.transport;
  if (!transport) throw new StoryError("ai_off");

  const version = current.version + 1;
  const s: Session = { ...owner, mode, live, config, deps, now, runId: (deps.newRunId ?? randomUUID)(), scope: "block", version, transport, canRecord, spent: 0, okCalls: 0 };
  const photoById = new Map(inputs.photos.map((p) => [p.id, p]));
  const photoByAlias = new Map(inputs.photos.map((p) => [p.alias, p]));

  // sources: the photos of the block's chapter (the whole book for a closing / chapterless page)
  const chapter = page.chapterId ? current.chapters.find((c) => c.id === page.chapterId) : undefined;
  const momentPhotos = new Map(current.moments.map((m) => [m.id, m.photoIds]));
  const allowed = chapter ? chapter.momentIds.flatMap((id) => momentPhotos.get(id) ?? []).map((id) => photoById.get(id)).filter((p): p is StoryPhoto => !!p) : inputs.photos;
  const first = [...page.photoIds, ...block.groundedIn].map((id) => photoById.get(id)).filter((p): p is StoryPhoto => !!p && allowed.includes(p));
  const promptPhotos = [...new Set([...first, ...allowed])].slice(0, 16);
  const ctx: GroundingContext = {
    lang: inputs.lang,
    photos: new Map(promptPhotos.map((p) => [p.alias, groundingPhoto(p)])),
    bookPhotos: new Set(photoByAlias.keys()),
    facts: groundingFacts(inputs.facts),
    otherTexts: current.pages.flatMap((p) => p.blocks.filter((b) => b.id !== block.id).map((b) => b.text)),
    avoid: inputs.avoid,
    narrator: inputs.narrator,
    chapterTexts: current.pages.filter((p) => p.chapterId === page.chapterId).flatMap((p) => p.blocks.filter((b) => b.id !== block.id).map((b) => b.text)),
  };
  const words = countWords(block.text);
  const bounds = WORD_BOUNDS[block.kind];
  const pagePhotos = page.photoIds.map((id) => photoById.get(id)?.alias).filter((x): x is string => !!x);

  let retry: GroundingIssueCode[] | undefined;
  let accepted: Accepted | null = null;
  for (let attempt = 1; attempt <= 2 && !accepted; attempt++) {
    const result = await call(s, {
      agent: "rewriter",
      stepKey: `story-rewrite:${attempt}`,
      kind: "rewrite",
      chapterId: page.chapterId ?? (page.kind === "closing" ? "closing" : null),
      promptVersion: STORY_REWRITER_PROMPT_VERSION,
      system: STORY_REWRITER_SYSTEM_PROMPT,
      userText: rewriterUserText({ inputs, tone: how.tone ?? inputs.storyTone, block: { id: block.id, kind: block.kind, text: block.text, words }, instruction: how.kind, note: how.note, range: bounds, pagePhotos, photos: promptPhotos, retry }),
      schema: StoryRewriteAiSchema,
      strictSchema: StoryRewriteStrictSchema,
      toLogOutput: rewriteLogOutput,
      effort: EFFORT.rewriter,
      maxTokens: STORY_MAX_TOKENS.rewriter,
      timeoutMs: AGENT_TIMEOUT_MS.rewriter,
      retries: Math.min(1, config.retries),
      inputSummary: { instruction: how.kind, kind: block.kind, words, hasNote: how.note !== null, photos: promptPhotos.length, facts: inputs.facts.length, attempt },
      scenarioMeta: { lang: inputs.lang, blockId: block.id, kind: block.kind, instruction: how.kind, words, min: bounds.min, max: bounds.max, rev: block.provenance.rev + attempt, photos: promptPhotos.map((p) => p.alias) },
    });
    if (!result.ok) throw failureOf(result);
    const out = result.data;
    const issues = checkBlock({ blockId: block.id, kind: block.kind, text: out.text, photoRefs: out.photoRefs, factRefs: out.factRefs }, ctx).map((i) => i.code);
    const after = countWords(out.text);
    if (collapse(out.text) === collapse(block.text)) issues.push("unchanged");
    if (how.kind === "shorter" && after >= words) issues.push("not_shorter");
    if (how.kind === "longer" && after <= words) issues.push("not_longer");
    if (issues.length === 0) {
      accepted = {
        kind: block.kind,
        text: out.text,
        photoIds: [...new Set(out.photoRefs.map((r) => photoByAlias.get(r)?.id).filter((x): x is string => !!x))].slice(0, MAX_PHOTO_REFS),
        factRefs: out.factRefs.slice(0, MAX_FACT_REFS),
      };
    } else retry = [...new Set(issues)];
  }
  if (!accepted) throw new StoryError("ungrounded", (retry ?? []).join(","));

  const proposal: NarrativeProposal = { blockId: block.id, kind: block.kind, text: accepted.text, lang: inputs.lang, groundedIn: accepted.photoIds, factRefs: accepted.factRefs };
  if (isProtected) return { proposal, stored: false, storybook: null };

  const next = toBlock(block.id, accepted, inputs.lang, aiRewrite(block.provenance, version));
  const pages = current.pages.map((p) => (p === page ? { ...p, blocks: p.blocks.map((b) => (b === block ? next : b)) } : p));
  const storybook = storeOrThrow({
    ...current,
    version,
    parentVersion: current.version,
    origin: "ai",
    generator: { pipeline: STORY_PIPELINE, model: config.model, prompts: { ...current.generator.prompts, rewriter: STORY_REWRITER_PROMPT_VERSION } },
    pages,
    facts: factRefsToStore(inputs.facts, current.facts ?? [], citedFacts(pages)),
    createdAt: new Date(now()).toISOString(),
  });
  await append(s, storybook);
  return { proposal, stored: true, storybook };
}
