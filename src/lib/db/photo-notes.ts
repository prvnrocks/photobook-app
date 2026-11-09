import "server-only";
// Text notes of a page's photos for the ✨ Rewriter (D-037 #8): taken_at, place and the Curator
// analysis (photos.ai). Admin client — the caller MUST have checked book ownership first
// (getMyBook under RLS); the book_id filter keeps the read inside that book.
// Errors carry only the operation and a Postgres code. Nothing here logs (photo content is user
// data, D-027).
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";

export type PhotoNoteRow = { id: string; takenAt: string | null; place: string | null; ai: Json | null };

/** A page has at most 8 slots. */
export const PHOTO_NOTES_MAX_IDS = 8;

export class PhotoNotesQueryError extends Error {
  readonly code: string | undefined;

  constructor(operation: string, code?: string) {
    super(`Failed to ${operation}${code ? ` (${code})` : ""}`);
    this.name = "PhotoNotesQueryError";
    this.code = code;
  }
}

/**
 * Photos of `bookId` among `photoIds` (non-uuids and duplicates dropped, first 8 kept), returned
 * in the order of `photoIds`. Unknown ids are simply missing.
 */
export async function getPhotoNotesAdmin(bookId: string, photoIds: readonly string[]): Promise<PhotoNoteRow[]> {
  if (!isUuid(bookId)) throw new PhotoNotesQueryError("load photo notes", "invalid_id");
  const ids = [...new Set(photoIds.filter(isUuid))].slice(0, PHOTO_NOTES_MAX_IDS);
  if (ids.length === 0) return [];
  const { data, error } = await createAdminClient()
    .from("photos")
    .select("id, taken_at, place, ai")
    .eq("book_id", bookId)
    .in("id", ids);
  if (error) throw new PhotoNotesQueryError("load photo notes", error.code);
  const byId = new Map((data ?? []).map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [{ id: r.id, takenAt: r.taken_at, place: r.place, ai: r.ai }] : [];
  });
}
