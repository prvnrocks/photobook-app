"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withAnalyticsFlash } from "@/lib/analytics/flash";
import { AUTH_UNAVAILABLE, getActionUser } from "@/lib/auth/action-user";
import { bookDesignOf } from "@/lib/book/book-design";
import { serializeDoc } from "@/lib/book/doc-version";
import {
  CAPTION_LANGS,
  DEFAULT_TONE,
  OCCASIONS,
  TONES,
  type CaptionLang,
  type Occasion,
  type Tone,
} from "@/lib/book/options";
import { docOrigin, isEmptyDoc } from "@/lib/book/replaceable";
import { BookFormatSchema, DesignStyleSchema } from "@/lib/book/schema";
import { buildRuleDraft } from "@/lib/book/rule-draft";
import {
  designLockReason,
  detailsLockReason,
  type BookSetup,
  type BookSetupField,
  type BookSetupPatch,
  type UpdateBookSetupResult,
} from "@/lib/book/setup";
import { deleteBookCompletely } from "@/lib/cleanup/delete-book";
import type { DeleteBookActionResult } from "@/lib/dashboard/delete-book";
import { hasAnyRunForBook } from "@/lib/db/agent-runs";
import {
  createBook,
  getMyBook,
  stripPhotoFromBookDoc,
  writeBookSetup,
  type BookSetupColumns,
} from "@/lib/db/books";
import { getOwnMemoryView } from "@/lib/db/memory";
import { deletePhoto, deleteUnfinished, listReadyPhotosForFinalize } from "@/lib/db/photos";
import { DEFAULT_FORM_FORMAT, defaultStyleFor, isFormDesignStyle } from "@/lib/design/defaults";
import { suggestCaptionLang, toneForOccasion } from "@/lib/design/infer";
import type { Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";
import {
  cleanTitle,
  TITLE_MAX_CHARS,
  titleLength,
  type NewBookField,
  type NewBookFormState,
  type PhotoActionResult,
} from "./form-state";

const MSG_FIX_FIELDS = "Please check the highlighted fields.";
const MSG_CREATE_FAILED = "We couldn't create your book. Please try again.";
const MSG_DELETE_FAILED = "We couldn't delete that. Please try again.";
const MSG_SIGNED_OUT = "Please sign in again.";
const MSG_NOT_FOUND = "That book or photo wasn't found.";

const NewBookSchema = z.object({
  title: z
    .string({ error: "Please enter a valid title." })
    .nullable()
    .transform(cleanTitle)
    .refine((t) => t === null || titleLength(t) <= TITLE_MAX_CHARS, {
      error: `Title must be ${TITLE_MAX_CHARS} characters or fewer.`,
    }),
  occasion: z.enum(OCCASIONS, { error: "Please choose an occasion." }),
  // M19 (D-071): the wizard doesn't ask for tone / caption language. Absent → worked out here
  // (remembered value, D-032, else occasion default / Accept-Language); any value sent is validated.
  tone: z.preprocess(absentToUndefined, z.enum(TONES, { error: "Please choose a tone." }).optional()),
  captionLang: z.preprocess(
    absentToUndefined,
    z.enum(CAPTION_LANGS, { error: "Please choose a caption language." }).optional(),
  ),
  // D-063: fixed at creation. Absent (a form rendered before M10b) → portrait / the occasion's
  // default style (D-068); any value sent must be in the enum and one the form offers (all four
  // since M10c).
  format: z.preprocess(
    absentToUndefined,
    z.enum(BookFormatSchema.options, { error: "Please choose a shape." }).optional(),
  ),
  designStyle: z.preprocess(
    absentToUndefined,
    z
      .enum(DesignStyleSchema.options, { error: "Please choose a style." })
      .refine(isFormDesignStyle, { error: "Please choose a style." })
      .optional(),
  ),
});

function absentToUndefined(v: unknown): unknown {
  return v === null ? undefined : v;
}

const FIELDS: readonly NewBookField[] = ["title", "occasion", "tone", "captionLang", "format", "designStyle"];

/**
 * Creates a book. Form fields: `title` (optional), `occasion`, `tone` + `captionLang` (optional
 * since M19 / D-071: absent → remembered tone / language (D-032, best effort) else
 * DEFAULT_TONE[occasion] / the request's Accept-Language ("ar" first → "ar", else "en")),
 * `format` + `designStyle` (D-063, fixed at creation; absent → portrait / the occasion's default
 * style, D-068). On success redirects to /books/<id>/upload (never returns); signed out →
 * /login?next=/books/new.
 */
export async function createBookAction(
  _prevState: NewBookFormState,
  formData: FormData,
): Promise<NewBookFormState> {
  const user = await getActionUser();
  if (user === AUTH_UNAVAILABLE) return { ok: false, error: MSG_CREATE_FAILED };
  if (!user) redirect("/login?next=/books/new");

  const parsed = NewBookSchema.safeParse({
    title: formData.get("title"),
    occasion: formData.get("occasion"),
    tone: formData.get("tone"),
    captionLang: formData.get("captionLang"),
    format: formData.get("format"),
    designStyle: formData.get("designStyle"),
  });
  if (!parsed.success) {
    const fieldErrors: NewBookFormState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && (FIELDS as readonly string[]).includes(key)) {
        fieldErrors[key as NewBookField] ??= issue.message;
      }
    }
    return { ok: false, error: MSG_FIX_FIELDS, fieldErrors };
  }

  const { format, designStyle, tone, captionLang, title, occasion } = parsed.data;
  // Only read memory / headers when something must be worked out (memory read is best effort).
  const needsDefaults = tone === undefined || captionLang === undefined;
  const [memory, acceptLanguage] = needsDefaults
    ? await Promise.all([
        getOwnMemoryView().catch(() => null),
        captionLang === undefined ? requestAcceptLanguage() : Promise.resolve(""),
      ])
    : [null, ""];

  let id: string;
  try {
    ({ id } = await createBook({
      title,
      occasion,
      tone: tone ?? toneForOccasion(occasion, memory?.tone),
      captionLang: captionLang ?? suggestCaptionLang(acceptLanguage, memory?.language),
      format: format ?? DEFAULT_FORM_FORMAT,
      designStyle: designStyle ?? defaultStyleFor(occasion),
    }));
  } catch (err) {
    console.error("[books] create failed:", err instanceof Error ? err.message : "unknown");
    return { ok: false, error: MSG_CREATE_FAILED };
  }

  revalidatePath("/dashboard");
  // analytics (M9 T14): one-shot ?_ev=book_created only when PostHog is configured.
  redirect(withAnalyticsFlash(`/books/${id}/upload`, "book_created"));
}

/** Accept-Language of the current request ("" when unavailable). */
async function requestAcceptLanguage(): Promise<string> {
  try {
    return (await headers()).get("accept-language") ?? "";
  } catch {
    return "";
  }
}

const BookSetupPatchSchema = z
  .object({
    occasion: z.enum(OCCASIONS, { error: "Please choose an occasion." }).optional(),
    tone: z.enum(TONES, { error: "Please choose a tone." }).optional(),
    captionLang: z.enum(CAPTION_LANGS, { error: "Please choose a caption language." }).optional(),
    title: z
      .string({ error: "Please enter a valid title." })
      .nullable()
      .transform(cleanTitle)
      .refine((t) => t === null || titleLength(t) <= TITLE_MAX_CHARS, {
        error: `Title must be ${TITLE_MAX_CHARS} characters or fewer.`,
      })
      .optional(),
    format: z.enum(BookFormatSchema.options, { error: "Please choose a shape." }).optional(),
    designStyle: z
      .enum(DesignStyleSchema.options, { error: "Please choose a style." })
      .refine(isFormDesignStyle, { error: "Please choose a style." })
      .optional(),
  })
  .strict();

const SETUP_FIELDS: readonly BookSetupField[] = ["occasion", "tone", "captionLang", "title", "format", "designStyle"];
const DESIGN_FIELDS: readonly BookSetupField[] = ["format", "designStyle"];
/** Fields the rule draft depends on (tone isn't used by autolayout). */
const DRAFT_FIELDS: readonly BookSetupField[] = ["occasion", "title", "captionLang", "format", "designStyle"];

const pickEnum = <T extends string>(v: string | null, values: readonly T[], fallback: T): T =>
  (values as readonly string[]).includes(v ?? "") ? (v as T) : fallback;

/**
 * Changes a book's setup (the upload screen's setup card). Owner only (getMyBook under RLS + owner
 * filter on the admin write). Rules (src/lib/book/setup.ts, re-checked here every time):
 *   - every field (D-070 + M13 review / D-037 #7): only while no AI run exists AND the doc isn't
 *     user-edited (a user's cover title must win, so an edited album locks title / details too).
 * Only fields whose value actually differs count (sending the unchanged setup back is a no-op).
 * When a non-edited rule draft exists and occasion / title / language / shape / style changed, the
 * draft is re-laid out like finalize does (columns + doc in ONE write, so books.format /
 * design_style and doc.format / designStyle always agree); a shape/style change whose draft can't
 * be rebuilt is refused ("failed"). Write = admin + owner filter + updated_at lock; one retry on a
 * conflict. Enums / title limits are validated like createBookAction (invalid → fieldErrors).
 */
export async function updateBookSetupAction(
  bookId: string,
  patch: BookSetupPatch,
): Promise<UpdateBookSetupResult> {
  if (!isUuid(bookId)) return { ok: false, error: "not_found" };
  const parsed = BookSetupPatchSchema.safeParse(patch ?? {});
  if (!parsed.success) {
    const fieldErrors: Partial<Record<BookSetupField, string>> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && (SETUP_FIELDS as readonly string[]).includes(key)) {
        fieldErrors[key as BookSetupField] ??= issue.message;
      }
    }
    return { ok: false, error: "invalid", fieldErrors };
  }
  const wanted = parsed.data;
  if (!SETUP_FIELDS.some((f) => wanted[f] !== undefined)) return { ok: false, error: "invalid" };

  const user = await getActionUser();
  if (user === AUTH_UNAVAILABLE) return { ok: false, error: "failed" };
  if (!user) return { ok: false, error: "unauthenticated" };

  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const book = await getMyBook(bookId);
      if (!book) return { ok: false, error: "not_found" };

      const occasion = pickEnum<Occasion>(book.occasion, OCCASIONS, "other");
      const design = bookDesignOf(book);
      const current: BookSetup = {
        occasion,
        tone: pickEnum<Tone>(book.tone, TONES, DEFAULT_TONE[occasion]),
        captionLang: pickEnum<CaptionLang>(book.caption_lang, CAPTION_LANGS, "en"),
        title: book.title,
        format: design.format,
        designStyle: design.designStyle,
      };
      const changed = SETUP_FIELDS.filter((f) => wanted[f] !== undefined && wanted[f] !== current[f]);
      if (changed.length === 0) return { ok: true, setup: current, relaidOut: false };
      const designChanged = changed.some((f) => DESIGN_FIELDS.includes(f));

      const hasRun = await hasAnyRunForBook(book.id);
      const detailsLock = detailsLockReason({ hasRun, doc: book.doc });
      if (detailsLock) return { ok: false, error: "locked", reason: detailsLock };
      if (designChanged) {
        const designLock = designLockReason({ hasRun, doc: book.doc });
        if (designLock) return { ok: false, error: "locked", reason: designLock };
        // Before migration 1900 there is no column to hold the change.
        if (book.format === null || book.design_style === null) return { ok: false, error: "failed" };
      }

      const next: BookSetup = { ...current };
      for (const f of changed) (next as Record<BookSetupField, unknown>)[f] = wanted[f];

      // Re-lay out an untouched rule draft (never a user-edited or AI album; `{}` waits for finalize).
      let draft: { doc: Json; pageCount: number } | undefined;
      const origin = docOrigin(book.doc);
      const relayout =
        changed.some((f) => DRAFT_FIELDS.includes(f)) &&
        !isEmptyDoc(book.doc) &&
        !origin.userEdited &&
        origin.generator === "rule";
      if (relayout) {
        const photos = await listReadyPhotosForFinalize(book.id);
        const built = buildRuleDraft(photos, {
          occasion: next.occasion,
          title: next.title,
          captionLang: next.captionLang,
          isPaid: book.is_paid,
          design: { format: next.format, designStyle: next.designStyle },
        });
        if (built.ok) {
          draft = { doc: serializeDoc(built.doc) as unknown as Json, pageCount: built.pageCount };
        } else {
          console.error(`[books] setup draft not rebuilt (${built.reason})`);
          // The doc must keep agreeing with books.format / design_style: refuse a design change.
          if (designChanged) return { ok: false, error: "failed" };
        }
      }

      // Re-check right before the write: a run may have started since the first check.
      // Residual race (M13 review SHOULD 5, accepted for now): a run created between this check and
      // the UPDATE below isn't seen — the updated_at lock only catches a run that already wrote the
      // doc, not one that is merely queued / reading the setup. The window is one round trip
      // (~tens of ms). Closing it needs one atomic RPC ("update setup WHERE NOT EXISTS agent_runs")
      // in a migration — deliberately not added in M13.
      if (await hasAnyRunForBook(book.id)) return { ok: false, error: "locked", reason: "ai_started" };

      const columns: BookSetupColumns = {};
      if (changed.includes("occasion")) columns.occasion = next.occasion;
      if (changed.includes("tone")) columns.tone = next.tone;
      if (changed.includes("captionLang")) columns.caption_lang = next.captionLang;
      if (changed.includes("title")) columns.title = next.title;
      if (changed.includes("format")) columns.format = next.format;
      if (changed.includes("designStyle")) columns.design_style = next.designStyle;

      const written = await writeBookSetup(book.id, user.id, columns, book.updated_at, draft);
      if (written.ok) {
        revalidatePath(`/books/${book.id}/upload`);
        return { ok: true, setup: next, relaidOut: draft !== undefined };
      }
      if (written.reason === "not_found") return { ok: false, error: "not_found" };
      // conflict: the row changed since we read it → reload and re-check once
    }
    return { ok: false, error: "conflict" };
  } catch (err) {
    console.error("[books] setup update failed:", err instanceof Error ? err.message : "unknown");
    return { ok: false, error: "failed" };
  }
}

/**
 * Deletes one photo (files + row) of the current user's book, then strips it from the book doc
 * (slots/cover → empty, backgrounds using it removed; M10a review S3). The doc cleanup is best
 * effort: the photo is gone either way; if it fails, Update album drops the dangling references
 * (relayoutDoc) and the editor reports them as foreign_photo on save. The book id for the
 * cleanup comes from the deleted row, never from the client.
 */
export async function deletePhotoAction(
  photoId: string,
  bookId: string,
): Promise<PhotoActionResult> {
  if (!isUuid(photoId) || !isUuid(bookId)) return { ok: false, error: MSG_NOT_FOUND };
  const user = await getActionUser();
  if (user === AUTH_UNAVAILABLE) return { ok: false, error: MSG_DELETE_FAILED };
  if (!user) return { ok: false, error: MSG_SIGNED_OUT };

  let ownerBookId: string | null;
  try {
    ownerBookId = await deletePhoto(photoId);
  } catch (err) {
    console.error("[books] delete photo failed:", err instanceof Error ? err.message : "unknown");
    return { ok: false, error: MSG_DELETE_FAILED };
  }
  if (ownerBookId !== null) {
    try {
      const r = await stripPhotoFromBookDoc(ownerBookId, photoId);
      if (r === "conflict") console.error("[books] strip deleted photo from doc: conflict");
    } catch (err) {
      console.error("[books] strip deleted photo from doc failed:", err instanceof Error ? err.message : "unknown");
    }
    revalidatePath(`/books/${ownerBookId}/edit`);
  }
  revalidatePath(`/books/${bookId}/upload`);
  return { ok: true };
}

/** Deletes all `pending` photos (files + rows) of the current user's book. */
export async function deleteUnfinishedAction(bookId: string): Promise<PhotoActionResult> {
  if (!isUuid(bookId)) return { ok: false, error: MSG_NOT_FOUND };
  const user = await getActionUser();
  if (user === AUTH_UNAVAILABLE) return { ok: false, error: MSG_DELETE_FAILED };
  if (!user) return { ok: false, error: MSG_SIGNED_OUT };

  try {
    await deleteUnfinished(bookId);
  } catch (err) {
    console.error(
      "[books] delete unfinished failed:",
      err instanceof Error ? err.message : "unknown",
    );
    return { ok: false, error: MSG_DELETE_FAILED };
  }
  revalidatePath(`/books/${bookId}/upload`);
  return { ok: true };
}

/**
 * Dashboard "Delete book" (D-060): deletes the signed-in user's book (row via delete_book_guarded,
 * then its Storage prefixes). Refuses books with a payment ('protected'); a foreign or missing
 * book is 'not_found'. Storage failures still count as deleted (the orphan sweep finishes them).
 */
export async function deleteBookAction(bookId: string): Promise<DeleteBookActionResult> {
  const user = await getActionUser();
  if (user === AUTH_UNAVAILABLE) return { ok: false, error: "failed" };
  if (!user) return { ok: false, error: "unauthenticated" };
  if (!isUuid(bookId)) return { ok: false, error: "not_found" };

  const result = await deleteBookCompletely({ bookId, userId: user.id });
  if (!result.ok) {
    if (result.error === "protected") return { ok: false, error: "protected" };
    if (result.error === "failed") return { ok: false, error: "failed" };
    // Already gone (e.g. deleted in another tab): refresh the list so the card disappears.
    revalidatePath("/dashboard");
    return { ok: false, error: "not_found" };
  }
  revalidatePath("/dashboard");
  return { ok: true };
}
