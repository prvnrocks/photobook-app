// Request helpers for POST /api/ai/rewrite (M5 Task 7, D-037). Pure — no server-only imports,
// so the route stays thin and the rules are unit-testable. Route files may only export route
// fields (lessons), so everything else lives here.

import { z } from "zod";
import type { BookDoc } from "@/lib/book/types";
import { CAPTION_LANGS, type CaptionLang } from "@/lib/book/options";
import { codePointLength, hasLoneSurrogate } from "@/lib/text/clip";
import { isUuid } from "@/lib/uuid";
import { RewriteInstructionSchema, wordCount, type RewriteInstruction } from "./schemas";
import { translateTarget } from "./agents/rewriter";

/** Caption text limit in code points (same as the doc caption limit of 200). */
export const REWRITE_TEXT_MAX_CODE_POINTS = 200;
/** Raw body limit in bytes (200 code points × up to 4 UTF-8 bytes + JSON overhead). */
export const REWRITE_MAX_BODY_BYTES = 4096;

export const RewriteBodySchema = z
  .object({
    bookId: z.string().refine(isUuid, { message: "not a uuid" }),
    pageId: z.string().min(1).max(64),
    instruction: RewriteInstructionSchema,
    text: z
      .string()
      .refine((s) => !hasLoneSurrogate(s), { message: "unpaired surrogate" })
      .refine((s) => s.trim().length > 0, { message: "empty" })
      .refine((s) => codePointLength(s) <= REWRITE_TEXT_MAX_CODE_POINTS, { message: "too long" }),
  })
  .strict();

export type RewriteBody = z.infer<typeof RewriteBodySchema>;

/** `shorter` needs at least this many words; shorter captions get 400 too_short. */
export const MIN_WORDS_TO_SHORTEN = 4;

/**
 * True when a caption is too short to be made shorter (≤ 3 whitespace-separated words — works for
 * English and Arabic, same count as the D-030 word check). The route rejects such `shorter`
 * requests before creating a run, so they never burn a model call or a daily-ceiling slot.
 */
export function isTooShortToShorten(text: string): boolean {
  return wordCount(text) < MIN_WORDS_TO_SHORTEN;
}

const ARABIC_LETTER = /[ؠ-ؿف-يٱ-ۓەۺ-ۼۿݐ-ݿࢠ-ࣉﭐ-ﷻﹰ-ﻼ]/g;
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/g;

function asCaptionLang(v: unknown): CaptionLang {
  return (CAPTION_LANGS as readonly unknown[]).includes(v) ? (v as CaptionLang) : "en";
}

/**
 * Target language, computed server-side (never from the client):
 * - translate → the other language (translateTarget: EN↔AR);
 * - otherwise → the caption's own dominant script; a caption without Arabic or Latin letters
 *   (emoji, digits) → the book's caption_lang.
 */
export function rewriteTargetLang(text: string, instruction: RewriteInstruction, bookCaptionLang: unknown): CaptionLang {
  if (instruction === "translate") return translateTarget(text);
  const ar = (text.match(ARABIC_LETTER) ?? []).length;
  const la = (text.match(LATIN_LETTER) ?? []).length;
  if (ar === 0 && la === 0) return asCaptionLang(bookCaptionLang);
  return ar > la ? "ar" : "en";
}

/**
 * Photo ids placed on page `pageId` of the SAVED doc (slot order, unique), or null when the page
 * isn't in the saved doc (e.g. a new page the editor hasn't saved yet) — the route then rewrites
 * without photo notes.
 */
export function pagePhotoIds(doc: Pick<BookDoc, "pages"> | null, pageId: string): string[] | null {
  const page = doc?.pages.find((p) => p.id === pageId);
  if (!page) return null;
  const ids: string[] = [];
  for (const s of page.slots) if (s.photoId && !ids.includes(s.photoId)) ids.push(s.photoId);
  return ids;
}
