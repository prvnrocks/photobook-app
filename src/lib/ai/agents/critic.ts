// ④ Critic agent: the finished draft (structure + captions) and photo notes, text only → Critique.
// Pure async function over injected deps (transport, logger); the one model call goes through
// runAgentStep (one agent_steps row). What to repair is decided in code (src/lib/ai/repair.ts).
//
// Page references: the model sees `pageIndex` = index into doc.pages (0-based, cover excluded) and
// returns it in Critique.issues[].pageIndex. repair.ts maps it to the Caption Writer's captionKey
// ("m{n}:{k}") with pageCaptionKeys(doc).
//
// Privacy (D-027): input_summary has counts only; agent_steps.output = critiqueLogOutput (score,
// issue types, pageIndex, fix — never `detail`). Captions and notes go only to the model.

import type { BookDoc } from "@/lib/book/types";
import { clipText } from "@/lib/text/clip";
import { AGENT_TIMEOUT_MS, EFFORT } from "../client";
import type { CaptionIssue } from "../caption-check";
import { CRITIC_PROMPT_VERSION, criticSystem } from "../prompts/critic";
import { pageCaptionKeys } from "../repair";
import { runAgentStep, type RetryOptions, type StepLogger, type StepResult } from "../run-step";
import { CritiqueAiSchema, CritiqueStrictSchema, critiqueLogOutput, type Critique, type CritiqueAi } from "../schemas";
import { formatLocal, orientationOf, photoMs, type StoryBook, type StoryPhoto } from "../story";
import type { AgentRequest, AgentTransport } from "../transport";

/** Words of Curator description per photo line. */
export const CRITIC_DESCRIPTION_WORDS = 25;
/** Caption text shown to the Critic, UTF-16 units (doc captions are ≤ 200 anyway). */
const CAPTION_CHARS = 200;
const MAX_LIST = 30;

export interface CriticMetadata {
  /** books.title (the user's title) or null. */
  title: string | null;
  /** Places from the photos' GPS metadata (deduplicated in code). */
  places: readonly (string | null | undefined)[];
  /** Photo dates (ISO); only the range is sent. */
  dates: readonly (string | null | undefined)[];
  /** Names the user typed (user memory). */
  knownNames?: readonly string[];
}

/** Replay-only hints (never sent to the API) — consumed by critic-replay.ts. */
export interface CriticScenarioMeta {
  pageCount: number;
  pages: Array<{ pageIndex: number; key: string | null; source: "ai" | "user" | "auto" | null }>;
}

export interface CritiqueBookArgs {
  runId: string;
  /** Idempotency key, e.g. "critic". */
  stepKey: string;
  attempt: number;
  /** The draft with captions applied. */
  doc: BookDoc;
  /** Real photo id → alias ("p7"), the run's alias map (D-023). */
  aliasOf: ReadonlyMap<string, string>;
  /** Photo notes by real id (analysis, date, place, size). */
  photosById: ReadonlyMap<string, StoryPhoto>;
  metadata: CriticMetadata;
  /** checkBookCaptions result (captionKey → issues); only the codes are sent. */
  precheck: ReadonlyMap<string, readonly CaptionIssue[]>;
  book: Pick<StoryBook, "occasion" | "tone" | "captionLang">;
  transport: AgentTransport;
  logger: StepLogger;
  retry?: RetryOptions;
}

function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(/"/g, "'").replace(/\s+/g, " ").trim();
}
function firstWords(s: string, n: number): string {
  const words = oneLine(s).split(" ").filter(Boolean);
  return words.length <= n ? words.join(" ") : `${words.slice(0, n).join(" ")}…`;
}
const quoted = (s: string | null | undefined, max: number) => {
  const t = s ? clipText(oneLine(s), max) : "";
  return t ? `"${t}"` : "null";
};
function uniqueClean(values: readonly (string | null | undefined)[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v ? clipText(oneLine(v), max) : "";
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** Photo ids in doc order: cover first, then page slots (unique). */
export function docPhotoIds(doc: Pick<BookDoc, "cover" | "pages">): string[] {
  const ids = [doc.cover.photoId, ...doc.pages.flatMap((p) => p.slots.map((s) => s.photoId))];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

function dateRange(dates: readonly (string | null | undefined)[]): string {
  const ms = dates.map((d) => photoMs({ takenAt: d ?? null })).filter((n): n is number => n !== null);
  if (!ms.length) return "undated";
  const lo = formatLocal(Math.min(...ms)).slice(0, 10);
  const hi = formatLocal(Math.max(...ms)).slice(0, 10);
  return lo === hi ? lo : `${lo} to ${hi}`;
}

/** `p7 · 2026-10-12 18:22 · portrait · q8 · scene portrait · mood joyful · cover yes · place null · "…"` */
export function criticPhotoLine(alias: string, p: StoryPhoto | undefined): string {
  if (!p) return `${alias} · not analysed`;
  const a = p.analysis;
  return [
    alias,
    formatLocal(photoMs(p)),
    orientationOf(p.width, p.height),
    a ? `q${Math.round(a.quality)}` : "q?",
    `scene ${a?.scene ?? "unknown"}`,
    `mood ${a?.mood ?? "unknown"}`,
    `cover ${a?.coverWorthy ? "yes" : "no"}`,
    `place ${quoted(p.place, 80)}`,
    `"${a ? firstWords(a.description, CRITIC_DESCRIPTION_WORDS) || "no description" : "not analysed"}"`,
  ].join(" · ");
}

/** The per-request user message. Throws "missing alias" when a doc photo has no alias. */
export function buildCriticUserMessage(args: Pick<CritiqueBookArgs, "doc" | "aliasOf" | "photosById" | "metadata" | "precheck" | "book">): string {
  const { doc, aliasOf, photosById, metadata, precheck, book } = args;
  const alias = (id: string | null) => {
    if (!id) return "empty";
    const a = aliasOf.get(id);
    if (!a) throw new Error("missing alias");
    return a;
  };
  const places = uniqueClean(metadata.places, 80).slice(0, MAX_LIST);
  const names = uniqueClean(metadata.knownNames ?? [], 40).slice(0, MAX_LIST);
  const chapterIds = new Set(doc.chapters.map((c) => c.id));
  const keys = pageCaptionKeys(doc);

  const lines: string[] = [
    "BOOK",
    `occasion: ${book.occasion}`,
    `tone: ${book.tone}`,
    `caption language: ${book.captionLang}`,
    `user title: ${quoted(metadata.title, 80)}`,
    `places in metadata: ${places.length ? places.map((p) => `"${p}"`).join(", ") : "none"}`,
    `photo dates: ${dateRange(metadata.dates)}`,
    `KNOWN NAMES: ${names.length ? names.map((n) => `"${n}"`).join(", ") : "none"}`,
    "",
    "COVER",
    `photo ${doc.cover.photoId ? alias(doc.cover.photoId) : "none"} · title ${quoted(doc.cover.title, 80)} · subtitle ${quoted(doc.cover.subtitle, 120)}`,
    "",
    "CHAPTERS",
    ...doc.chapters.map((c) => `${c.id} · ${quoted(c.title, 80)} · ${c.dateLabel ? quoted(c.dateLabel, 40) : "undated"} · place ${quoted(c.place, 80)}`),
    "",
    `PAGES (${doc.pages.length}, pageIndex from 0)`,
    ...doc.pages.map((p, i) => {
      const cap = p.caption?.text?.trim()
        ? `[${p.caption.source === "user" ? "user" : "ai"}] ${quoted(p.caption.text, CAPTION_CHARS)}`
        : "none";
      const chapter = p.chapterId && chapterIds.has(p.chapterId) ? p.chapterId : "?";
      return `${i} · ${chapter} · ${p.layout} · ${p.slots.map((s) => alias(s.photoId)).join(" ")} · caption ${cap}`;
    }),
    "",
    "PHOTOS",
    ...docPhotoIds(doc).map((id) => criticPhotoLine(alias(id), photosById.get(id))),
  ];

  const flagged: string[] = [];
  keys.forEach((k, i) => {
    const codes = k ? (precheck.get(k) ?? []).map((x) => x.code) : [];
    if (codes.length) flagged.push(`page ${i}: ${[...new Set(codes)].join(", ")}`);
  });
  lines.push("", "ALREADY FLAGGED", ...(flagged.length ? flagged : ["none"]));
  return lines.join("\n");
}

/** Strict schema for this doc: every non-null pageIndex must be a page of the doc. */
export function critiqueStrictSchemaFor(pageCount: number) {
  return CritiqueStrictSchema.refine((c) => c.issues.every((i) => i.pageIndex === null || i.pageIndex < pageCount), {
    message: "pageIndex out of range",
    path: ["issues"],
  });
}

/** Output budget incl. thinking (Opus 5.5 always thinks). */
export function criticMaxTokens(pageCount: number): number {
  return Math.min(16_000, 8_000 + 40 * pageCount);
}

export function criticScenarioMeta(doc: Pick<BookDoc, "chapters" | "pages">): CriticScenarioMeta {
  const keys = pageCaptionKeys(doc);
  return {
    pageCount: doc.pages.length,
    pages: doc.pages.map((p, i) => ({ pageIndex: i, key: keys[i], source: p.caption?.source ?? null })),
  };
}

export function buildCriticRequest(
  args: Pick<CritiqueBookArgs, "doc" | "aliasOf" | "photosById" | "metadata" | "precheck" | "book">,
): AgentRequest<CritiqueAi> {
  return {
    agent: "critic",
    system: criticSystem(),
    messages: [{ role: "user", content: buildCriticUserMessage(args) }],
    schema: CritiqueAiSchema,
    effort: EFFORT.critic,
    maxTokens: criticMaxTokens(args.doc.pages.length),
    timeoutMs: AGENT_TIMEOUT_MS.critic,
    scenarioMeta: { ...criticScenarioMeta(args.doc) },
  };
}

/**
 * Critique the draft. Never throws for model/transport problems (typed StepResult); a failed or
 * refused critique means "no critique" for planRepair (pre-check targets only). Programmer errors
 * (no pages, a photo without an alias) return `bad_request` WITHOUT calling the model.
 */
export async function critiqueBook(args: CritiqueBookArgs): Promise<StepResult<Critique>> {
  const { doc } = args;
  if (doc.pages.length === 0 || docPhotoIds(doc).some((id) => !args.aliasOf.get(id))) {
    return { ok: false, status: "error", code: "bad_request", retryable: false, costUsd: 0 };
  }
  const request = buildCriticRequest(args);
  const captioned = doc.pages.filter((p) => p.caption?.text?.trim());
  return runAgentStep({
    runId: args.runId,
    agent: "critic",
    stepKey: args.stepKey,
    attempt: args.attempt,
    inputSummary: {
      promptVersion: CRITIC_PROMPT_VERSION,
      pages: doc.pages.length,
      chapters: doc.chapters.length,
      photos: docPhotoIds(doc).length,
      captions: captioned.length,
      userCaptions: captioned.filter((p) => p.caption?.source === "user").length,
      precheckFlagged: [...args.precheck.values()].filter((l) => l.length > 0).length,
      places: uniqueClean(args.metadata.places, 80).length,
      knownNames: (args.metadata.knownNames ?? []).length,
      captionLang: args.book.captionLang,
    },
    request,
    strictSchema: critiqueStrictSchemaFor(doc.pages.length),
    toLogOutput: critiqueLogOutput,
    transport: args.transport,
    logger: args.logger,
    retry: args.retry,
  });
}
