// ② Storyteller agent: kept-photo notes (text only, no images) → AlbumPlan (aliases).
// Pure async function over injected deps (transport, logger); every model call goes through
// runAgentStep (one agent_steps row). Validation against the photo set + conversion to a BookDoc
// is a separate pure step (src/lib/ai/plan-to-doc.ts) so the orchestrator can do
// "plan → validate → retry once with the issues → rule-based fallback".

import { AGENT_TIMEOUT_MS, EFFORT } from "../client";
import { STORYTELLER_PROMPT_VERSION, storytellerSystem } from "../prompts/storyteller";
import { runAgentStep, type RetryOptions, type StepLogger, type StepResult } from "../run-step";
import { DEFAULT_BOOK_DESIGN, type BookDesign } from "@/lib/book/book-design";
import { clipText } from "@/lib/text/clip";
import { isEmptyMemory, memoryPromptBlock, sanitizeMemory } from "../memory";
import {
  AlbumPlanAiSchema,
  AlbumPlanStrictSchema,
  type AlbumPlan,
  type AlbumPlanAi,
  type UserMemory,
} from "../schemas";
import {
  byStoryTime,
  effectiveMaxPages,
  formatLocal,
  orientationOf,
  photoMs,
  type StoryBook,
  type StoryPhoto,
} from "../story";
import type { AgentRequest, AgentTransport } from "../transport";

/** Words of Curator description per photo line. */
export const MAX_DESCRIPTION_WORDS = 25;
/** Max previous-plan issues echoed back on a retry. */
export const MAX_RETRY_ISSUES = 20;

/** Replay-only hints (never sent to the API) — consumed by storyteller-replay.ts. */
export interface StorytellerScenarioMeta {
  photos: Array<{
    alias: string;
    ms: number | null;
    orientation: "portrait" | "landscape" | "square";
    quality: number;
    cover: boolean;
    place: string | null;
  }>;
  maxPages: number;
  userTitle: string | null;
  captionLang: StoryBook["captionLang"];
  occasion: StoryBook["occasion"];
  /** books.format / books.design_style (M10b A11): the replay synthesiser plans with this design's layouts. */
  design?: BookDesign;
}

export interface PlanAlbumArgs {
  runId: string;
  /** Idempotency key, e.g. "storyteller". The retry uses the same key with attempt 2. */
  stepKey: string;
  attempt: number;
  /** All photos of the book; only `keep` ones are sent. */
  photos: readonly StoryPhoto[];
  book: StoryBook;
  /** Real photo id → alias ("p7"), the same map used for the Curator (D-023). */
  aliasOf: ReadonlyMap<string, string>;
  transport: AgentTransport;
  logger: StepLogger;
  /** Issues from validatePlanAgainstPhotos / planToDoc of the previous attempt. */
  previousIssues?: readonly string[];
  /**
   * The user's learned preferences (D-032). Rendered into the USER message only — the cached
   * system prompt is byte-identical with or without it. Optional; null/empty → no block.
   */
  memory?: UserMemory | null;
  /**
   * The book's format + design style (bookDesignOf(book), D-063): picks the system prompt +
   * layout catalogue (one stable cached prefix per design). Default classic A5 portrait.
   */
  design?: BookDesign;
  retry?: RetryOptions;
}

const MEMORY_KEYS = ["tonePreference", "captionLength", "language", "knownNames", "avoid"] as const;

/** Which memory keys carry a usable value (for agent_steps.input_summary — never the values). */
export function memoryKeysOf(memory: UserMemory | null | undefined): string[] {
  if (!memory) return [];
  const mem = sanitizeMemory(memory);
  if (isEmptyMemory(mem)) return [];
  return MEMORY_KEYS.filter((k) => {
    const v = mem[k];
    return Array.isArray(v) ? v.length > 0 : v !== undefined;
  });
}

/** One line of model-facing text: no newlines, no double quotes, collapsed whitespace. */
function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(/"/g, "'").replace(/\s+/g, " ").trim();
}

function firstWords(s: string, n: number): string {
  const words = oneLine(s).split(" ").filter(Boolean);
  return words.length <= n ? words.join(" ") : `${words.slice(0, n).join(" ")}…`;
}

export function keptInStoryOrder(photos: readonly StoryPhoto[]): StoryPhoto[] {
  return photos.filter((p) => p.keep).sort(byStoryTime);
}

/** `p7 · 2026-10-12 18:22 · portrait · q8 · scene portrait · mood joyful · cover yes · place null · "…"` */
export function photoLine(alias: string, p: StoryPhoto): string {
  const a = p.analysis;
  const place = p.place && oneLine(p.place) ? `"${clipText(oneLine(p.place), 80)}"` : "null";
  const parts = [
    alias,
    formatLocal(photoMs(p)),
    orientationOf(p.width, p.height),
    a ? `q${Math.round(a.quality)}` : "q?",
    `scene ${a?.scene ?? "unknown"}`,
    `mood ${a?.mood ?? "unknown"}`,
    `cover ${a?.coverWorthy ? "yes" : "no"}`,
    `place ${place}`,
    `"${a ? firstWords(a.description, MAX_DESCRIPTION_WORDS) || "no description" : "not analysed"}"`,
  ];
  return parts.join(" · ");
}

/** The per-request user message (book info + photo lines + optional retry issues). */
export function buildStorytellerUserMessage(
  photos: readonly StoryPhoto[],
  book: StoryBook,
  aliasOf: ReadonlyMap<string, string>,
  previousIssues?: readonly string[],
  memory?: UserMemory | null,
): string {
  const kept = keptInStoryOrder(photos);
  const memoryBlock = memory ? memoryPromptBlock(memory) : "";
  const userTitle = book.title && oneLine(book.title) ? `"${oneLine(book.title)}"` : "null";
  const lines = [
    "BOOK",
    `occasion: ${book.occasion}`,
    `tone: ${book.tone}`,
    `caption language: ${book.captionLang}`,
    `user title: ${userTitle}`,
    `maxPages: ${effectiveMaxPages(book)}`,
    `kept photos: ${kept.length}`,
    ...(memoryBlock ? ["", memoryBlock] : []),
    "",
    "PHOTOS (time order, undated last)",
    ...kept.map((p) => photoLine(aliasOf.get(p.id) as string, p)),
  ];
  if (previousIssues && previousIssues.length) {
    const shown = previousIssues.slice(0, MAX_RETRY_ISSUES).map((i) => `- ${clipText(i.replace(/\s+/g, " ").trim(), 200)}`);
    const more = previousIssues.length - shown.length;
    lines.push(
      "",
      "Your previous plan had these problems:",
      ...shown,
      ...(more > 0 ? [`- …and ${more} more of the same kind`] : []),
      "Fix all of them and return a complete new plan.",
    );
  }
  return lines.join("\n");
}

export function storytellerScenarioMeta(
  photos: readonly StoryPhoto[],
  book: StoryBook,
  aliasOf: ReadonlyMap<string, string>,
  design: BookDesign = DEFAULT_BOOK_DESIGN,
): StorytellerScenarioMeta {
  return {
    photos: keptInStoryOrder(photos).map((p) => ({
      alias: aliasOf.get(p.id) as string,
      ms: photoMs(p),
      orientation: orientationOf(p.width, p.height),
      quality: p.analysis ? Math.round(p.analysis.quality) : 5,
      cover: p.analysis?.coverWorthy ?? false,
      place: p.place?.trim() ? p.place.trim() : null,
    })),
    maxPages: effectiveMaxPages(book),
    userTitle: book.title?.trim() ? book.title.trim() : null,
    captionLang: book.captionLang,
    occasion: book.occasion,
    design: { format: design.format, designStyle: design.designStyle },
  };
}

/** Output budget incl. thinking (Opus 5.5 always thinks); stays well under the SDK non-streaming cap. */
export function storytellerMaxTokens(keptCount: number): number {
  return Math.min(16_000, 6_000 + 50 * keptCount);
}

/** Privacy-safe projection for agent_steps.output (D-027): structure only, no titles/places. */
export function planLogOutput(plan: AlbumPlan) {
  return {
    cover: plan.coverPhotoId,
    pageCount: plan.moments.reduce((n, m) => n + m.pages.length, 0),
    moments: plan.moments.map((m) => ({
      id: m.id,
      hasPlace: m.place !== null,
      pages: m.pages.map((pg) => ({ l: pg.layoutId, p: pg.photoIds })),
    })),
  };
}

export function buildStorytellerRequest(
  args: Pick<PlanAlbumArgs, "photos" | "book" | "aliasOf" | "previousIssues" | "memory" | "design">,
): AgentRequest<AlbumPlanAi> {
  const kept = keptInStoryOrder(args.photos);
  return {
    agent: "storyteller",
    system: storytellerSystem(args.design ?? DEFAULT_BOOK_DESIGN),
    messages: [{ role: "user", content: buildStorytellerUserMessage(args.photos, args.book, args.aliasOf, args.previousIssues, args.memory) }],
    schema: AlbumPlanAiSchema,
    effort: EFFORT.storyteller,
    maxTokens: storytellerMaxTokens(kept.length),
    timeoutMs: AGENT_TIMEOUT_MS.storyteller,
    scenarioMeta: { ...storytellerScenarioMeta(args.photos, args.book, args.aliasOf, args.design ?? DEFAULT_BOOK_DESIGN) },
  };
}

/**
 * Plan the album. Never throws for model/transport problems (typed StepResult). Programmer
 * errors (no kept photos, a kept photo without an alias) return `bad_request` WITHOUT calling
 * the model — the orchestrator treats it like any failure and uses the rule-based album.
 */
export async function planAlbum(args: PlanAlbumArgs): Promise<StepResult<AlbumPlan>> {
  const kept = keptInStoryOrder(args.photos);
  if (kept.length === 0 || kept.some((p) => !args.aliasOf.get(p.id))) {
    return { ok: false, status: "error", code: "bad_request", retryable: false, costUsd: 0 };
  }

  const request = buildStorytellerRequest(args);
  return runAgentStep({
    runId: args.runId,
    agent: "storyteller",
    stepKey: args.stepKey,
    attempt: args.attempt,
    inputSummary: {
      promptVersion: STORYTELLER_PROMPT_VERSION,
      keptPhotos: kept.length,
      datedPhotos: kept.filter((p) => photoMs(p) !== null).length,
      photosWithPlace: kept.filter((p) => p.place?.trim()).length,
      maxPages: effectiveMaxPages(args.book),
      occasion: args.book.occasion,
      captionLang: args.book.captionLang,
      hasUserTitle: Boolean(args.book.title?.trim()),
      previousIssueCount: args.previousIssues?.length ?? 0,
      memoryKeys: memoryKeysOf(args.memory),
    },
    request,
    strictSchema: AlbumPlanStrictSchema,
    toLogOutput: planLogOutput,
    transport: args.transport,
    logger: args.logger,
    retry: args.retry,
  });
}
