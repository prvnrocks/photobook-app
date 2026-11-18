// ✨ Rewriter agent (M5, docs/AI-AGENTS.md → Rewriter, D-037 #6/#8): one caption + an instruction
// (rewrite | shorter | tone:<Tone> | translate) → one new caption in the target language.
// Pure async function over injected deps; every model call goes through runAgentStep (one
// agent_steps row per attempt, agent 'rewriter'). Never throws for model/transport problems.
//
// Flow: attempt 1 → code pre-check (D-030 checkCaption against the doc caption context for the
// target language + names/numbers that appear in the input caption, plus rewrite-specific checks
// `not_shorter` / `unchanged`). On a failed check (or unparseable output) ONE retry carrying the
// issue codes; still failing → { ok:false, code:"rewrite_unusable" }. Refusal, max_tokens and
// transport errors are returned as-is (no retry beyond runAgentStep's transport retries).
//
// Chapter descriptions (M30 T11): `input.target === "description"` rewrites a chapter description
// instead of a page caption — same function, same flow, same limits (the route counts it like a
// caption rewrite). It uses the variant system prompt + schema (prompts/rewriter.ts), a 45-word /
// 400-unit pre-check (checkBookDescriptions: script, names, numbers, no verbatim chapter title /
// caption / other description) and REWRITER_DESCRIPTION_MAX_TOKENS. Caption rewrites are untouched.
//
// Privacy (D-027): the prompt carries the caption, text-only photo notes (no images, D-037 #8)
// and the memory block. agent_steps.input_summary holds instruction, langs, lengths, counts and
// memory KEYS; agent_steps.output = rewriteLogOutput (lang, word/char counts, issue codes). Never
// caption text, photo notes or memory values.

import type { BookDoc } from "@/lib/book/types";
import type { CaptionLang } from "@/lib/book/options";
import { clipText } from "@/lib/text/clip";
import { AGENT_TIMEOUT_MS, EFFORT } from "../client";
import {
  buildCaptionContext,
  checkBookDescriptions,
  checkCaption,
  nameWords,
  normalizeCaption,
  normalizeNumber,
  type CaptionCheckContext,
  type CaptionIssueCode,
} from "../caption-check";
import { docCaptionContext } from "../captions";
import { memoryPromptBlock } from "../memory";
import { REWRITER_DESCRIPTIONS_PROMPT_VERSION, REWRITER_PROMPT_VERSION, rewriterSystemFor } from "../prompts/rewriter";
import { runAgentStep, type RetryOptions, type StepErrorCode, type StepLogger } from "../run-step";
import {
  AI_TEXT_LIMITS,
  REWRITE_INSTRUCTIONS,
  RewriteDescriptionOutputAiSchema,
  RewriteDescriptionOutputStrictSchema,
  RewriteOutputAiSchema,
  RewriteOutputStrictSchema,
  rewriteLogOutput,
  wordCount,
  type RewriteInstruction,
  type RewriteOutput,
  type RewriteOutputAi,
  type RewriteTarget,
  type UserMemory,
} from "../schemas";
import type { StoryBook, StoryPhoto } from "../story";
import type { AgentRequest, AgentTransport } from "../transport";
import { memoryKeysOf } from "./caption-writer";

export { REWRITER_DESCRIPTIONS_PROMPT_VERSION, REWRITER_PROMPT_VERSION };

/** Output budget incl. thinking (Opus 5.5 always thinks; effort low, one short caption). */
export const REWRITER_MAX_TOKENS = 2_000;
/** Same for a chapter description (≤ 45 words; Arabic ≈ 3 tokens a word) — the variant only. */
export const REWRITER_DESCRIPTION_MAX_TOKENS = 3_000;
/** Words of Curator description per photo note. */
export const REWRITER_DESCRIPTION_WORDS = 25;
/** Photo notes per request (a page has ≤ 8 slots). */
export const REWRITER_MAX_NOTES = 8;
/** Model calls per rewrite: first try + one retry with issue codes. */
export const REWRITER_MAX_ATTEMPTS = 2;

export const REWRITE_ISSUE_CODES = ["not_shorter", "unchanged"] as const;
export type RewriteIssueCode = CaptionIssueCode | (typeof REWRITE_ISSUE_CODES)[number];
export type RewriteIssue = { code: RewriteIssueCode };

export type RewriteErrorCode = "rewrite_unusable" | "bad_input" | StepErrorCode;

export type RewriteBook = Pick<StoryBook, "occasion" | "tone" | "captionLang" | "title">;
/** One photo of the page: text notes only (D-037 #8). Build with analysisOf(photos.ai). */
export type RewritePhoto = Pick<StoryPhoto, "takenAt" | "place" | "analysis">;

export interface RewriteInput {
  /**
   * What `text` is: a page caption (default) or (M30 T11) a chapter description. "description"
   * switches the prompt / schema variant, the 45-word pre-check and the message layout; `pagePhotos`
   * then holds photos of the whole chapter.
   */
  target?: RewriteTarget;
  /** target "description": the chapter (title is AI text — shown to the model, never allowlisted). */
  chapter?: { title: string; dateLabel: string; place: string | null } | null;
  /** target "description": captions of the book the new text must not repeat verbatim. */
  captions?: readonly string[];
  /** target "description": the other chapters' descriptions (duplicate guard). */
  otherDescriptions?: readonly string[];
  /** The caption (or chapter description) to change (any source). */
  text: string;
  instruction: RewriteInstruction;
  /** Language of the result. For "translate" use translateTarget(text). */
  targetLang: CaptionLang;
  /** books.occasion / tone / caption_lang and books.title (the USER's title — names allowlist). */
  book: RewriteBook;
  /** Current book doc: chapter places + date-label numbers feed the pre-check (docCaptionContext). */
  doc: Pick<BookDoc, "chapters">;
  /** Photos on the page (text notes; GPS place + date feed the pre-check). */
  pagePhotos: readonly RewritePhoto[];
  /** user_memory snapshot (prompt data + knownNames allowlist). */
  memory?: UserMemory | null;
}

export interface RewriteDeps {
  transport: AgentTransport;
  logger: StepLogger;
  /** Transport retries/deadline (default: 1 retry). Pass the route's deadline. */
  retry?: RetryOptions;
}

export interface RewriteCaptionArgs {
  ctx: RewriteDeps;
  /** agent_runs.id of the rewrite run (trigger 'rewrite'). */
  runId: string;
  input: RewriteInput;
}

export type RewriteResult =
  | { ok: true; text: string; lang: CaptionLang; attempts: number; costUsd: number }
  | { ok: false; code: RewriteErrorCode; retryable: boolean; attempts: number; costUsd: number };

/** Replay-only hints (never sent to the API, never logged) — consumed by rewriter-replay.ts. */
export interface RewriterScenarioMeta {
  instruction: RewriteInstruction;
  targetLang: CaptionLang;
  tone: RewriteBook["tone"];
  inputWords: number;
  /** Code points of the input caption. */
  inputChars: number;
  /** Small numeric hash of the input (varies the pick per caption; not the text). */
  inputHash: number;
  attempt: number;
  /** M30 T11: set (to "description") only on chapter-description rewrites. */
  target?: RewriteTarget;
}

// ---------------------------------------------------------------------------- helpers

const ARABIC_LETTER_G = /[ؠ-ؿف-يٱ-ۓەۺ-ۼۿݐ-ݿࢠ-ࣉﭐ-ﷻﹰ-ﻼ]/g;
const LATIN_LETTER_G = /[A-Za-zÀ-ɏ]/g;
const DIGIT_RUN_G = /[0-9٠-٩۰-۹]+/g;

/** Dominant script of a caption: "ar" when Arabic letters outnumber Latin ones, else "en". */
export function detectCaptionLang(text: string): CaptionLang {
  const ar = (text.match(ARABIC_LETTER_G) ?? []).length;
  const la = (text.match(LATIN_LETTER_G) ?? []).length;
  return ar > la ? "ar" : "en";
}

/** Target language of a translate request: the other language (EN↔AR). */
export function translateTarget(text: string): CaptionLang {
  return detectCaptionLang(text) === "ar" ? "en" : "ar";
}

export function isRewriteInstruction(v: unknown): v is RewriteInstruction {
  return typeof v === "string" && (REWRITE_INSTRUCTIONS as readonly string[]).includes(v);
}

const codePoints = (s: string) => Array.from(s).length;
const isDescription = (input: Pick<RewriteInput, "target">) => input.target === "description";
/** Collapsed, trimmed and clipped to the target's doc limit (caption 200, description 400 units). */
const cleanFor = (input: Pick<RewriteInput, "target">, s: string) =>
  clipText(s.replace(/\s+/g, " ").trim(), isDescription(input) ? AI_TEXT_LIMITS.chapterDescription : AI_TEXT_LIMITS.caption);
const cleanText = (s: string) => cleanFor({}, s);
/** A model answer before the pre-check: a description is NOT clipped to 400 (over-long → too_long). */
const cleanCandidate = (input: Pick<RewriteInput, "target">, s: string) =>
  isDescription(input) ? clipText(s.replace(/\s+/g, " ").trim(), AI_TEXT_LIMITS.chapterDescription * 3) : cleanText(s);

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
/** JSON-quote user text; escape <, > so it can't look like a tag. */
const jsonQuote = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const LANG_NAME: Record<CaptionLang, string> = { en: "English", ar: "Arabic" };

/** `p2 "two people laughing" (group, joyful, place "Abu Dhabi")` */
function photoNote(i: number, p: RewritePhoto): string {
  const a = p.analysis;
  const desc = a ? firstWords(a.description, REWRITER_DESCRIPTION_WORDS) || "no description" : "not analysed";
  const tags = [a?.scene ?? "unknown", a?.mood ?? "unknown"];
  if (p.place && oneLine(p.place)) tags.push(`place ${quoted(p.place, AI_TEXT_LIMITS.place)}`);
  return `- p${i + 1} "${desc}" (${tags.join(", ")})`;
}

// ---------------------------------------------------------------------------- pre-check

/**
 * Pre-check context for the target language: docCaptionContext (chapter places, date-label
 * numbers) + the user's title, the page photos' places/dates, knownNames, and the names and
 * numbers that appear in the input caption (not invented if they were already there).
 */
export function rewriteCheckContext(input: Pick<RewriteInput, "text" | "targetLang" | "book" | "doc" | "pagePhotos" | "memory">): CaptionCheckContext {
  const docCtx = docCaptionContext(input.doc as BookDoc, input.targetLang);
  const meta = buildCaptionContext({
    lang: input.targetLang,
    bookTitle: input.book.title,
    photoPlaces: input.pagePhotos.map((p) => p.place),
    knownNames: input.memory?.knownNames ?? [],
    dates: input.pagePhotos.map((p) => p.takenAt),
  });
  const allowNames = new Set([...docCtx.allowNames, ...meta.allowNames, ...nameWords([input.text])]);
  const allowDigits = new Set([...docCtx.allowDigits, ...meta.allowDigits]);
  for (const run of input.text.match(DIGIT_RUN_G) ?? []) allowDigits.add(normalizeNumber(run));
  return { lang: input.targetLang, allowNames, allowDigits, allowMonths: undefined };
}

/** All issues of a candidate rewrite (codes only). [] = usable. Pure; exported for tests. */
export function checkRewrite(
  out: string,
  input: Pick<RewriteInput, "text" | "instruction" | "targetLang"> & Partial<Pick<RewriteInput, "target" | "chapter" | "captions" | "otherDescriptions">>,
  ctx: CaptionCheckContext,
): RewriteIssue[] {
  const base = isDescription(input)
    ? (checkBookDescriptions([{ key: "desc", text: out, titles: [input.chapter?.title] }], ctx, {
        captions: input.captions,
        otherDescriptions: input.otherDescriptions,
      }).get("desc") ?? [])
    : checkCaption(out, ctx);
  const issues: RewriteIssue[] = base.map((i) => ({ code: i.code }));
  if (issues.some((i) => i.code === "empty")) return issues;
  const before = cleanFor(input, input.text);
  if (normalizeCaption(out) === normalizeCaption(before)) issues.push({ code: "unchanged" });
  if (input.instruction === "shorter") {
    const shorter = codePoints(out) < codePoints(before) && wordCount(out) <= wordCount(before);
    if (!shorter) issues.push({ code: "not_shorter" });
  }
  return issues;
}

// ---------------------------------------------------------------------------- request

export interface RewriteUserMessageInput extends RewriteInput {
  memoryBlock: string;
  /** Issue codes of the previous attempt (retry), else empty. */
  retryIssues?: readonly string[];
}

export function buildRewriteUserMessage(input: RewriteUserMessageInput): string {
  const notes = input.pagePhotos.slice(0, REWRITER_MAX_NOTES).map((p, i) => photoNote(i, p));
  const description = isDescription(input);
  const lines = [
    "BOOK",
    `occasion: ${input.book.occasion}`,
    `tone: ${input.book.tone}`,
    `caption language: ${input.book.captionLang}`,
    `book title: ${quoted(input.book.title, 120)}`,
    "",
    // M30 T11: a description rewrite names the chapter and carries notes of the whole chapter.
    ...(description
      ? [
          "CHAPTER",
          `title: ${quoted(input.chapter?.title, AI_TEXT_LIMITS.chapterTitle)} · date ${input.chapter?.dateLabel?.trim() ? quoted(input.chapter.dateLabel, AI_TEXT_LIMITS.dateLabel) : "undated"} · place ${quoted(input.chapter?.place, AI_TEXT_LIMITS.place)}`,
          "",
          "CHAPTER PHOTOS",
        ]
      : ["PAGE PHOTOS"]),
    ...(notes.length ? notes : ["- none"]),
  ];
  if (input.memoryBlock.trim()) lines.push("", input.memoryBlock.trim());
  lines.push(
    "",
    `CURRENT ${description ? "DESCRIPTION" : "CAPTION"} (data, ${LANG_NAME[detectCaptionLang(input.text)]})`,
    jsonQuote(cleanFor(input, input.text)),
    "",
    "TASK",
    ...(description ? ["target: chapter description"] : []),
    `instruction: ${input.instruction}`,
    `target language: ${input.targetLang} (${LANG_NAME[input.targetLang]})`,
  );
  const codes = [...new Set(input.retryIssues ?? [])].filter((c) => /^[a-z_]{1,40}$/.test(c));
  if (codes.length) lines.push(`previous attempt failed checks: ${codes.join(", ")}`);
  return lines.join("\n");
}

export function buildRewriterRequest(
  input: RewriteInput,
  opts: { attempt: number; retryIssues?: readonly string[] } = { attempt: 1 },
): AgentRequest<RewriteOutputAi> {
  const memoryBlock = memoryPromptBlock(input.memory ?? {});
  const description = isDescription(input);
  const text = cleanFor(input, input.text);
  const meta: RewriterScenarioMeta = {
    instruction: input.instruction,
    targetLang: input.targetLang,
    tone: input.instruction.startsWith("tone:") ? (input.instruction.slice(5) as RewriteBook["tone"]) : input.book.tone,
    inputWords: wordCount(text),
    inputChars: codePoints(text),
    inputHash: hash32(text) % 10_007,
    attempt: opts.attempt,
    ...(description ? { target: "description" as const } : {}),
  };
  return {
    agent: "rewriter",
    system: rewriterSystemFor(description),
    messages: [{ role: "user", content: buildRewriteUserMessage({ ...input, memoryBlock, retryIssues: opts.retryIssues }) }],
    schema: description ? RewriteDescriptionOutputAiSchema : RewriteOutputAiSchema,
    effort: EFFORT.rewriter,
    maxTokens: description ? REWRITER_DESCRIPTION_MAX_TOKENS : REWRITER_MAX_TOKENS,
    timeoutMs: AGENT_TIMEOUT_MS.rewriter,
    scenarioMeta: { ...meta },
  };
}

// ---------------------------------------------------------------------------- the call

/** Retry the call once for these step failures (the model answered, but unusably). */
const RETRY_ON: ReadonlySet<StepErrorCode> = new Set(["parse_failed", "schema_invalid"]);

/**
 * Rewrite one caption — or, with `input.target === "description"`, one chapter description (≤ 45
 * words). Returns `{ ok:true, text, lang }` with a pre-checked caption in `lang`
 * (= input.targetLang), or `{ ok:false, code }`:
 * - "bad_input": empty caption, unknown instruction, or translate into the caption's own language
 *   (no model call, no agent_steps row);
 * - "rewrite_unusable": both attempts failed the pre-check / parse;
 * - "refusal" | "max_tokens" | "context_window_exceeded" | transport codes ("rate_limited",
 *   "timeout", …; `retryable` tells whether "Try again" makes sense).
 * Only `ok:true` should count toward the rewrite limit (D-037 #6).
 */
export async function rewriteCaption({ ctx, runId, input }: RewriteCaptionArgs): Promise<RewriteResult> {
  const description = isDescription(input);
  const text = typeof input.text === "string" ? cleanFor(input, input.text) : "";
  const badInput =
    !text ||
    (input.target !== undefined && input.target !== "caption" && input.target !== "description") ||
    !isRewriteInstruction(input.instruction) ||
    (input.targetLang !== "en" && input.targetLang !== "ar") ||
    (input.instruction === "translate" && detectCaptionLang(text) === input.targetLang);
  if (badInput) return { ok: false, code: "bad_input", retryable: false, attempts: 0, costUsd: 0 };

  const checkCtx = rewriteCheckContext(input);
  const memoryBlock = memoryPromptBlock(input.memory ?? {});
  let costUsd = 0;
  let retryIssues: string[] = [];

  for (let attempt = 1; attempt <= REWRITER_MAX_ATTEMPTS; attempt++) {
    let issues: RewriteIssue[] = [];
    let candidate = "";
    const result = await runAgentStep({
      runId,
      agent: "rewriter",
      stepKey: "rewriter",
      attempt,
      inputSummary: {
        promptVersion: REWRITER_PROMPT_VERSION,
        instruction: input.instruction,
        sourceLang: detectCaptionLang(text),
        targetLang: input.targetLang,
        inputWords: wordCount(text),
        inputChars: codePoints(text),
        photoNotes: Math.min(input.pagePhotos.length, REWRITER_MAX_NOTES),
        memoryKeys: memoryKeysOf(input.memory, memoryBlock),
        retryIssues,
        // M30 T11: only on chapter-description rewrites (a kind and a version — never text).
        ...(description ? { target: "description", descriptionsPromptVersion: REWRITER_DESCRIPTIONS_PROMPT_VERSION } : {}),
      },
      request: buildRewriterRequest(input, { attempt, retryIssues }),
      strictSchema: description ? RewriteDescriptionOutputStrictSchema : RewriteOutputStrictSchema,
      toLogOutput: (data: RewriteOutput) => {
        candidate = cleanCandidate(input, data.text);
        issues = checkRewrite(candidate, input, checkCtx);
        return rewriteLogOutput({ text: candidate }, input.targetLang, issues);
      },
      transport: ctx.transport,
      logger: ctx.logger,
      retry: ctx.retry ?? { retries: 1 },
    });
    costUsd += result.costUsd;

    if (!result.ok) {
      if (RETRY_ON.has(result.code) && attempt < REWRITER_MAX_ATTEMPTS) {
        retryIssues = ["empty"];
        continue;
      }
      const code: RewriteErrorCode = RETRY_ON.has(result.code) ? "rewrite_unusable" : result.code;
      return { ok: false, code, retryable: result.retryable, attempts: attempt, costUsd };
    }
    if (!candidate) {
      // toLogOutput threw (never expected) — check here so a bad caption can't slip through.
      candidate = cleanCandidate(input, result.data.text);
      issues = checkRewrite(candidate, input, checkCtx);
    }
    if (issues.length === 0) return { ok: true, text: candidate, lang: input.targetLang, attempts: attempt, costUsd };
    retryIssues = [...new Set(issues.map((i) => i.code))];
  }
  return { ok: false, code: "rewrite_unusable", retryable: false, attempts: REWRITER_MAX_ATTEMPTS, costUsd };
}
