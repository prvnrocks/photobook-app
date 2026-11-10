"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withAnalyticsFlash } from "@/lib/analytics/flash";
import { getCurrentUser } from "@/lib/auth/current-user";
import { CAPTION_LANGS, OCCASIONS, TONES } from "@/lib/book/options";
import { deleteBookCompletely } from "@/lib/cleanup/delete-book";
import type { DeleteBookActionResult } from "@/lib/dashboard/delete-book";
import { createBook, stripPhotoFromBookDoc } from "@/lib/db/books";
import { deletePhoto, deleteUnfinished } from "@/lib/db/photos";
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
  tone: z.enum(TONES, { error: "Please choose a tone." }),
  captionLang: z.enum(CAPTION_LANGS, { error: "Please choose a caption language." }),
});

const FIELDS: readonly NewBookField[] = ["title", "occasion", "tone", "captionLang"];

/**
 * Creates a book. Form fields: `title` (optional), `occasion`, `tone`,
 * `captionLang`. On success redirects to /books/<id>/upload (never returns);
 * signed out → /login?next=/books/new.
 */
export async function createBookAction(
  _prevState: NewBookFormState,
  formData: FormData,
): Promise<NewBookFormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/books/new");

  const parsed = NewBookSchema.safeParse({
    title: formData.get("title"),
    occasion: formData.get("occasion"),
    tone: formData.get("tone"),
    captionLang: formData.get("captionLang"),
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

  let id: string;
  try {
    ({ id } = await createBook(parsed.data));
  } catch (err) {
    console.error("[books] create failed:", err instanceof Error ? err.message : "unknown");
    return { ok: false, error: MSG_CREATE_FAILED };
  }

  // analytics (M9 T14): one-shot ?_ev=book_created only when PostHog is configured.
  redirect(withAnalyticsFlash(`/books/${id}/upload`, "book_created"));
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
  const user = await getCurrentUser();
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
  const user = await getCurrentUser();
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
  const user = await getCurrentUser();
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
