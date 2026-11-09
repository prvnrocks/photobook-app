// Deterministic caption pre-check (D-030). Runs on every AI caption before it reaches the book;
// a failing caption is sent back to the Caption Writer once (targeted repair), then becomes null.
// Pure, no SDK, no I/O.
//
// Issues carry codes only — never caption text — so they can be logged to agent_steps (D-027).
//
// The checks are conservative heuristics for CLAUDE.md's quote rules: original text, ≤ 18 words,
// no invented names/places/facts (capitalised words and numbers must come from the metadata),
// native Arabic when caption_lang = 'ar'. Arabic-script names cannot be detected by
// capitalisation; the Critic covers those (caption_invented_fact).

import type { CaptionLang } from "@/lib/book/options";
import { MAX_QUOTE_WORDS, captionKey, wordCount } from "@/lib/ai/schemas";
import { hasLoneSurrogate } from "@/lib/text/clip";

export { captionKey };

export const CAPTION_ISSUE_CODES = [
  "empty",
  "no_letters",
  "too_long",
  "lone_surrogate",
  "arabic_in_english",
  "not_arabic",
  "latin_word",
  "url",
  "mention",
  "hashtag",
  "attribution",
  "wrapped_in_quotes",
  "unknown_name",
  "unknown_number",
  "duplicate",
  "repeated_opening",
] as const;
export type CaptionIssueCode = (typeof CAPTION_ISSUE_CODES)[number];

/** `key` is only set by checkBookCaptions (captionKey format, e.g. "m2:1"). No text, ever. */
export type CaptionIssue = { code: CaptionIssueCode; key?: string };

export type CaptionCheckContext = {
  lang: CaptionLang;
  /** Names/places that may appear: book title words, chapter titles + places, photo places, knownNames. */
  allowNames: ReadonlySet<string>;
  /** Numbers that may appear (years/months/days from the photo dates), Latin digits, e.g. "2026". */
  allowDigits: ReadonlySet<string>;
};

/** Max times the same opening word may start a caption in one book. */
export const MAX_SAME_OPENING = 2;

// ---------------------------------------------------------------------------- character classes

// Arabic-script letters (Arabic, Supplement, Extended-A, Presentation Forms) minus digits,
// punctuation, diacritics (tashkeel) and tatweel.
const ARABIC_LETTER =
  /[ؠ-ؿف-يٮٯٱ-ۓەۮۯۺ-ۼۿݐ-ݿࢠ-ࣉﭐ-ﷻﹰ-ﻼ]/;
const ARABIC_DIACRITICS_G = /[ـً-ٰٟۖ-ۭ]/g;
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/;
const DIGIT_RUN_G = /[0-9٠-٩۰-۹]+/g;
// Anything that is not a letter/digit in the scripts we care about (used to trim tokens).
const EDGE_PUNCT = /^[^0-9A-Za-zÀ-ɏͰ-ϿЀ-ӿ؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿٠-٩]+|[^0-9A-Za-zÀ-ɏͰ-ϿЀ-ӿ؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿٠-٩]+$/g;

/** Letters counted for the Arabic-ratio rule: Arabic letters + any cased letter (Latin, Greek, Cyrillic…). */
function letterStats(s: string): { arabic: number; latin: number; total: number } {
  let arabic = 0;
  let latin = 0;
  let total = 0;
  for (const ch of s) {
    if (ARABIC_LETTER.test(ch)) {
      arabic++;
      total++;
    } else if (ch.toLowerCase() !== ch.toUpperCase()) {
      total++;
      if (LATIN_LETTER.test(ch)) latin++;
    }
  }
  return { arabic, latin, total };
}

/** Latin + Arabic-Indic + Extended Arabic-Indic digits → Latin, leading zeros dropped ("07" → "7"). */
export function normalizeNumber(run: string): string {
  const latin = run.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(
    /[۰-۹]/g,
    (d) => String(d.charCodeAt(0) - 0x06f0),
  );
  const t = latin.replace(/^0+(?=\d)/, "");
  return t;
}

/** Lower-cased, punctuation-trimmed word; possessive 's removed; Arabic diacritics removed. */
export function normalizeWord(w: string): string {
  return w
    .normalize("NFC")
    .replace(EDGE_PUNCT, "")
    .replace(/['’]s$/i, "")
    .replace(ARABIC_DIACRITICS_G, "")
    .toLocaleLowerCase();
}

/** Split names/titles/places into normalised words ("Abu Dhabi" → abu, dhabi; "Sara-Omar" → sara, omar). */
export function nameWords(values: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v !== "string") continue;
    for (const part of v.split(/[\s\-–—/&+,.;:!?()[\]{}"“”«»]+/)) {
      const w = normalizeWord(part);
      if (w) out.add(w);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- context builder

export type CaptionContextInput = {
  lang: CaptionLang;
  bookTitle?: string | null;
  chapters?: ReadonlyArray<{ title?: string | null; place?: string | null }>;
  photoPlaces?: ReadonlyArray<string | null | undefined>;
  knownNames?: ReadonlyArray<string>;
  /** Photo dates (ISO strings like "2026-10-12T19:30:00+04:00" or Date). Local Y-M-D of the string is used. */
  dates?: ReadonlyArray<string | Date | null | undefined>;
};

/** Years, months and days from the photo dates, as normalised digit strings. */
export function digitsFromDates(dates: ReadonlyArray<string | Date | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const d of dates) {
    let y: number, m: number, day: number;
    if (d instanceof Date) {
      if (Number.isNaN(d.getTime())) continue;
      [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    } else if (typeof d === "string") {
      const r = /^(\d{4})-(\d{2})-(\d{2})/.exec(d.trim());
      if (!r) continue;
      [y, m, day] = [Number(r[1]), Number(r[2]), Number(r[3])];
    } else continue;
    if (m < 1 || m > 12 || day < 1 || day > 31) continue;
    out.add(String(y));
    out.add(String(m));
    out.add(String(day));
  }
  return out;
}

/** Build the allowlists from the book's metadata (all inputs are user/metadata data, never AI text). */
export function buildCaptionContext(input: CaptionContextInput): CaptionCheckContext {
  const names: string[] = [];
  if (input.bookTitle) names.push(input.bookTitle);
  for (const c of input.chapters ?? []) {
    if (c.title) names.push(c.title);
    if (c.place) names.push(c.place);
  }
  for (const p of input.photoPlaces ?? []) if (p) names.push(p);
  for (const n of input.knownNames ?? []) names.push(n);
  const digits = digitsFromDates(input.dates ?? []);
  // Numbers the user typed into the book title (e.g. "Class of 2026") are metadata too.
  for (const run of (input.bookTitle ?? "").match(DIGIT_RUN_G) ?? []) digits.add(normalizeNumber(run));
  return { lang: input.lang, allowNames: nameWords(names), allowDigits: digits };
}

// ---------------------------------------------------------------------------- rule helpers

const URL_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|ae|co|me|ly|app|info|biz|uk|us)\b/i;
const MENTION_RE = /(?:^|[^\w])@[A-Za-z0-9_؀-ۿ]/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const HASHTAG_RE = /(?:^|\s)#[^\s#]/;
const QUOTE_OPEN = `"“”„'‘’«‹`;
const QUOTE_CLOSE = `"“”'‘’»›`;
const WRAPPED_RE = new RegExp(`^\\s*[${QUOTE_OPEN}][\\s\\S]+[${QUOTE_CLOSE}]\\s*$`);
const QUOTED_THEN_DASH_RE = new RegExp(`[${QUOTE_CLOSE}]\\s*[—–~―-]\\s*\\S`);
// "as Rumi once said", "as Oscar Wilde wrote", "as they say", "as the saying goes".
const AS_SAID_RE = /\b[Aa]s\s+(?:[A-Z]\S*\s+){1,3}(?:once\s+)?(?:said|says|wrote|put it)\b/;
const AS_THEY_SAY_RE = /\bas\s+(?:they\s+say|the\s+(?:old\s+)?saying\s+goes)\b/i;
const SAID_NAME_RE = /\b(?:said|says|wrote)\s+[A-Z][a-z]/;
const AR_AS_SAID_RE = /كما\s+(?:قال|قالت|يقول|تقول|كتب|كتبت)/;
const AR_SAID_NAME_RE = /(?:^|\s)(?:قال|قالت)\s+\S+\s*[:：]/;
// Trailing "— Name" / "– Name" / "~ Name" / " - Name" (1–3 words).
const TRAILING_DASH_RE = /(?:^|\s)[—–~―]\s*((?:\S+\s*){1,3})$|\s-\s+((?:\S+\s*){1,3})$/;

const DASH_TOKEN = /^[—–―-]+$/;
const ENDS_SENTENCE = new RegExp(`[.!?…؟]+[${QUOTE_CLOSE})\\]]*$`);
const ENDS_CLAUSE = /[:—–―]$/;

/** Words that may be capitalised without being a name: I, I'm, OK (any case). */
const ALWAYS_OK = new Set(["i", "i'm", "i’m", "i've", "i’ve", "i'll", "i’ll", "i'd", "i’d", "ok", "okay"]);

/** Common words that are often capitalised after ":" or "—" ("Our day — Pure joy"). */
const COMMON_AFTER_BREAK = new Set(
  (
    "a an the and but or so yet then now here there this that these those it its we our us you your my me " +
    "he she his her they their them what when where who why how just always forever still never ever only " +
    "also too all every each more most no not yes oh wow finally love together home life day days night " +
    "nights morning evening today tonight sun sunset sunrise first last best new little big happy sweet " +
    "pure simply one two three in on at of for with from to by up down out off over under after before " +
    "is are was were be been being have has had do does did let lets let's let’s"
  ).split(" "),
);

/** Tokens consisting only of emoji/symbols (no letters, digits or clause punctuation). */
function isSymbolToken(t: string): boolean {
  if (/[0-9A-Za-zÀ-ɏ؀-ۿ]/.test(t)) return false;
  if (/[—–―\-:;,.!?…]/.test(t)) return false;
  return /[^\s]/.test(t);
}

function startsUpper(w: string): boolean {
  const first = Array.from(w)[0] ?? "";
  return LATIN_LETTER.test(first) && first !== first.toLowerCase() && first === first.toUpperCase();
}

/** English: capitalised words that are not sentence-initial must be allowlisted. */
function hasUnknownCapitalised(text: string, allow: ReadonlySet<string>): boolean {
  for (const line of text.split(/\n+/)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    let prev: string | null = null;
    for (const tok of tokens) {
      const sentenceStart = prev === null || ENDS_SENTENCE.test(prev) || isSymbolToken(prev);
      const afterBreak = prev !== null && (ENDS_CLAUSE.test(prev) || DASH_TOKEN.test(prev));
      prev = tok;
      const parts = tok.split(/[-–—/]+/);
      for (let i = 0; i < parts.length; i++) {
        // Only the first part of a sentence-initial token is exempt ("Sunset—Paris" checks Paris).
        if (i === 0 && sentenceStart) continue;
        const trimmed = parts[i].replace(EDGE_PUNCT, "");
        if (!trimmed || !startsUpper(trimmed)) continue;
        const w = normalizeWord(trimmed);
        if (!w || ALWAYS_OK.has(w) || allow.has(w)) continue;
        if (afterBreak && COMMON_AFTER_BREAK.has(w)) continue;
        return true;
      }
    }
  }
  return false;
}

/** Arabic book: any Latin-script word must be an allowlisted name. */
function hasUnknownLatinWord(text: string, allow: ReadonlySet<string>): boolean {
  for (const tok of text.split(/\s+/)) {
    for (const part of tok.split(/[-–—/]+/)) {
      if (!LATIN_LETTER.test(part)) continue;
      const w = normalizeWord(part);
      if (!w) continue;
      if (allow.has(w)) continue;
      return true;
    }
  }
  return false;
}

function hasAttribution(text: string, ctx: CaptionCheckContext): boolean {
  if (QUOTED_THEN_DASH_RE.test(text)) return true;
  if (AS_SAID_RE.test(text) || AS_THEY_SAY_RE.test(text) || SAID_NAME_RE.test(text)) return true;
  if (AR_AS_SAID_RE.test(text) || AR_SAID_NAME_RE.test(text)) return true;
  const m = TRAILING_DASH_RE.exec(text.trim());
  if (m) {
    // "Golden hour — Abu Dhabi" (allowlisted place) is a label and "Our day — pure joy" is prose;
    // "… — Rumi" / "… — Paulo Coelho" is a citation: every tail word Title-Case, the first not a
    // common word, none allowlisted. Arabic tails can't be told apart from prose by shape, so
    // Arabic attribution is only caught by the quoted-then-dash and "كما قال" patterns.
    const raw = (m[1] ?? m[2] ?? "").trim().split(/\s+/);
    const parts = raw.map((w) => w.replace(EDGE_PUNCT, "")).filter(Boolean);
    const words = parts.map(normalizeWord);
    const looksLikeName =
      parts.length > 0 && parts.every(startsUpper) && !COMMON_AFTER_BREAK.has(words[0]) && !ALWAYS_OK.has(words[0]);
    if (looksLikeName && !words.some((w) => ctx.allowNames.has(w))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------- public API

/** Per-caption issues (no book-level rules). Returns [] for a clean caption. */
export function checkCaption(text: string, ctx: CaptionCheckContext): CaptionIssue[] {
  const issues: CaptionIssue[] = [];
  const add = (code: CaptionIssueCode) => {
    if (!issues.some((i) => i.code === code)) issues.push({ code });
  };
  if (typeof text !== "string" || text.trim() === "") return [{ code: "empty" }];

  if (hasLoneSurrogate(text)) add("lone_surrogate");
  const t = text.normalize("NFC").trim();
  if (wordCount(t) > MAX_QUOTE_WORDS) add("too_long");

  const letters = letterStats(t);
  if (letters.total === 0) add("no_letters");
  if (ctx.lang === "en") {
    if (letters.arabic > 0) add("arabic_in_english");
  } else {
    if (letters.total > 0 && letters.arabic / letters.total < 0.7) add("not_arabic");
    if (letters.latin > 0 && hasUnknownLatinWord(t, ctx.allowNames)) add("latin_word");
  }

  if (URL_RE.test(t)) add("url");
  if (MENTION_RE.test(t) || EMAIL_RE.test(t)) add("mention");
  if (HASHTAG_RE.test(t)) add("hashtag");
  if (hasAttribution(t, ctx)) add("attribution");
  // Fully wrapped: opens and closes with a quote mark and has no other double/guillemet quotes
  // inside ("“Sun” and “sea”" is not wrapped).
  if (WRAPPED_RE.test(t) && !/["“”«»„]/.test(Array.from(t).slice(1, -1).join(""))) add("wrapped_in_quotes");

  if (ctx.lang === "en" && hasUnknownCapitalised(t, ctx.allowNames)) add("unknown_name");

  const allowDigits = new Set(Array.from(ctx.allowDigits, normalizeNumber));
  for (const run of t.match(DIGIT_RUN_G) ?? []) {
    if (!allowDigits.has(normalizeNumber(run))) {
      add("unknown_number");
      break;
    }
  }
  return issues;
}

/** Normalised form for duplicate detection: case, punctuation, emoji, spacing, tashkeel ignored. */
export function normalizeCaption(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ARABIC_DIACRITICS_G, "")
    .toLocaleLowerCase()
    .replace(/[^0-9a-zÀ-ɏ؀-ۿݐ-ݿࢠ-ࣿ\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function openingWord(text: string): string {
  for (const tok of text.split(/\s+/)) {
    const w = normalizeWord(tok);
    if (w) return w;
  }
  return "";
}

/**
 * Check all captions of a book (or batch). Returns only captions WITH issues, keyed by `key`
 * (use captionKey(momentId, pageIndex)). Book-level rules: a caption that duplicates an earlier
 * one gets "duplicate"; the 3rd+ caption starting with the same word gets "repeated_opening"
 * (the earlier ones stay clean, so repair rewrites only the extras).
 */
export function checkBookCaptions(
  captions: ReadonlyArray<{ key: string; text: string }>,
  ctx: CaptionCheckContext,
): Map<string, CaptionIssue[]> {
  const out = new Map<string, CaptionIssue[]>();
  const push = (key: string, code: CaptionIssueCode) => {
    const list = out.get(key) ?? [];
    if (!list.some((i) => i.code === code)) list.push({ code, key });
    out.set(key, list);
  };
  const seen = new Set<string>();
  const openings = new Map<string, number>();

  for (const { key, text } of captions) {
    for (const issue of checkCaption(text, ctx)) push(key, issue.code);
    if (typeof text !== "string" || !text.trim()) continue;

    const norm = normalizeCaption(text);
    if (norm) {
      if (seen.has(norm)) push(key, "duplicate");
      seen.add(norm);
    }
    const first = openingWord(text);
    if (first) {
      const n = (openings.get(first) ?? 0) + 1;
      openings.set(first, n);
      if (n > MAX_SAME_OPENING) push(key, "repeated_opening");
    }
  }
  return out;
}
