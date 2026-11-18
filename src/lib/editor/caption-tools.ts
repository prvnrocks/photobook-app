// Pure helpers for the editor's caption tools (M5 Task 10): word count hint, caption lang,
// ✨ rewrite labels and the POST /api/ai/rewrite response → UI state mapping.
// Client-safe: no imports from src/lib/ai (server-only); the few values needed are mirrored here
// and pinned to the server's versions by tests/editor-caption-tools.test.ts.

import { TONES, type Tone } from "@/lib/book/options";
import { CAPTION_MAX, DESCRIPTION_MAX } from "@/lib/book/edit-ops";
import { CAPTION_FONTS, isM30Font, type BookFontName } from "@/lib/book/fonts";
import { captionFontOf } from "@/lib/book/render";
import type { Caption, DesignStyle } from "@/lib/book/types";
import { styleCaptionFont } from "@/lib/design/styles";
import { isMainlyArabic } from "@/lib/review/ui";

/** Soft caption length (AI rule ≤ 18 words): past this we show a gentle hint, never block. */
export const CAPTION_SOFT_WORDS = 18;
/** Hard cap (UTF-16 units, same as setCaption's clip and the textarea maxLength). */
export const CAPTION_HARD_MAX = CAPTION_MAX;

/** Words = whitespace-separated runs (works for Arabic and Latin; emoji runs count as words). */
export function countWords(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

export interface CaptionLengthInfo {
  words: number;
  chars: number;
  /** More than CAPTION_SOFT_WORDS words — show the soft hint. */
  long: boolean;
  /** At the hard cap. */
  full: boolean;
  label: string;
}

export function captionLengthInfo(text: string): CaptionLengthInfo {
  const words = countWords(text);
  const chars = text.length;
  return {
    words,
    chars,
    long: words > CAPTION_SOFT_WORDS,
    full: chars >= CAPTION_HARD_MAX,
    label: `${words} ${words === 1 ? "word" : "words"} · ${chars}/${CAPTION_HARD_MAX}`,
  };
}

export const LONG_CAPTION_HINT = "Short captions read best — try 18 words or fewer.";

/** `lang` for caption-like inputs: "ar" for mainly Arabic text, or no letters yet in an Arabic book. */
export function captionInputLang(text: string, captionLang: string): "ar" | "en" {
  if (isMainlyArabic(text)) return "ar";
  if (!/[A-Za-zÀ-ɏ]/.test(text) && captionLang === "ar") return "ar";
  return "en";
}

// ---- caption font choices ----------------------------------------------------------------------

/**
 * Faces the caption font picker offers for a book of `style`: the four classic faces, and — for
 * the magazine / editorial styles (M30) — their own caption face first: the "Sans" pair, Poppins
 * with Tajawal for Arabic text (the renderer switches a Latin face to its Arabic partner). The four
 * older styles get exactly the classic list, as before: nothing changes for existing books.
 */
export function captionFontOptions(style: DesignStyle | null | undefined): readonly BookFontName[] {
  const face = styleCaptionFont(style, "en");
  return isM30Font(face) ? [face, ...CAPTION_FONTS] : CAPTION_FONTS;
}

/** The picker tile a caption's font is: its stored face when offered, else the classic face it renders as. */
export function pickerFontOf(caption: Pick<Caption, "text" | "font">, options: readonly BookFontName[], captionLang: string): BookFontName {
  const stored = options.find((f) => f === caption.font);
  return stored ?? captionFontOf(caption, captionLang);
}

// ---- chapter description (M30) -----------------------------------------------------------------

/** Soft description length (AI rule ≤ 45 words): past this we show a gentle hint, never block. */
export const DESCRIPTION_SOFT_WORDS = 45;
/** Hard cap (UTF-16 units, same as setChapterDescription's clip and the textarea maxLength). */
export const DESCRIPTION_HARD_MAX = DESCRIPTION_MAX;

export const LONG_DESCRIPTION_HINT = "A short paragraph reads best — try 45 words or fewer.";

/** Word counter of the description field: "12 of 45 words · 80/400". */
export function descriptionLengthInfo(text: string): CaptionLengthInfo {
  const words = countWords(text);
  const chars = text.length;
  return {
    words,
    chars,
    long: words > DESCRIPTION_SOFT_WORDS,
    full: chars >= DESCRIPTION_HARD_MAX,
    label: `${words} of ${DESCRIPTION_SOFT_WORDS} words · ${chars}/${DESCRIPTION_HARD_MAX}`,
  };
}

/** ✨ wording for a chapter description, where the caption wording would name the wrong thing. */
export const DESCRIPTION_REWRITE_COPY: Partial<Record<RewriteFailureKind, string>> & { empty: string } = {
  empty: "Write a few lines first — AI can then rewrite them.",
  off: "AI writing isn't switched on yet",
  unavailable: "AI writing isn't available right now — try later",
  tooShort: "This text is already short",
  refused: "Can't rewrite this text",
};

// ---- ✨ rewrite --------------------------------------------------------------------------------

/** Mirrors RewriteInstruction in src/lib/ai/schemas.ts (server-only). */
export type RewriteInstruction = "rewrite" | "shorter" | "translate" | `tone:${Tone}`;

const ARABIC_LETTER_G = /[ؠ-ؿف-يٱ-ۓەۺ-ۼۿݐ-ݿࢠ-ࣉﭐ-ﷻﹰ-ﻼ]/g;
const LATIN_LETTER_G = /[A-Za-zÀ-ɏ]/g;

/** Dominant script, same rule as the server's detectCaptionLang (Arabic letters > Latin letters). */
export function captionScript(text: string): "ar" | "en" {
  const ar = (text.match(ARABIC_LETTER_G) ?? []).length;
  const la = (text.match(LATIN_LETTER_G) ?? []).length;
  return ar > la ? "ar" : "en";
}

/** Label of the translate option; the server derives the actual target from the same text. */
export function translateLabel(text: string): string {
  return captionScript(text) === "ar" ? "Translate to English" : "Translate to Arabic";
}

export const TONE_LABELS: Record<Tone, string> = {
  romantic: "Romantic",
  fun: "Fun",
  nostalgic: "Nostalgic",
  minimal: "Minimal",
};

export interface RewriteOption {
  instruction: RewriteInstruction;
  label: string;
  /** Set when this option can't help with this text (shown as a hint; the button is disabled). */
  disabledReason?: string;
}

/**
 * "Shorter" needs more than this many words. Mirrors the rewrite route's 400 `too_short` check
 * (server-side, src/lib/ai — not importable here); the server stays authoritative.
 */
export const SHORTER_MAX_WORDS_BLOCKED = 3;

export function canShorten(text: string): boolean {
  return countWords(text) > SHORTER_MAX_WORDS_BLOCKED;
}

/** Menu options for a caption (translate label follows the caption's script). */
export function rewriteOptions(text: string): { main: RewriteOption[]; tones: RewriteOption[] } {
  const shorter: RewriteOption = { instruction: "shorter", label: "Shorter" };
  if (!canShorten(text)) shorter.disabledReason = REWRITE_FAILURE_COPY.tooShort;
  return {
    main: [
      { instruction: "rewrite", label: "Rewrite" },
      shorter,
      { instruction: "translate", label: translateLabel(text) },
    ],
    tones: TONES.map((t) => ({ instruction: `tone:${t}` as const, label: TONE_LABELS[t] })),
  };
}

/** Client fetch timeout: the route may take ~46 s (maxDuration 60). */
export const REWRITE_FETCH_TIMEOUT_MS = 65_000;

export type RewriteUiState =
  | { kind: "idle" }
  | { kind: "loading"; instruction: RewriteInstruction }
  | { kind: "preview"; text: string; lang: string; remaining: number | null; instruction: RewriteInstruction }
  | { kind: "off" }
  /** AI is temporarily unusable (503 ai_unavailable, 502 auth / bad_request). */
  | { kind: "unavailable" }
  | { kind: "limit" }
  /** Per-user daily ceiling (429 daily_limit) — not the per-book cap; no Upgrade. */
  | { kind: "dailyLimit" }
  /** 429 budget_exhausted (D-059): global daily AI budget used up — try later, not counted. */
  | { kind: "aiBreak" }
  /** 400 too_short: nothing to shorten. */
  | { kind: "tooShort" }
  | { kind: "busy" }
  | { kind: "retry" }
  /** 503 unavailable (M12: Supabase timeout) — temporary, "Try again"; never a session block. */
  | { kind: "serverBusy" }
  | { kind: "unusable" }
  | { kind: "refused" }
  | { kind: "signedOut" }
  | { kind: "error" };

export type RewriteFailureKind = Exclude<RewriteUiState["kind"], "idle" | "loading" | "preview">;

export const REWRITE_FAILURE_COPY: Record<RewriteFailureKind, string> = {
  off: "AI captions aren't switched on yet",
  unavailable: "AI captions aren't available right now — try later",
  limit: "No AI rewrites left on this book",
  dailyLimit: "You've reached today's AI rewrite limit — try again tomorrow",
  aiBreak: "AI is taking a break — try again later",
  tooShort: "This caption is already short",
  busy: "One rewrite at a time — wait for the current one to finish.",
  retry: "The AI didn't answer in time. Try again.",
  serverBusy: "This is taking longer than usual. Try again in a moment.",
  unusable: "Couldn't improve this one — try another option",
  refused: "Can't rewrite this caption",
  signedOut: "You're signed out. Sign in again to use AI.",
  error: "Something went wrong. Try again.",
};

function field(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

/**
 * Map a /api/ai/rewrite response (status + parsed JSON body, null if not JSON) to a UI state.
 * Network errors / timeouts are mapped by the caller to { kind: "retry" }.
 */
export function rewriteResponseState(status: number, body: unknown, instruction: RewriteInstruction): RewriteUiState {
  const error = field(body, "error");
  if (status === 200) {
    const text = field(body, "text");
    if (typeof text !== "string" || text.trim() === "") return { kind: "unusable" };
    const lang = field(body, "lang");
    const remaining = field(body, "remaining");
    return {
      kind: "preview",
      text,
      lang: lang === "ar" ? "ar" : "en",
      remaining: typeof remaining === "number" && Number.isFinite(remaining) ? Math.max(0, Math.trunc(remaining)) : null,
      instruction,
    };
  }
  if (error === "ai_off") return { kind: "off" };
  if (status === 503) {
    // M12: "unavailable" = a Supabase timeout — temporary, so offer Try again (no session block).
    if (error === "unavailable") return { kind: "serverBusy" };
    return { kind: "unavailable" }; // ai_unavailable (or any other 503)
  }
  if (status === 429) {
    if (error === "budget_exhausted") return { kind: "aiBreak" };
    return error === "daily_limit" ? { kind: "dailyLimit" } : { kind: "limit" };
  }
  if (status === 400 && error === "too_short") return { kind: "tooShort" };
  if (status === 409) return { kind: "busy" };
  if (status === 401) return { kind: "signedOut" };
  if (status === 502) {
    if (error === "refusal") return { kind: "refused" };
    if (error === "rewrite_unusable") return { kind: "unusable" };
    // Our API key / request shape: nothing the user can fix by trying another option.
    if (error === "auth" || error === "bad_request") return { kind: "unavailable" };
    return field(body, "retryable") === true ? { kind: "retry" } : { kind: "unusable" };
  }
  if (status === 504 || status === 408) return { kind: "retry" };
  return { kind: "error" };
}

/**
 * Failures that switch ✨ off for the rest of this editor session (like AI off): retrying any
 * option would fail the same way. tooShort / unusable / refused are about this caption only;
 * serverBusy (503 unavailable, M12) is temporary and never blocks the session.
 */
export type AiSessionBlock = "off" | "unavailable" | "dailyLimit";

export function sessionBlockFor(kind: RewriteUiState["kind"]): AiSessionBlock | null {
  return kind === "off" || kind === "unavailable" || kind === "dailyLimit" ? kind : null;
}

/** Rewrites left after a successful rewrite: the server's `remaining`, else previous − 1. */
export function nextRewritesLeft(previousLeft: number, remaining: number | null): number {
  return remaining ?? Math.max(0, previousLeft - 1);
}

/** ✨ on a page caption (the body the editor has always sent). */
export type RewriteCaptionBody = { bookId: string; pageId: string; instruction: RewriteInstruction; text: string };
/** Instructions the editor offers for a chapter description (no tone options). */
export type DescriptionRewriteInstruction = "rewrite" | "shorter" | "translate";
/**
 * ✨ on a chapter description (M30 T11/T13): `target: "description"` + the chapter id — and never a
 * `pageId` (the route's body is strict). Mirrors RewriteDescriptionBodySchema in src/lib/ai.
 */
export type RewriteDescriptionBody = {
  bookId: string;
  target: "description";
  chapterId: string;
  instruction: DescriptionRewriteInstruction;
  text: string;
};
export type RewriteBody = RewriteCaptionBody | RewriteDescriptionBody;

/**
 * POST /api/ai/rewrite with a hard timeout. Sends only the on-screen text (the server picks the
 * target language). Never throws: failures become a UI state.
 */
export async function requestRewrite(
  body: RewriteBody,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RewriteUiState> {
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? REWRITE_FETCH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const res = await doFetch("/api/ai/rewrite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return rewriteResponseState(res.status, json, body.instruction);
  } catch {
    return { kind: "retry" };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
