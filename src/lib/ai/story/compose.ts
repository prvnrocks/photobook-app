import "server-only";
// composeStorybookPages(bookId) — Task 7, the server entry point of the Balanced Storybook page
// composer. Turns the book's current storybook version into real, editable book-doc pages rendered
// by the existing <BookPage> (editor, viewer, print), merges them with the user's edits and saves
// with the editor's optimistic concurrency (doc_rev).
//
//   1. owner check (someone else's book / no book → not_found; nothing is read or sent)
//   2. inputs: current storybook (none → no_story), ready photos + sizes, quality (focus point),
//      the book's format / design style / caption language / max_pages, the current doc
//   3. user ownership of the current doc (merge.ts): user-edited elements are kept byte-identical;
//      a non-story doc with user work → user_edited, nothing written
//   4. AI page intent: ONE model call (compose-intent.ts) when AI is on and the call may be made
//      (usage table present, per-book limit, daily budget — all checked BEFORE the call); refusal,
//      invalid output, a model error or AI off → the deterministic composer alone. Never throws for
//      an AI failure. Recorded in story_ai_calls (kind / scope "compose", migration 2700).
//   5. composeStoryDoc (pure, deterministic) → mergeComposition → validateBookDoc
//   6. saveDocIfRev(doc_rev read in step 2): a concurrent edit → conflict, nothing half-written
//
// Nothing here logs prompts, texts, ids or paths: codes only.

import { randomUUID } from "node:crypto";
import { checkDailyAiBudget } from "@/lib/ai/budget";
import { resolveAiMode, type AiMode } from "@/lib/ai/client";
import { isOverDailyBudget, limitsFor, readDailyBudgetUsd } from "@/lib/ai/limits";
import { runAgentStep, type AgentStepRecord, type StepLogger } from "@/lib/ai/run-step";
import { cachedSystem, type AgentTransport } from "@/lib/ai/transport";
import { getTransport } from "@/lib/ai/transport-factory";
import { ReplayTransport } from "@/lib/ai/transport-replay";
import { getCurrentUser } from "@/lib/auth/current-user";
import { bookDesignOf, isSupportedDesign } from "@/lib/book/book-design";
import { serializeDoc } from "@/lib/book/doc-version";
import { OccasionSchema, parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { getMyBook, saveDocIfRev, type MyBook } from "@/lib/db/books";
import { getTodayPhotoAnalysisSpendUsd } from "@/lib/db/photo-analyses";
import { listPhotosForOrganize, listQuality, type OrganizePhotoRow, type StoredQuality } from "@/lib/db/photo-organize";
import { countStoryRuns, getTodayStorySpendUsd, recordStoryCall, storyUsageAvailable, type StoryCallRecord, type StoryUsageCounts } from "@/lib/db/story-ai-calls";
import { getCurrentStorybook } from "@/lib/db/storybooks";
import type { Json } from "@/lib/supabase/database.types";
import { composeStoryDoc, mergeComposition, userOwnedElements, type ComposePhoto, type ComposeReport, type PageIntentChoice } from "@/lib/storybook/compose";
import type { Storybook } from "@/lib/storybook/types";
import { isUuid } from "@/lib/uuid";
import { isOverSpendCap } from "@/lib/ai/spend-caps";
import { createUsageMeter } from "@/lib/ai/usage/meter";
import type { UsageMeter } from "@/lib/ai/usage/types";
import { getEntitlementTier } from "@/lib/entitlements";
import { readStoryAiConfig, type StoryAiConfig } from "./config";
import {
  acceptIntents,
  composeLogOutput,
  ComposeIntentAiSchema,
  ComposeIntentStrictSchema,
  composeUserText,
  STORY_COMPOSE_MAX_TOKENS,
  STORY_COMPOSE_PROMPT_VERSION,
  STORY_COMPOSE_SYSTEM_PROMPT,
  storyComposeReplaySynth,
} from "./compose-intent";

export const COMPOSE_ERRORS = [
  "not_found", // no such book, malformed id, or not the caller's book
  "no_story", // the book has no storybook version yet (run writeStory first)
  "unsupported_design", // the book's style / format has no layouts
  "user_edited", // the current doc is an album the user edited (not a composed storybook): never overwritten
  "invalid_result", // the composed doc failed book-doc validation — nothing stored
  "saving_unavailable", // migration 0900 missing (no doc_rev)
  "conflict", // the doc changed since it was read (another tab / save) — nothing stored
] as const;
export type ComposeErrorCode = (typeof COMPOSE_ERRORS)[number];

export class ComposeError extends Error {
  constructor(
    public readonly code: ComposeErrorCode,
    public readonly detail?: string,
    public readonly retryable = false,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ComposeError";
  }
}

export type ComposeBook = Pick<MyBook, "id" | "title" | "occasion" | "caption_lang" | "is_paid" | "max_pages" | "doc" | "doc_rev" | "format" | "design_style">;

/** Why the AI page intent was or was not used (no ids, no text). */
export const COMPOSE_AI_STATUSES = ["used", "off", "usage_unavailable", "limit_reached", "budget_exhausted", "refused", "invalid", "model_error"] as const;
export type ComposeAiStatus = (typeof COMPOSE_AI_STATUSES)[number];

export type ComposeStorybookResult = {
  doc: BookDoc;
  report: ComposeReport & { ai: ComposeReport["ai"] & { status: ComposeAiStatus; ignored: number } };
  /** The saved revision (null for a dry run). */
  rev: number | null;
};

export type ComposeDeps = {
  ownerOf?: (bookId: string) => Promise<{ userId: string; book: ComposeBook } | null>;
  getCurrent?: typeof getCurrentStorybook;
  listPhotos?: typeof listPhotosForOrganize;
  listQuality?: typeof listQuality;
  save?: typeof saveDocIfRev;
  usageAvailable?: () => Promise<boolean>;
  usageCounts?: (bookId: string, userId: string) => Promise<StoryUsageCounts>;
  record?: (rec: StoryCallRecord) => Promise<void>;
  budgetExhausted?: () => Promise<boolean>;
  /** Task 9: true when a per-book / per-user spending cap is reached (never throws). */
  overSpendCap?: (userId: string, bookId: string) => Promise<boolean>;
  /** Task 9: usage ledger (default: ai_usage_ledger, operation compose, bucket from the entitlement). */
  meter?: UsageMeter;
  mode?: AiMode;
  transport?: AgentTransport | null;
  config?: StoryAiConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newRunId?: () => string;
};

async function defaultOwnerOf(bookId: string): Promise<{ userId: string; book: ComposeBook } | null> {
  if (!isUuid(bookId)) return null;
  const [user, book] = await Promise.all([getCurrentUser(), getMyBook(bookId)]);
  if (!user || !book) return null;
  return { userId: user.id, book };
}

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

async function defaultOverSpendCap(userId: string, bookId: string): Promise<boolean> {
  return isOverSpendCap({ userId, bookId, tier: await getEntitlementTier(bookId) });
}

const NO_FIXTURES_DIR = "/nonexistent/story-compose-replay";
function transportFor(mode: AiMode): AgentTransport | null {
  if (mode === "replay") return new ReplayTransport({ scenario: "ok", fixturesDir: NO_FIXTURES_DIR, synths: { storyteller: storyComposeReplaySynth } });
  return getTransport(mode);
}

/** The book's placeable photos for the composer: ready + kept, original size, quality focus. */
export function composePhotosOf(rows: readonly OrganizePhotoRow[], quality: readonly StoredQuality[]): ComposePhoto[] {
  const q = new Map(quality.map((x) => [x.photoId, x]));
  return rows
    .filter((r) => r.status === "kept")
    .map((r) => {
      const s = q.get(r.id);
      const fx = s?.raw?.weightX;
      const fy = s?.raw?.weightY;
      const focus = typeof fx === "number" && typeof fy === "number" && Number.isFinite(fx) && Number.isFinite(fy) ? { x: fx, y: fy } : null;
      return { id: r.id, width: r.width, height: r.height, quality: s ? s.overall : null, focus };
    });
}

/**
 * Composes the current storybook of the signed-in user's book into its book doc and saves it.
 * `opts.dryRun` = compose + validate, never save (previews, tests). Throws ComposeError only for
 * the codes above — an AI failure falls back to the deterministic composer.
 */
export async function composeStorybookPages(
  bookId: string,
  opts: {
    dryRun?: boolean;
    /**
     * Task 8: asked right before the save (after the AI call and validation). false = do not save —
     * the result comes back like a dry run (rev null). The storybook job uses it to check that the
     * job was not stopped meanwhile, so a cancelled job never writes the doc.
     */
    beforeSave?: () => Promise<boolean>;
    /**
     * Task 9: hard cap of the pages the COMPOSER makes (a free preview: 4–6 interior pages), below
     * the book's own limit. Server-chosen only. Pages the user made themselves are kept on top
     * (their own work, no AI); the publish gate caps what an unpaid storybook can share.
     */
    maxPages?: number;
  } = {},
  deps: ComposeDeps = {},
): Promise<ComposeStorybookResult> {
  const owner = typeof bookId === "string" ? await (deps.ownerOf ?? defaultOwnerOf)(bookId) : null;
  if (!owner) throw new ComposeError("not_found");
  const { userId, book } = owner;
  const design = bookDesignOf(book);
  if (!isSupportedDesign(design)) throw new ComposeError("unsupported_design");

  const storybook: Storybook | null = await (deps.getCurrent ?? getCurrentStorybook)(book.id, userId);
  if (!storybook) throw new ComposeError("no_story");
  const [rows, quality] = await Promise.all([(deps.listPhotos ?? listPhotosForOrganize)(book.id, userId), (deps.listQuality ?? listQuality)(book.id, userId)]);
  const photos = composePhotosOf(rows, quality);
  const lang = book.caption_lang === "ar" ? "ar" : "en";
  const occasionParsed = OccasionSchema.safeParse(book.occasion);
  const occasion = occasionParsed.success ? occasionParsed.data : "other";

  const parsed = parseBookDoc(book.doc);
  const current = parsed.ok ? parsed.doc : null;
  const ownership = userOwnedElements(current, book.doc);
  if (!ownership.ok) throw new ComposeError("user_edited");
  const owned = ownership.owned;

  // --- AI page intent (one call), never blocking ------------------------------------------------
  const runId = (deps.newRunId ?? randomUUID)();
  const ai = await pageIntents({ userId, book, storybook, photos, design, lang, runId, deps });

  const pageCap = typeof opts.maxPages === "number" && Number.isInteger(opts.maxPages) && opts.maxPages >= 1 ? Math.min(book.max_pages, opts.maxPages + owned.pages.length) : book.max_pages;
  const fresh = composeStoryDoc({
    storybook,
    photos,
    design,
    lang,
    occasion,
    bookTitle: book.title,
    maxPages: pageCap,
    intents: ai.intents,
    reserved: { pageIds: owned.pageIds, photoIds: owned.photoIds, pageCount: owned.pages.length },
    style: current?.meta?.story ? current.style : undefined,
    runId: ai.status === "used" ? runId : null,
  });
  const doc = mergeComposition({ fresh: fresh.doc, current, owned, design, storybookVersion: storybook.version });

  // --- validate the whole doc like an editor save -------------------------------------------------
  const stored = serializeDoc(doc);
  const reparsed = parseBookDoc(JSON.parse(JSON.stringify(stored)));
  const readyIds = new Set(rows.map((r) => r.id));
  const issues = reparsed.ok ? validateBookDoc(reparsed.doc, { photoIds: readyIds, maxPages: book.max_pages }) : reparsed.issues;
  if (issues.length > 0) throw new ComposeError("invalid_result", `${issues.length}_issues`);

  const report = { ...fresh.report, interiorPages: doc.pages.length, ai: { ...fresh.report.ai, status: ai.status, ignored: ai.ignored } };
  if (opts.dryRun) return { doc, report, rev: null };
  if (book.doc_rev === null) throw new ComposeError("saving_unavailable");
  if (opts.beforeSave && !(await opts.beforeSave())) return { doc, report, rev: null };
  const saved = await (deps.save ?? saveDocIfRev)(book.id, userId, stored as unknown as Json, doc.pages.length, book.doc_rev);
  if (!saved.ok) throw saved.reason === "conflict" ? new ComposeError("conflict", undefined, true) : new ComposeError("not_found");
  return { doc, report, rev: saved.rev };
}

type IntentArgs = {
  userId: string;
  book: ComposeBook;
  storybook: Storybook;
  photos: readonly ComposePhoto[];
  design: ReturnType<typeof bookDesignOf>;
  lang: "en" | "ar";
  runId: string;
  deps: ComposeDeps;
};

async function pageIntents(a: IntentArgs): Promise<{ intents: Map<string, PageIntentChoice> | undefined; status: ComposeAiStatus; ignored: number }> {
  const { deps } = a;
  const mode = deps.mode ?? resolveAiMode();
  if (mode === "off") return { intents: undefined, status: "off", ignored: 0 };
  const config = deps.config ?? readStoryAiConfig();
  const live = mode === "live";
  let canRecord = true;
  if (live) {
    // every check BEFORE the live call: usage table (2600 + 2700), per-book limit, daily budget
    if (!(await (deps.usageAvailable ?? storyUsageAvailable)())) return { intents: undefined, status: "usage_unavailable", ignored: 0 };
    const counts = await (deps.usageCounts ?? countStoryRuns)(a.book.id, a.userId);
    if ((counts.composes ?? 0) >= limitsFor(a.book.is_paid).maxStoryComposes) return { intents: undefined, status: "limit_reached", ignored: 0 };
    if (await (deps.budgetExhausted ?? defaultBudgetExhausted)()) return { intents: undefined, status: "budget_exhausted", ignored: 0 };
    if (await (deps.overSpendCap ?? defaultOverSpendCap)(a.userId, a.book.id)) return { intents: undefined, status: "budget_exhausted", ignored: 0 };
  } else canRecord = await (deps.usageAvailable ?? storyUsageAvailable)().catch(() => false);
  const transport = deps.transport === undefined ? transportFor(mode) : deps.transport;
  if (!transport) return { intents: undefined, status: "off", ignored: 0 };

  const req = composeUserText(a.storybook, a.photos, a.design, a.lang);
  let step: AgentStepRecord | null = null;
  const logger: StepLogger = {
    insertStep: async (row) => {
      step = row;
    },
    addRunTotals: async () => {},
    meter: deps.meter ?? createUsageMeter({ userId: a.userId, bookId: a.book.id, flow: "storybook", operation: "compose" }),
  };
  const result = await runAgentStep({
    runId: a.runId,
    agent: "storyteller",
    stepKey: "story-compose",
    inputSummary: { pages: req.pageIds.length, photos: a.photos.length, promptVersion: STORY_COMPOSE_PROMPT_VERSION },
    request: {
      agent: "storyteller",
      system: cachedSystem(STORY_COMPOSE_SYSTEM_PROMPT),
      messages: [{ role: "user", content: req.userText }],
      schema: ComposeIntentAiSchema,
      // selecting from a validated catalogue: low effort is enough (code re-checks everything)
      effort: "low",
      maxTokens: STORY_COMPOSE_MAX_TOKENS,
      model: config.model,
      timeoutMs: config.timeoutMs,
      scenarioMeta: req.meta,
    },
    strictSchema: ComposeIntentStrictSchema,
    toLogOutput: composeLogOutput,
    transport,
    logger,
    retry: { retries: config.retries, sleep: deps.sleep },
    now: deps.now ?? Date.now,
  });
  const logged = step as AgentStepRecord | null;
  if (canRecord) {
    const base = {
      userId: a.userId,
      bookId: a.book.id,
      runId: a.runId,
      kind: "compose" as const,
      scope: "compose" as const,
      chapterId: null,
      storybookVersion: a.storybook.version,
      model: config.model,
      promptVersion: STORY_COMPOSE_PROMPT_VERSION,
      mode: live ? ("live" as const) : ("replay" as const),
      usage: { input: logged?.inputTokens ?? 0, output: logged?.outputTokens ?? 0, cacheRead: logged?.cacheReadTokens ?? 0, cacheWrite: logged?.cacheWriteTokens ?? 0 },
      costUsd: live ? result.costUsd : 0,
      latencyMs: logged?.latencyMs ?? 0,
    };
    try {
      await (deps.record ?? recordStoryCall)(result.ok ? { ...base, status: "ok" } : { ...base, status: "error", error: String(result.code).replace(/[^a-z_]/g, "_") });
    } catch {
      console.error("[story-compose] record_failed");
    }
  }
  if (!result.ok) {
    if (result.status === "refused") return { intents: undefined, status: "refused", ignored: 0 };
    return { intents: undefined, status: result.code === "schema_invalid" || result.code === "parse_failed" ? "invalid" : "model_error", ignored: 0 };
  }
  const accepted = acceptIntents(result.data, req);
  return { intents: accepted.intents, status: "used", ignored: accepted.ignored };
}
