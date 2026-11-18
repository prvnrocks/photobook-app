"use server";

// Wizard story step ("Every memory has a story.", Task 5): saves / loads the user's answers in the
// book's memory context and recommends a design. Owner only: getMyBook under RLS proves ownership,
// then the admin write is filtered by book_id + user_id (src/lib/db/storybooks.ts).
// Answers are user data: nothing typed by the user is ever logged — codes only.

import { z } from "zod";
import { AUTH_UNAVAILABLE, getActionUser } from "@/lib/auth/action-user";
import { CAPTION_LANGS, DEFAULT_TONE, OCCASIONS, TONES, type CaptionLang, type Occasion, type Tone } from "@/lib/book/options";
import { getMyBook } from "@/lib/db/books";
import { listReadyPhotosForFinalize } from "@/lib/db/photos";
import { getMemoryContext, saveMemoryContext, type MemoryContextInput } from "@/lib/db/storybooks";
import { recommendDesign } from "@/lib/design/recommend";
import {
  EMPTY_STORY_ANSWERS,
  type RecommendDesignResult,
  type StoryAnswersInput,
  type StoryAnswersResult,
  type StoryAnswersView,
} from "@/lib/story/answers";
import { STORY_ANSWER_MAX, STORY_QUESTIONS_MAX, STORY_TONES, storyQuestionsFor } from "@/lib/story/questions";
import { STORYBOOK_SCHEMA_VERSION } from "@/lib/storybook/schemas";
import type { MemoryContext } from "@/lib/storybook/types";
import { codePointLength, hasLoneSurrogate } from "@/lib/text/clip";
import { isUuid } from "@/lib/uuid";

/**
 * Raw input bound (UTF-16 units) before trimming: STORY_ANSWER_MAX code points are at most 2×
 * units; the rest is room for surrounding whitespace. Anything bigger is refused unread.
 */
const RAW_ANSWER_MAX_UNITS = STORY_ANSWER_MAX * 4;

const InputSchema = z
  .object({
    storyTone: z.enum(STORY_TONES).nullable(),
    answers: z
      .array(z.object({ questionId: z.string().min(1).max(60), text: z.string().max(RAW_ANSWER_MAX_UNITS) }).strict())
      .max(STORY_QUESTIONS_MAX),
    skipped: z.boolean(),
  })
  .strict();

const pickEnum = <T extends string>(v: string | null, values: readonly T[], fallback: T): T =>
  (values as readonly string[]).includes(v ?? "") ? (v as T) : fallback;

type OwnedBook = { occasion: string | null; tone: string | null; caption_lang: string | null };

function bookBasics(book: OwnedBook): { occasion: Occasion; tone: Tone; lang: CaptionLang } {
  const occasion = pickEnum<Occasion>(book.occasion, OCCASIONS, "other");
  return {
    occasion,
    tone: pickEnum<Tone>(book.tone, TONES, DEFAULT_TONE[occasion]),
    lang: pickEnum<CaptionLang>(book.caption_lang, CAPTION_LANGS, "en"),
  };
}

/** Only answers to the questions the book's CURRENT occasion asks are shown (the occasion may have changed). */
function viewOf(context: MemoryContext, occasion: Occasion): StoryAnswersView {
  const asked = new Set(storyQuestionsFor(occasion).map((q) => q.id));
  return {
    storyTone: context.storyTone,
    answers: context.answers.filter((a) => asked.has(a.questionId)).map((a) => ({ questionId: a.questionId, text: a.text })),
    skipped: context.skipped,
    rev: context.rev,
  };
}

/**
 * Saves the story step. Rules (all enforced here, never trusted from the client):
 *   - every questionId must be one of storyQuestionsFor(book.occasion), each at most once;
 *   - answers are trimmed; a blank answer is dropped (a skipped question stores nothing);
 *     an answer over STORY_ANSWER_MAX code points or with a lone surrogate → "invalid";
 *   - the stored `question` is the server's prompt for the id; `source` is always "user";
 *   - `skipped: true` stores no answers (any sent are ignored) and the given storyTone (or null);
 *   - occasion / tone / lang come from the book row; people, places, facts, note, avoid, narrator
 *     and dateRange are kept from the stored context (defaults when there is none).
 */
export async function saveStoryAnswersAction(bookId: string, input: StoryAnswersInput): Promise<StoryAnswersResult> {
  if (!isUuid(bookId)) return { ok: false, error: "not_found" };
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const wanted = parsed.data;

  const user = await getActionUser();
  if (user === AUTH_UNAVAILABLE) return { ok: false, error: "unavailable" };
  if (!user) return { ok: false, error: "unauthenticated" };

  try {
    const book = await getMyBook(bookId);
    if (!book) return { ok: false, error: "not_found" };
    const basics = bookBasics(book);

    const prompts = new Map(storyQuestionsFor(basics.occasion).map((q) => [q.id, q.prompt]));
    const seen = new Set<string>();
    const answers: MemoryContextInput["answers"] = [];
    for (const a of wanted.answers) {
      const question = prompts.get(a.questionId);
      if (question === undefined || seen.has(a.questionId)) return { ok: false, error: "invalid" };
      seen.add(a.questionId);
      const text = a.text.trim();
      if (hasLoneSurrogate(text) || codePointLength(text) > STORY_ANSWER_MAX) return { ok: false, error: "invalid" };
      if (text === "" || wanted.skipped) continue;
      answers.push({ questionId: a.questionId, question, text, source: "user" });
    }

    const existing = await getMemoryContext(book.id, user.id);
    const next: MemoryContextInput = {
      v: STORYBOOK_SCHEMA_VERSION,
      ...basics,
      storyTone: wanted.storyTone,
      answers,
      skipped: wanted.skipped,
      note: existing?.note ?? null,
      people: existing?.people ?? [],
      places: existing?.places ?? [],
      facts: existing?.facts ?? [],
      avoid: existing?.avoid ?? [],
      narrator: existing?.narrator ?? "first_plural",
      dateRange: existing?.dateRange ?? null,
    };
    const saved = await saveMemoryContext(book.id, user.id, next);
    return { ok: true, context: viewOf(saved, basics.occasion) };
  } catch (err) {
    console.error(`[story] save answers failed (${errorCode(err)})`);
    return { ok: false, error: "unavailable" };
  }
}

/** The stored story step of the user's book, or the empty defaults (rev 0) when nothing is stored. */
export async function loadStoryAnswersAction(bookId: string): Promise<StoryAnswersResult> {
  if (!isUuid(bookId)) return { ok: false, error: "not_found" };
  const user = await getActionUser();
  if (user === AUTH_UNAVAILABLE) return { ok: false, error: "unavailable" };
  if (!user) return { ok: false, error: "unauthenticated" };

  try {
    const book = await getMyBook(bookId);
    if (!book) return { ok: false, error: "not_found" };
    const context = await getMemoryContext(book.id, user.id);
    if (!context) return { ok: true, context: { ...EMPTY_STORY_ANSWERS, answers: [] } };
    return { ok: true, context: viewOf(context, bookBasics(book).occasion) };
  } catch (err) {
    console.error(`[story] load answers failed (${errorCode(err)})`);
    return { ok: false, error: "unavailable" };
  }
}

/**
 * Recommended shape + style for the user's book, from its READY photos' pixel sizes and its
 * occasion (src/lib/design/recommend.ts). A recommendation only — nothing is written.
 */
export async function recommendDesignAction(bookId: string): Promise<RecommendDesignResult> {
  if (!isUuid(bookId)) return { ok: false, error: "not_found" };
  const user = await getActionUser();
  if (user === AUTH_UNAVAILABLE) return { ok: false, error: "unavailable" };
  if (!user) return { ok: false, error: "unauthenticated" };

  try {
    const book = await getMyBook(bookId);
    if (!book) return { ok: false, error: "not_found" };
    const photos = await listReadyPhotosForFinalize(book.id);
    const occasion = (OCCASIONS as readonly string[]).includes(book.occasion ?? "") ? (book.occasion as Occasion) : null;
    return {
      ok: true,
      recommendation: recommendDesign({ occasion, photos: photos.map((p) => ({ width: p.width, height: p.height })) }),
    };
  } catch (err) {
    console.error(`[story] recommend design failed (${errorCode(err)})`);
    return { ok: false, error: "unavailable" };
  }
}

/** A short code for the log: never the message of an unknown error (it could carry user text). */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const name = err instanceof Error ? err.name : "unknown";
  return typeof code === "string" && /^[\w-]{1,40}$/.test(code) ? `${name}:${code}` : name;
}
