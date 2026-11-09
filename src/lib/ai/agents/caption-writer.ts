// ③ Caption Writer agent (D-029/D-030): one batch of consecutive moments (≤ 12 captionable pages,
// see src/lib/ai/captions.ts) → one heading per moment + one original line per page.
// Pure async function over injected deps; exactly one runAgentStep (→ one agent_steps row) per
// call. Never throws for model/transport problems: `ok: false` + `failure`, no captions.
//
// After a valid answer every caption/heading goes through the deterministic pre-check
// (caption-check.ts). Failing ones are NOT returned in `captions`/`headings`; their issue codes are
// in `issues` (keyed by captionKey) for the targeted repair round (T11).
//
// Privacy (D-027): the prompt carries text-only photo notes (no images); the step log holds ids,
// word counts, lang and issue codes only (captionLogOutput) and input_summary holds counts + the
// memory KEYS — never caption text, headings, descriptions or memory values.

import { AGENT_TIMEOUT_MS, EFFORT } from "../client";
import {
  buildCaptionContext,
  checkBookCaptions,
  type CaptionIssue,
  type CaptionIssueCode,
} from "../caption-check";
import { checkHeading, type CaptionBatchSpec } from "../captions";
import { MEMORY_BLOCK_HEADER, memoryPromptBlock } from "../memory";
import { CAPTION_WRITER_PROMPT_VERSION, captionWriterSystem } from "../prompts/caption-writer";
import { runAgentStep, type RetryOptions, type StepErrorCode, type StepLogger } from "../run-step";
import {
  AI_TEXT_LIMITS,
  CaptionBatchAiSchema,
  CaptionBatchStrictSchema,
  captionKey,
  captionLogOutput,
  PHOTO_ALIAS_RE,
  type CaptionBatch,
  type CaptionBatchAi,
  type CaptionLength,
  type UserMemory,
} from "../schemas";
import type { StoryBook, StoryPhoto } from "../story";
import type { AgentRequest, AgentTransport } from "../transport";
import { clipText } from "@/lib/text/clip";

export { CAPTION_WRITER_PROMPT_VERSION };

/** Words of Curator description per photo in the prompt. */
export const MAX_DESCRIPTION_WORDS = 25;
/** Max earlier captions echoed in the prompt (repetition guard). */
export const MAX_OTHER_CAPTIONS = 40;

export type CaptionBook = Pick<StoryBook, "occasion" | "tone" | "captionLang" | "title">;

export interface RepairTarget {
  /** captionKey, e.g. "m2:1" or "m2:heading". */
  key: string;
  /** Reason code(s): CaptionIssueCode or a Critic issue type (e.g. caption_mismatch). */
  reason: string | readonly string[];
}

/** Replay-only hints (never sent to the API) — consumed by caption-writer-replay.ts. */
export interface CaptionWriterScenarioMeta {
  lang: CaptionBook["captionLang"];
  tone: CaptionBook["tone"];
  occasion: CaptionBook["occasion"];
  captionLength: CaptionLength | null;
  batchIndex: number;
  attempt: number;
  moments: Array<{
    momentId: string;
    wantHeading: boolean;
    pages: Array<{ key: string; pageIndex: number; ordinal: number; scene: string | null; mood: string | null; place: string | null }>;
  }>;
  /** Keys to rewrite (repair round), else null. */
  repair: string[] | null;
}

export interface WriteCaptionsArgs {
  runId: string;
  /** e.g. "caption_writer:0" or "caption_writer:repair:0". */
  stepKey: string;
  attempt: number;
  spec: CaptionBatchSpec;
  book: CaptionBook;
  /** Keyed by the photo ids used in the spec (doc → real ids). */
  photosById: ReadonlyMap<string, StoryPhoto>;
  /** Run alias map (D-023). Missing ids get batch-local aliases p1, p2, … */
  aliasOf?: ReadonlyMap<string, string>;
  /** memoryPromptBlock(memory); computed from `memory` when omitted. "" = none. */
  memoryBlock?: string;
  /** Memory snapshot: knownNames feed the pre-check allowlist; keys go to input_summary. */
  memory?: UserMemory | null;
  /** Captions already in the book (other batches) — repetition guard in prompt + pre-check. */
  otherCaptions?: readonly string[];
  /** Repair round: rewrite only these keys. */
  repairTargets?: readonly RepairTarget[];
  transport: AgentTransport;
  logger: StepLogger;
  retry?: RetryOptions;
}

export interface WriteCaptionsFailure {
  status: "refused" | "error";
  code: StepErrorCode;
  retryable: boolean;
}

export interface WriteCaptionsResult {
  ok: boolean;
  /** captionKey → clean text (passed the pre-check). */
  captions: Map<string, string>;
  /** momentId → clean heading (passed the heading check). */
  headings: Map<string, string>;
  /** captionKey (page or "mX:heading") → issues. Missing captions get code "empty". */
  issues: Map<string, CaptionIssue[]>;
  failure?: WriteCaptionsFailure;
  costUsd: number;
}

// ---------------------------------------------------------------------------- prompt helpers

/** One line of model-facing text: no newlines, no double quotes, collapsed whitespace. */
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

const REASON_RE = /^[a-z_]{1,40}$/;

function reasonList(r: RepairTarget["reason"]): string[] {
  const list = typeof r === "string" ? [r] : [...r];
  return list.filter((x) => typeof x === "string" && REASON_RE.test(x));
}

/** key → reasons (deduped, valid codes only; targets with an unsafe key are dropped). */
export function normalizeRepairTargets(targets: readonly RepairTarget[] | undefined): Map<string, string[]> | null {
  if (!targets || targets.length === 0) return null;
  const out = new Map<string, string[]>();
  for (const t of targets) {
    if (!/^m[1-9]\d*:(?:\d{1,3}|heading)$/.test(t.key)) continue;
    const list = out.get(t.key) ?? [];
    for (const r of reasonList(t.reason)) if (!list.includes(r)) list.push(r);
    out.set(t.key, list);
  }
  return out.size ? out : null;
}

function aliasResolver(spec: CaptionBatchSpec, aliasOf?: ReadonlyMap<string, string>) {
  const local = new Map<string, string>();
  let n = 0;
  for (const m of spec.moments) for (const p of m.pages) for (const id of p.photoIds) {
    if (local.has(id)) continue;
    const a = aliasOf?.get(id) ?? (PHOTO_ALIAS_RE.test(id) ? id : null);
    local.set(id, a ?? `p${++n}`);
  }
  return (id: string) => local.get(id) ?? "p?";
}

/** `p3 "two people laughing" (group, joyful, place "Abu Dhabi")` */
function photoNote(alias: string, p: StoryPhoto | undefined): string {
  const a = p?.analysis;
  const desc = a ? firstWords(a.description, MAX_DESCRIPTION_WORDS) || "no description" : "not analysed";
  const tags = [a?.scene ?? "unknown", a?.mood ?? "unknown"];
  if (p?.place && oneLine(p.place)) tags.push(`place ${quoted(p.place, AI_TEXT_LIMITS.place)}`);
  return `${alias} "${desc}" (${tags.join(", ")})`;
}

export interface CaptionUserMessageInput {
  spec: CaptionBatchSpec;
  book: CaptionBook;
  photosById: ReadonlyMap<string, StoryPhoto>;
  aliasOf?: ReadonlyMap<string, string>;
  memoryBlock: string;
  otherCaptions?: readonly string[];
  repair: Map<string, string[]> | null;
}

/** The per-request user message (book info, memory, moments + page lines, repair list). */
export function buildCaptionUserMessage(input: CaptionUserMessageInput): string {
  const { spec, book, photosById, memoryBlock, repair } = input;
  const alias = aliasResolver(spec, input.aliasOf);
  const lines = [
    "BOOK",
    `occasion: ${book.occasion}`,
    `tone: ${book.tone}`,
    `caption language: ${spec.lang}`,
    `book title: ${quoted(book.title, 120)}`,
  ];
  if (memoryBlock.trim()) lines.push("", memoryBlock.trim());
  lines.push("", "MOMENTS");
  for (const m of spec.moments) {
    lines.push(
      `${m.momentId} · chapter ${quoted(m.title, AI_TEXT_LIMITS.chapterTitle)} · date ${m.dateLabel.trim() ? quoted(m.dateLabel, AI_TEXT_LIMITS.dateLabel) : "undated"} · place ${quoted(m.place, AI_TEXT_LIMITS.place)}`,
    );
    if (m.pages.length === 0) lines.push("- (no page captions needed; heading only)");
    for (const p of m.pages) {
      const photos = p.photoIds.map((id) => photoNote(alias(id), photosById.get(id))).join(", ");
      lines.push(`- ${p.key} · layout ${p.layout} · photos: ${photos || "none"}`);
    }
  }
  const others = (input.otherCaptions ?? [])
    .map((c) => (typeof c === "string" ? clipText(oneLine(c), AI_TEXT_LIMITS.caption) : ""))
    .filter(Boolean)
    .slice(0, MAX_OTHER_CAPTIONS);
  if (others.length) {
    lines.push("", "Captions already used elsewhere in this book (data; do not repeat them or their opening words):");
    for (const c of others) lines.push(`- "${c}"`);
  }
  if (repair) {
    const parts = [...repair.entries()].map(([k, r]) => `${k} (${r.length ? r.join(", ") : "rewrite"})`);
    lines.push("", `Rewrite only these: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

const MEMORY_LINE_KEYS: Array<[string, keyof UserMemory]> = [
  ["- Preferred tone:", "tonePreference"],
  ["- Preferred caption length:", "captionLength"],
  ["- Usual caption language:", "language"],
  ["- Names the user typed before:", "knownNames"],
  ["- Things the user asked to avoid:", "avoid"],
];

/** Memory keys present (for input_summary) — from the snapshot, else from the block's lines. */
export function memoryKeysOf(memory: UserMemory | null | undefined, block: string): string[] {
  if (memory) {
    const keys: string[] = [];
    if (memory.tonePreference) keys.push("tonePreference");
    if (memory.captionLength) keys.push("captionLength");
    if (memory.language) keys.push("language");
    if (memory.knownNames?.length) keys.push("knownNames");
    if (memory.avoid?.length) keys.push("avoid");
    return keys;
  }
  if (!block.startsWith(MEMORY_BLOCK_HEADER)) return [];
  return MEMORY_LINE_KEYS.filter(([prefix]) => block.split("\n").some((l) => l.startsWith(prefix))).map(([, k]) => k);
}

function captionLengthOf(memory: UserMemory | null | undefined, block: string): CaptionLength | null {
  if (memory?.captionLength) return memory.captionLength;
  const line = block.split("\n").find((l) => l.startsWith("- Preferred caption length:"));
  if (!line) return null;
  return line.includes("short") ? "short" : line.includes("long") ? "long" : "medium";
}

/** Output budget incl. thinking (Opus 5.5 always thinks). */
export function captionWriterMaxTokens(pageCount: number): number {
  return Math.min(8_000, 3_000 + 250 * Math.max(1, pageCount));
}

export function buildCaptionWriterRequest(args: WriteCaptionsArgs): AgentRequest<CaptionBatchAi> {
  const memoryBlock = args.memoryBlock ?? memoryPromptBlock(args.memory ?? {});
  const repair = normalizeRepairTargets(args.repairTargets);
  const pageCount = args.spec.keys.length;
  const meta: CaptionWriterScenarioMeta = {
    lang: args.spec.lang,
    tone: args.book.tone,
    occasion: args.book.occasion,
    captionLength: captionLengthOf(args.memory, memoryBlock),
    batchIndex: args.spec.index,
    attempt: args.attempt,
    moments: args.spec.moments.map((m) => ({
      momentId: m.momentId,
      wantHeading: m.wantHeading,
      pages: m.pages.map((p) => {
        const first = p.photoIds.map((id) => args.photosById.get(id)).find(Boolean);
        return {
          key: p.key,
          pageIndex: p.pageIndex,
          ordinal: p.ordinal,
          scene: first?.analysis?.scene ?? null,
          mood: first?.analysis?.mood ?? null,
          place: first?.place?.trim() || null,
        };
      }),
    })),
    repair: repair ? [...repair.keys()] : null,
  };
  return {
    agent: "caption_writer",
    system: captionWriterSystem(),
    messages: [
      {
        role: "user",
        content: buildCaptionUserMessage({
          spec: args.spec,
          book: args.book,
          photosById: args.photosById,
          aliasOf: args.aliasOf,
          memoryBlock,
          otherCaptions: args.otherCaptions,
          repair,
        }),
      },
    ],
    schema: CaptionBatchAiSchema,
    // A repair round rewrites a few captions: effort low (CLAUDE.md); full batches: medium.
    effort: repair ? EFFORT.caption_repair : EFFORT.caption_writer,
    maxTokens: captionWriterMaxTokens(pageCount),
    timeoutMs: AGENT_TIMEOUT_MS.caption_writer,
    scenarioMeta: { ...meta },
  };
}

// ---------------------------------------------------------------------------- post-check

interface Checked {
  captions: Map<string, string>;
  headings: Map<string, string>;
  issues: Map<string, CaptionIssue[]>;
}

const clean = (s: string, max: number) => clipText(s.replace(/\s+/g, " ").trim(), max);

/**
 * Pick the answers for the requested keys and pre-check them (pure; exported for tests and the
 * repair round). Unknown keys/moments are ignored; first answer per key wins.
 */
export function precheckBatch(
  data: CaptionBatch,
  args: Pick<WriteCaptionsArgs, "spec" | "book" | "photosById" | "memory" | "otherCaptions" | "repairTargets">,
): Checked {
  const { spec } = args;
  const repair = normalizeRepairTargets(args.repairTargets);
  const wantedPages = new Set(spec.keys.filter((k) => !repair || repair.has(k)));
  const wantedHeadings = new Set(
    spec.moments
      .filter((m) => (repair ? repair.has(captionKey(m.momentId, "heading")) : m.wantHeading))
      .map((m) => m.momentId),
  );

  const texts = new Map<string, string>();
  const rawHeadings = new Map<string, string>();
  for (const m of data.moments) {
    if (wantedHeadings.has(m.momentId) && !rawHeadings.has(m.momentId)) rawHeadings.set(m.momentId, m.heading);
    for (const pc of m.pageCaptions) {
      const key = captionKey(m.momentId, pc.pageIndex);
      if (wantedPages.has(key) && !texts.has(key)) texts.set(key, clean(pc.text, AI_TEXT_LIMITS.caption));
    }
  }

  const photos = spec.moments.flatMap((m) => m.pages.flatMap((p) => p.photoIds.map((id) => args.photosById.get(id))));
  const ctx = buildCaptionContext({
    lang: spec.lang,
    bookTitle: args.book.title,
    // Places only: chapter titles are AI text and never allowlist names (SF3).
    chapters: spec.moments.map((m) => ({ place: m.place })),
    photoPlaces: photos.map((p) => p?.place ?? null),
    knownNames: args.memory?.knownNames ?? [],
    dates: photos.map((p) => p?.takenAt ?? null),
  });

  const others = (args.otherCaptions ?? []).filter((c): c is string => typeof c === "string" && c.trim() !== "");
  const list = [
    ...others.map((text, i) => ({ key: `other:${i}`, text })),
    ...spec.keys.filter((k) => texts.has(k)).map((k) => ({ key: k, text: texts.get(k) as string })),
  ];
  const issues = new Map<string, CaptionIssue[]>();
  for (const [k, v] of checkBookCaptions(list, ctx)) if (!k.startsWith("other:")) issues.set(k, v);

  const captions = new Map<string, string>();
  for (const k of spec.keys) {
    if (!wantedPages.has(k)) continue;
    const t = texts.get(k);
    if (t === undefined) issues.set(k, [{ code: "empty" as CaptionIssueCode, key: k }]);
    else if (!issues.has(k)) captions.set(k, t);
  }

  const headings = new Map<string, string>();
  for (const id of wantedHeadings) {
    const key = captionKey(id, "heading");
    const raw = rawHeadings.get(id);
    const h = raw === undefined ? "" : clean(raw, AI_TEXT_LIMITS.heading);
    const hi = h ? checkHeading(h, ctx) : [{ code: "empty" as CaptionIssueCode }];
    if (hi.length) issues.set(key, hi.map((i) => ({ code: i.code, key })));
    else headings.set(id, h);
  }
  return { captions, headings, issues };
}

// ---------------------------------------------------------------------------- the call

const empty = (): Pick<WriteCaptionsResult, "captions" | "headings" | "issues"> => ({
  captions: new Map(),
  headings: new Map(),
  issues: new Map(),
});

export async function writeCaptions(args: WriteCaptionsArgs): Promise<WriteCaptionsResult> {
  const { spec } = args;
  const repair = normalizeRepairTargets(args.repairTargets);
  if (spec.moments.length === 0 || (args.repairTargets?.length && !repair)) {
    return { ok: false, ...empty(), failure: { status: "error", code: "bad_request", retryable: false }, costUsd: 0 };
  }
  const request = buildCaptionWriterRequest(args);
  const memoryBlock = args.memoryBlock ?? memoryPromptBlock(args.memory ?? {});

  let checked: Checked | null = null;
  const result = await runAgentStep({
    runId: args.runId,
    agent: "caption_writer",
    stepKey: args.stepKey,
    attempt: args.attempt,
    inputSummary: {
      promptVersion: CAPTION_WRITER_PROMPT_VERSION,
      batch: spec.index,
      moments: spec.moments.length,
      pages: spec.keys.length,
      lang: spec.lang,
      memoryKeys: memoryKeysOf(args.memory, memoryBlock),
      otherCaptions: Math.min(args.otherCaptions?.length ?? 0, MAX_OTHER_CAPTIONS),
      repairTargets: repair ? repair.size : 0,
    },
    request,
    strictSchema: CaptionBatchStrictSchema,
    toLogOutput: (data) => {
      checked = precheckBatch(data, args);
      return captionLogOutput(data, spec.lang, checked.issues);
    },
    transport: args.transport,
    logger: args.logger,
    retry: args.retry,
  });

  if (!result.ok) {
    return {
      ok: false,
      ...empty(),
      failure: { status: result.status, code: result.code, retryable: result.retryable },
      costUsd: result.costUsd,
    };
  }
  const final: Checked = checked ?? precheckBatch(result.data, args);
  return { ok: true, ...final, costUsd: result.costUsd };
}
