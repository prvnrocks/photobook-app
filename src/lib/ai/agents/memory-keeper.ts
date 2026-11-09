// Memory Keeper (docs/AI-AGENTS.md ⑥, D-032) — code only in M4, no AI call, no I/O.
// Learns a few preferences from what the USER chose or typed for a book and merges them into
// `user_memory.prefs`:
//   - tonePreference: only when the book's tone differs from the occasion default (explicit choice)
//   - language: the book's caption language
//   - captionLength: median word count of ≥ 3 captions with source "user"
// knownNames / avoid are carried over untouched (M5 fills them from editor edits). Nothing is ever
// derived from AI captions, photo descriptions or photo content (no face/identity guessing).
// `reasons` are fixed codes only — never caption text or names — so they are safe to log.

import { sanitizeMemory } from "@/lib/ai/memory";
import { wordCount, type CaptionLength, type UserMemory } from "@/lib/ai/schemas";
import { CAPTION_LANGS, DEFAULT_TONE, OCCASIONS, TONES } from "@/lib/book/options";
import { CaptionSchema } from "@/lib/book/schema";

export const MIN_USER_CAPTIONS_FOR_LENGTH = 3;
export const SHORT_MAX_MEDIAN_WORDS = 10;
export const MEDIUM_MAX_MEDIAN_WORDS = 16;

export type MemoryUpdateReason =
  | "sanitized"
  | "tone_explicit"
  | "language"
  | "caption_length";

export interface MemoryBookInput {
  occasion: unknown;
  tone: unknown;
  caption_lang: unknown;
  title?: unknown;
}

export interface MemoryUpdateResult {
  next: UserMemory;
  changed: boolean;
  reasons: MemoryUpdateReason[];
}

const pick = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Key-order-independent JSON, for change detection. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Word counts of captions the user wrote (source "user"). Lenient: bad pages/captions are skipped. */
export function userCaptionWordCounts(doc: unknown): number[] {
  if (!isRecord(doc) || !Array.isArray(doc.pages)) return [];
  const out: number[] = [];
  for (const page of doc.pages) {
    if (!isRecord(page)) continue;
    const cap = CaptionSchema.safeParse(page.caption);
    if (!cap.success || cap.data.source !== "user") continue;
    const n = wordCount(cap.data.text);
    if (n > 0) out.push(n);
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function captionLengthFromWordCounts(counts: number[]): CaptionLength | undefined {
  if (counts.length < MIN_USER_CAPTIONS_FOR_LENGTH) return undefined;
  const m = median(counts);
  if (m <= SHORT_MAX_MEDIAN_WORDS) return "short";
  if (m <= MEDIUM_MAX_MEDIAN_WORDS) return "medium";
  return "long";
}

/**
 * Merge what this book teaches into the previous memory. Pure and idempotent: feeding `next`
 * back in as `prev` with the same book/doc yields `changed: false`. Never throws; `next` always
 * passes UserMemorySchema.
 */
export function deriveMemoryUpdate(prev: unknown, book: MemoryBookInput, doc: unknown): MemoryUpdateResult {
  const base = sanitizeMemory(prev);
  const reasons: MemoryUpdateReason[] = [];
  if (canonical(base) !== canonical(prev)) reasons.push("sanitized");

  const draft: UserMemory = { ...base, sources: { ...base.sources } };
  const b: Partial<MemoryBookInput> = isRecord(book) ? book : {};

  const occasion = pick(OCCASIONS, b.occasion);
  const tone = pick(TONES, b.tone);
  if (occasion && tone && tone !== DEFAULT_TONE[occasion]) {
    if (draft.tonePreference !== tone || draft.sources?.tone !== "explicit") reasons.push("tone_explicit");
    draft.tonePreference = tone;
    draft.sources = { ...draft.sources, tone: "explicit" };
  }

  const language = pick(CAPTION_LANGS, b.caption_lang);
  if (language) {
    if (draft.language !== language) reasons.push("language");
    draft.language = language;
  }

  const length = captionLengthFromWordCounts(userCaptionWordCounts(doc));
  if (length) {
    if (draft.captionLength !== length || draft.sources?.captionLength !== "user_captions") {
      reasons.push("caption_length");
    }
    draft.captionLength = length;
    draft.sources = { ...draft.sources, captionLength: "user_captions" };
  }

  // Re-sanitize: normalises key order, drops an empty `sources`, and (by sanitizeMemory's
  // contract) always yields a UserMemorySchema-valid value.
  const next = sanitizeMemory(draft);
  const changed = canonical(next) !== canonical(prev);
  return { next, changed, reasons: changed ? reasons : [] };
}
