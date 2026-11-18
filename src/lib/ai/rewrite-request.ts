// Request helpers for POST /api/ai/rewrite (M5 Task 7, D-037). Pure — no server-only imports,
// so the route stays thin and the rules are unit-testable. Route files may only export route
// fields (lessons), so everything else lives here.

import { z } from "zod";
import type { BookDoc } from "@/lib/book/types";
import { CAPTION_LANGS, type CaptionLang } from "@/lib/book/options";
import { codePointLength, hasLoneSurrogate } from "@/lib/text/clip";
import { isUuid } from "@/lib/uuid";
import { layoutIdShowsDescription } from "@/lib/layouts/description";
import { AI_TEXT_LIMITS, RewriteInstructionSchema, wordCount, type RewriteInstruction } from "./schemas";
import { REWRITER_MAX_NOTES, translateTarget } from "./agents/rewriter";

/** Caption text limit in code points (same as the doc caption limit of 200). */
export const REWRITE_TEXT_MAX_CODE_POINTS = 200;
/** Raw body limit in bytes (200 code points × up to 4 UTF-8 bytes + JSON overhead). */
export const REWRITE_MAX_BODY_BYTES = 4096;

/** Chapter description text limit in code points (the doc's 400-unit cap; a user may have typed that much). */
export const REWRITE_DESCRIPTION_MAX_CODE_POINTS = AI_TEXT_LIMITS.chapterDescription;

const rewriteText = (maxCodePoints: number) =>
  z
    .string()
    .refine((s) => !hasLoneSurrogate(s), { message: "unpaired surrogate" })
    .refine((s) => s.trim().length > 0, { message: "empty" })
    .refine((s) => codePointLength(s) <= maxCodePoints, { message: "too long" });

/** ✨ on a page caption (M5) — the body the editor has always sent; unchanged. */
export const RewriteCaptionBodySchema = z
  .object({
    bookId: z.string().refine(isUuid, { message: "not a uuid" }),
    pageId: z.string().min(1).max(64),
    instruction: RewriteInstructionSchema,
    text: rewriteText(REWRITE_TEXT_MAX_CODE_POINTS),
  })
  .strict();

/**
 * ✨ on a chapter description (M30 T11): `target: "description"` + the chapter's id instead of a
 * page id. Same instructions, same response, same limits and error codes as a caption rewrite.
 */
export const RewriteDescriptionBodySchema = z
  .object({
    bookId: z.string().refine(isUuid, { message: "not a uuid" }),
    target: z.literal("description"),
    chapterId: z.string().min(1).max(64),
    instruction: RewriteInstructionSchema,
    text: rewriteText(REWRITE_DESCRIPTION_MAX_CODE_POINTS),
  })
  .strict();

/** POST /api/ai/rewrite body: a caption rewrite (no `target`) or a chapter-description rewrite. */
export const RewriteBodySchema = z.union([RewriteCaptionBodySchema, RewriteDescriptionBodySchema]);

export type RewriteCaptionBody = z.infer<typeof RewriteCaptionBodySchema>;
export type RewriteDescriptionBody = z.infer<typeof RewriteDescriptionBodySchema>;
export type RewriteBody = z.infer<typeof RewriteBodySchema>;

export function isDescriptionRewrite(body: RewriteBody): body is RewriteDescriptionBody {
  return "target" in body && body.target === "description";
}

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

export interface ChapterRewriteContext {
  /** The chapter as saved (its title is AI or user text — shown to the model, never allowlisted). */
  chapter: { title: string; dateLabel: string; place: string | null };
  /** Photos of the chapter (the description page's first), unique, ≤ REWRITER_MAX_NOTES. */
  photoIds: string[];
  /** Every page caption of the book (the description must not repeat one verbatim). */
  captions: string[];
  /** The other chapters' descriptions (duplicate guard). */
  otherDescriptions: string[];
}

/**
 * Server-side context of a chapter-description rewrite, read from the SAVED doc (never from the
 * client), or null when the chapter isn't in the saved doc (e.g. not saved yet) — the route then
 * rewrites without chapter notes, like a caption on an unsaved page.
 */
export function chapterRewriteContext(doc: Pick<BookDoc, "chapters" | "pages"> | null, chapterId: string): ChapterRewriteContext | null {
  const chapter = doc?.chapters.find((c) => c.id === chapterId);
  if (!doc || !chapter) return null;
  const pages = doc.pages.filter((p) => p.chapterId === chapterId);
  const ordered = [...pages.filter((p) => layoutIdShowsDescription(p.layout)), ...pages.filter((p) => !layoutIdShowsDescription(p.layout))];
  const photoIds: string[] = [];
  for (const p of ordered) {
    for (const s of p.slots) if (s.photoId && !photoIds.includes(s.photoId) && photoIds.length < REWRITER_MAX_NOTES) photoIds.push(s.photoId);
  }
  return {
    chapter: { title: chapter.title, dateLabel: chapter.dateLabel, place: chapter.place },
    photoIds,
    captions: doc.pages.flatMap((p) => (p.caption?.text.trim() ? [p.caption.text] : [])),
    otherDescriptions: doc.chapters.flatMap((c) => (c.id !== chapterId && c.description?.text.trim() ? [c.description.text] : [])),
  };
}
