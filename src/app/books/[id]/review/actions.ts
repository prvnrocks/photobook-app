"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { learnFromBook } from "@/lib/ai/learn-from-book";
import { autolayout } from "@/lib/autolayout";
import { bookDesignOf, isSupportedDesign, isUnsupportedDesignError, withBookDesign } from "@/lib/book/book-design";
import { getCurrentUser } from "@/lib/auth/current-user";
import { CAPTION_LANGS, OCCASIONS, type CaptionLang, type Occasion } from "@/lib/book/options";
import { relayoutDoc, type RelayoutPhoto } from "@/lib/book/relayout";
import { isEmptyDoc, isReplaceableDoc } from "@/lib/book/replaceable";
import { serializeDoc } from "@/lib/book/doc-version";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { getActiveRunForBook } from "@/lib/db/agent-runs";
import { getBookForRun, getMyBook, writeDocIfReplaceable, type BookForRun } from "@/lib/db/books";
import { listPhotosForCuration, setUserOverride, type CurationPhotoRow } from "@/lib/db/photos";
import { errorCodeOf } from "@/lib/http/json";
import type { Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";

const MSG_SIGNED_OUT = "Please sign in again.";
const MSG_NOT_FOUND = "That book or photo wasn't found.";
const MSG_SAVE_FAILED = "We couldn't save that. Please try again.";

/**
 * Review screen (M3): the user keeps or removes one photo. Sets user_override so the AI never
 * changes this choice again ("AI drafts, the user decides").
 */
export async function togglePhotoAction(
  bookId: string,
  photoId: string,
  keep: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isUuid(bookId) || !isUuid(photoId) || typeof keep !== "boolean") {
    return { ok: false, error: MSG_NOT_FOUND };
  }
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: MSG_SIGNED_OUT };

  try {
    const book = await getMyBook(bookId);
    if (!book) return { ok: false, error: MSG_NOT_FOUND };
    const saved = await setUserOverride(book.id, photoId, keep);
    if (!saved) return { ok: false, error: MSG_NOT_FOUND };
  } catch (err) {
    console.error(`[review] toggle photo failed (${errorCodeOf(err)})`);
    return { ok: false, error: MSG_SAVE_FAILED };
  }
  revalidatePath(`/books/${bookId}/review`);
  return { ok: true };
}

export type UpdateAlbumResult =
  | { ok: true; changed: boolean; pages: number }
  | { ok: false; error: "signed_out" | "not_found" | "user_edited" | "busy" | "unsupported_design" | "failed" };

/**
 * "Update album" (D-028): re-lays out the current album after review keep/drop changes with the
 * rule-based filler (relayoutDoc) — AI chapters, title and order kept, dropped photos removed,
 * newly kept photos added by time. A `{}` doc gets a fresh rule album. Free and unlimited: no AI
 * call, no agent_runs row, not counted against any limit. Refused while a run is active (busy) or
 * when the album was edited by the user (user_edited). A design style without layouts
 * (geometric / scrapbook rows, M10b A19 review S1) → unsupported_design, nothing written.
 * Logs error codes only, never photo data.
 */
export async function updateAlbumAction(bookId: string): Promise<UpdateAlbumResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "signed_out" };
  if (typeof bookId !== "string" || !isUuid(bookId)) return { ok: false, error: "not_found" };

  try {
    const mine = await getMyBook(bookId);
    if (!mine) return { ok: false, error: "not_found" };
    if (!isSupportedDesign(bookDesignOf(mine))) return { ok: false, error: "unsupported_design" };
    if (await getActiveRunForBook(mine.id)) return { ok: false, error: "busy" };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const book = await getBookForRun(mine.id);
      if (!book) return { ok: false, error: "not_found" };
      if (!isReplaceableDoc(book.doc)) return { ok: false, error: "user_edited" };

      const rows = await listPhotosForCuration(book.id);
      const next = nextDoc(book, rows.map(toRelayoutPhoto));
      if (next === "invalid") return { ok: false, error: "user_edited" };
      if (!next.changed) return { ok: true, changed: false, pages: next.doc?.pages.length ?? 0 };
      const doc = next.doc as BookDoc;

      // guard "relayout" (D-031): user captions don't block Update album — relayoutDoc keeps them.
      const write = await writeDocIfReplaceable(
        book.id,
        serializeDoc(doc) as unknown as Json,
        doc.pages.length,
        { updatedAt: book.updated_at },
        { guard: "relayout" },
      );
      if (write.ok) {
        revalidatePath(`/books/${book.id}/review`);
        revalidatePath("/dashboard");
        return { ok: true, changed: true, pages: doc.pages.length };
      }
      if (write.reason === "user_edited") return { ok: false, error: "user_edited" };
      if (write.reason === "not_found") return { ok: false, error: "not_found" };
      // conflict: the book changed since we read it → reload and retry once
    }
    return { ok: false, error: "busy" };
  } catch (err) {
    if (isUnsupportedDesignError(err)) return { ok: false, error: "unsupported_design" };
    console.error(`[review] update album failed (${errorCodeOf(err)})`);
    return { ok: false, error: "failed" };
  }
}

/**
 * Review "Continue" (form action, D-032): the user accepts the album. Ownership is checked under
 * RLS; then — best effort — the Memory Keeper learns tone / caption language / caption length
 * from this book and saves it. Memory failures never block the user: they are logged with an
 * error code only (never prefs, captions or ids) and the user still lands in the editor
 * (/books/[id]/edit, M5 Task 12 — the editor itself redirects to build/upload when needed).
 */
export async function confirmAlbumAction(bookId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user) {
    const next = typeof bookId === "string" && isUuid(bookId) ? `/books/${bookId}/review` : "/dashboard";
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  if (typeof bookId !== "string" || !isUuid(bookId)) redirect("/dashboard");

  let mine: Awaited<ReturnType<typeof getMyBook>> = null;
  try {
    mine = await getMyBook(bookId);
  } catch (err) {
    console.error(`[review] confirm album: load failed (${errorCodeOf(err)})`);
  }
  if (!mine) redirect("/dashboard");

  await learnFromBook(user.id, mine.id, "review");
  revalidatePath("/dashboard");
  redirect(`/books/${mine.id}/edit`);
}

function toRelayoutPhoto(r: CurationPhotoRow): RelayoutPhoto & { dateSource: "exif" | "file" | null } {
  const positive = (v: number | null) => (v !== null && Number.isFinite(v) && v > 0 ? v : 1);
  return {
    id: r.id,
    width: positive(r.width),
    height: positive(r.height),
    takenAt: r.taken_at,
    dateSource: r.date_source === "exif" || r.date_source === "file" ? r.date_source : null,
    status: r.status === "dropped" ? "dropped" : "kept",
    place: r.place,
    dupGroup: r.dup_group,
    blurScore: r.blur_score,
  };
}

/** The doc to write, `{ changed:false }` for a no-op, or "invalid" for an unparsable doc. */
function nextDoc(
  book: BookForRun,
  photos: (RelayoutPhoto & { dateSource: "exif" | "file" | null })[],
): { changed: boolean; doc: BookDoc | null } | "invalid" {
  const occasion: Occasion = (OCCASIONS as readonly string[]).includes(book.occasion ?? "")
    ? (book.occasion as Occasion)
    : "other";
  const captionLang: CaptionLang = (CAPTION_LANGS as readonly string[]).includes(book.caption_lang ?? "")
    ? (book.caption_lang as CaptionLang)
    : "en";
  const isPaid = book.is_paid === true;
  // D-063 (M10b A6): format + design style always from books.format / books.design_style.
  const design = bookDesignOf(book);

  if (isEmptyDoc(book.doc)) {
    if (!photos.some((p) => p.status === "kept")) return { changed: false, doc: null };
    // Fresh rule album (meta generator "rule", runId null, D-018).
    const fresh = autolayout(photos, { occasion, title: book.title, captionLang, isPaid, runId: null, design });
    return { changed: true, doc: withBookDesign(fresh, design) };
  }
  const parsed = parseBookDoc(book.doc);
  if (!parsed.ok) return "invalid"; // isReplaceableDoc already refuses this; belt and braces
  // Stamped before relayoutDoc so its validation checks layouts against the book's columns.
  const stamped = withBookDesign(parsed.doc, design);
  const r = relayoutDoc(stamped, photos, { isPaid, maxPages: book.max_pages, captionLang });
  return { changed: r.changed || stamped !== parsed.doc, doc: r.doc };
}
