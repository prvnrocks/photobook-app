import "server-only";
// Photo queries for the signed-in user's books. Uses the RLS-enforced server
// client (photos_*_own policies on public.photos, photos_*_own policies on
// storage.objects in bucket "photos") — except the finalize writes of
// server-only columns at the bottom, which need the admin client (see there).
//
// Delete order (deletePhoto / deleteUnfinished): storage objects FIRST, row
// SECOND. If storage removal fails we throw and keep the row, so the paths stay
// known and the delete can be retried — a row without files is visible to the
// user, while files without a row would be invisible orphans. Removing paths
// that are already missing is not an error in Supabase Storage (it returns the
// removed objects, possibly none), so a retry after a partial failure succeeds.
//
// Errors carry only the operation and a Postgres/Storage code — never ids,
// paths or other user data.
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { clipText } from "@/lib/text/clip";
import { isUuid } from "@/lib/uuid";

export const PHOTOS_BUCKET = "photos";

/** Max paths per storage remove call and ids per `in` filter (keeps URLs short). */
const CHUNK = 100;

export type UploadStateRow = {
  id: string;
  fingerprint: string;
  upload_state: string;
};

export class PhotosQueryError extends Error {
  readonly code: string | undefined;

  constructor(operation: string, code?: string) {
    super(`Failed to ${operation}${code ? ` (${code})` : ""}`);
    this.name = "PhotosQueryError";
    this.code = code;
  }
}

type PathRow = {
  original_path: string | null;
  web_path: string | null;
  thumb_path: string | null;
};

function pathsOf(rows: PathRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    for (const p of [r.original_path, r.web_path, r.thumb_path]) if (p) out.push(p);
  }
  return out;
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type ServerClient = Awaited<ReturnType<typeof createClient>>;

async function removeObjects(supabase: ServerClient, paths: string[], operation: string) {
  for (const batch of chunks(paths)) {
    const { error } = await supabase.storage.from(PHOTOS_BUCKET).remove(batch);
    if (error) {
      const code =
        "statusCode" in error && typeof error.statusCode === "string" ? error.statusCode : "storage";
      throw new PhotosQueryError(operation, code);
    }
  }
}

/** id + fingerprint + upload_state of every photo in the book (for resume, D-013). */
export async function listUploadState(bookId: string): Promise<UploadStateRow[]> {
  if (!isUuid(bookId)) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("photos")
    .select("id, fingerprint, upload_state")
    .eq("book_id", bookId);

  if (error) throw new PhotosQueryError("list upload state", error.code);
  return data;
}

/** Number of photo rows (pending + ready) in the book — what the cap trigger counts. */
export async function countPhotos(bookId: string): Promise<number> {
  if (!isUuid(bookId)) return 0;
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("photos")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId);

  if (error) throw new PhotosQueryError("count photos", error.code);
  return count ?? 0;
}

/**
 * Deletes one photo: its storage objects (original/web/thumb, nulls skipped),
 * then the row. No-op when the id is malformed or the row isn't visible
 * (missing or not the caller's — RLS). Throws PhotosQueryError and keeps the
 * row when storage removal fails.
 */
export async function deletePhoto(photoId: string): Promise<void> {
  if (!isUuid(photoId)) return;
  const supabase = await createClient();

  const { data: row, error: loadError } = await supabase
    .from("photos")
    .select("id, original_path, web_path, thumb_path")
    .eq("id", photoId)
    .maybeSingle();
  if (loadError) throw new PhotosQueryError("load photo", loadError.code);
  if (!row) return;

  await removeObjects(supabase, pathsOf([row]), "remove photo files");

  const { error: deleteError } = await supabase.from("photos").delete().eq("id", row.id);
  if (deleteError) throw new PhotosQueryError("delete photo", deleteError.code);
}

/**
 * Deletes every `pending` photo of the book (rows inserted before upload that
 * never reached `ready`) plus whatever objects they already have.
 * Rows are deleted by id AND upload_state = 'pending', so a row that turned
 * ready meanwhile is kept — but its objects may already be removed; callers
 * must stop the upload queue before calling this. Returns the number of rows
 * deleted.
 */
export async function deleteUnfinished(bookId: string): Promise<number> {
  if (!isUuid(bookId)) return 0;
  const supabase = await createClient();

  const { data: rows, error: loadError } = await supabase
    .from("photos")
    .select("id, original_path, web_path, thumb_path")
    .eq("book_id", bookId)
    .eq("upload_state", "pending");
  if (loadError) throw new PhotosQueryError("list unfinished photos", loadError.code);
  if (rows.length === 0) return 0;

  await removeObjects(supabase, pathsOf(rows), "remove unfinished photo files");

  let deleted = 0;
  for (const ids of chunks(rows.map((r) => r.id))) {
    const { error, count } = await supabase
      .from("photos")
      .delete({ count: "exact" })
      .eq("book_id", bookId)
      .eq("upload_state", "pending")
      .in("id", ids);
    if (error) throw new PhotosQueryError("delete unfinished photos", error.code);
    deleted += count ?? 0;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Finalize (T9, D-017): read ready photos, write dup_group / place in batches.

export type FinalizePhotoRow = {
  id: string;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  date_source: string | null;
  lat: number | null;
  lng: number | null;
  place: string | null;
  phash: string | null;
  blur_score: number | null;
  status: string;
  dup_group: number | null;
  place_checked_at: string | null;
};

/** Every `ready` photo of the book with the columns finalize needs. [] for a malformed id. */
export async function listReadyPhotosForFinalize(bookId: string): Promise<FinalizePhotoRow[]> {
  if (!isUuid(bookId)) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("photos")
    .select(
      "id, width, height, taken_at, date_source, lat, lng, place, phash, blur_score, status, dup_group, place_checked_at",
    )
    .eq("book_id", bookId)
    .eq("upload_state", "ready")
    .order("id", { ascending: true });

  if (error) throw new PhotosQueryError("list photos for finalize", error.code);
  return data;
}

// Server-only columns (dup_group, place, place_checked_at) are guarded by the
// photos_protect_columns trigger (0500): a user-role update keeps their old
// values. So these writes use the secret-key admin client. Callers MUST have
// checked ownership first (finalizeBook → getMyBook under RLS) and pass ids
// read through RLS (listReadyPhotosForFinalize); every update is also filtered
// by book_id so ids from another book can never match.

/** Max place label length stored (UTF-16 units; ≤ the DB's 200 code points). */
export const PLACE_MAX = 120;

/** Sets dup_group (or null) on the given photos of the book, ≤100 ids per request. Admin client. */
export async function setPhotosDupGroup(
  bookId: string,
  ids: string[],
  dupGroup: number | null,
): Promise<void> {
  if (!isUuid(bookId) || ids.length === 0) return;
  const admin = createAdminClient();
  for (const batch of chunks(ids)) {
    const { error } = await admin
      .from("photos")
      .update({ dup_group: dupGroup })
      .eq("book_id", bookId)
      .in("id", batch);
    if (error) throw new PhotosQueryError("update duplicate groups", error.code);
  }
}

/**
 * Sets place on the given photos of the book, only where place IS NULL (never
 * overwrites a place set meanwhile). The label is clipped Unicode-safely to
 * PLACE_MAX (no lone surrogates). ≤100 ids per request. Admin client.
 */
export async function setPhotosPlace(bookId: string, ids: string[], place: string): Promise<void> {
  if (!isUuid(bookId) || ids.length === 0) return;
  const label = clipText(place.trim(), PLACE_MAX);
  if (label === "") return;
  const admin = createAdminClient();
  for (const batch of chunks(ids)) {
    const { error } = await admin
      .from("photos")
      .update({ place: label })
      .eq("book_id", bookId)
      .is("place", null)
      .in("id", batch);
    if (error) throw new PhotosQueryError("update places", error.code);
  }
}

/** Records a geocode attempt (any result) on the given photos of the book. Admin client. */
export async function setPhotosPlaceChecked(
  bookId: string,
  ids: string[],
  checkedAt: string,
): Promise<void> {
  if (!isUuid(bookId) || ids.length === 0) return;
  const admin = createAdminClient();
  for (const batch of chunks(ids)) {
    const { error } = await admin
      .from("photos")
      .update({ place_checked_at: checkedAt })
      .eq("book_id", bookId)
      .in("id", batch);
    if (error) throw new PhotosQueryError("update place checks", error.code);
  }
}
