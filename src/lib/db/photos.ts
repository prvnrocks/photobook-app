import "server-only";
// Photo queries for the signed-in user's books. Uses the RLS-enforced server
// client (photos_*_own policies on public.photos, photos_*_own policies on
// storage.objects in bucket "photos") — except the finalize writes of
// server-only columns and the AI pipeline queries at the bottom, which need
// the admin client (see there).
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
import type { Json } from "@/lib/supabase/database.types";
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

// ---------------------------------------------------------------------------
// AI pipeline (M3, D-018 / D-027).
//
// Curator reads/writes use the admin client (photos.ai is server-only — 0500
// guard); the orchestrator MUST have checked book ownership first (getMyBook
// under RLS). Every query is filtered by book_id. The user's keep/drop review
// (setUserOverride / listReviewPhotos) uses the RLS client.
// Photo descriptions (photos.ai.description) are never returned to the review
// screen and never logged.

export type CurationPhotoRow = {
  id: string;
  thumb_path: string | null;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  date_source: string | null;
  place: string | null;
  dup_group: number | null;
  blur_score: number | null;
  ai: Json | null;
  status: string;
  drop_reason: string | null;
  user_override: boolean;
  original_mime: string | null;
  camera: string | null;
};

/** Ready photos of the book for the Curator, by taken_at then id. Admin client. */
export async function listPhotosForCuration(bookId: string): Promise<CurationPhotoRow[]> {
  if (!isUuid(bookId)) return [];
  const { data, error } = await createAdminClient()
    .from("photos")
    .select(
      "id, thumb_path, width, height, taken_at, date_source, place, dup_group, blur_score, ai, status, drop_reason, user_override, original_mime, camera",
    )
    .eq("book_id", bookId)
    .eq("upload_state", "ready")
    .order("taken_at", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });
  if (error) throw new PhotosQueryError("list photos for curation", error.code);
  return data;
}

/** Parallel downloads in loadThumbBase64. */
export const THUMB_DOWNLOAD_CONCURRENCY = 5;

/** Thumbs are ~512 px JPEGs (≈30–150 KB); anything bigger isn't one of ours (T16 #17). */
export const THUMB_MAX_BYTES = 1024 * 1024;

/** JPEG SOI + marker prefix. */
function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Downloads thumbs (admin storage) → Map path → base64 (JPEG bytes).
 * Paths that fail to download, are larger than THUMB_MAX_BYTES or don't start
 * with the JPEG magic bytes FF D8 FF are simply absent from the map (the
 * caller treats them as "not analysed" — never sent to the model);
 * duplicates are fetched once. Never throws for a single bad object.
 */
export async function loadThumbBase64(paths: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter((p) => typeof p === "string" && p !== ""))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const bucket = createAdminClient().storage.from(PHOTOS_BUCKET);

  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const path = unique[next++];
      try {
        const { data, error } = await bucket.download(path);
        if (error || !data) continue;
        if (typeof data.size === "number" && data.size > THUMB_MAX_BYTES) continue;
        const bytes = new Uint8Array(await data.arrayBuffer());
        if (bytes.length > THUMB_MAX_BYTES || !isJpeg(bytes)) continue;
        out.set(path, Buffer.from(bytes).toString("base64"));
      } catch {
        // network / decode failure → absent from the map
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(THUMB_DOWNLOAD_CONCURRENCY, unique.length) }, worker),
  );
  return out;
}

export type CurationWrite = {
  id: string;
  /** Omitted → photos.ai untouched (rule decisions never overwrite AI notes). */
  ai?: Json;
  status?: "kept" | "dropped";
  dropReason?: string | null;
};

/** DB limit is 200 code points (0300); clipText on UTF-16 units keeps us under it. */
export const DROP_REASON_MAX = 200;

/** Parallel per-photo `ai` updates in writeCuration. */
const AI_WRITE_CONCURRENCY = 5;

/**
 * Writes Curator results. Admin client, every update filtered by book_id.
 *  1. `ai` on every row that has it (one update per photo — values differ).
 *  2. status / drop_reason grouped by (status, reason), ≤100 ids per request,
 *     with `user_override = false` — the user's own keep/drop always wins (D-018).
 * Rows without `status` only get `ai`. Kept rows get drop_reason = null.
 */
export async function writeCuration(bookId: string, rows: CurationWrite[]): Promise<void> {
  if (!isUuid(bookId) || rows.length === 0) return;
  const valid = rows.filter((r) => isUuid(r.id));
  if (valid.length === 0) return;
  const admin = createAdminClient();

  const withAi = valid.filter((r) => r.ai !== undefined);
  let next = 0;
  const worker = async () => {
    while (next < withAi.length) {
      const r = withAi[next++];
      const { error } = await admin
        .from("photos")
        .update({ ai: r.ai as Json })
        .eq("book_id", bookId)
        .eq("id", r.id);
      if (error) throw new PhotosQueryError("write photo analysis", error.code);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AI_WRITE_CONCURRENCY, withAi.length) }, worker));

  const groups = new Map<string, { status: "kept" | "dropped"; reason: string | null; ids: string[] }>();
  for (const r of valid) {
    if (!r.status) continue;
    const reason =
      r.status === "kept" ? null : r.dropReason ? clipText(r.dropReason.trim(), DROP_REASON_MAX) || null : null;
    const key = JSON.stringify([r.status, reason]);
    const g = groups.get(key) ?? { status: r.status, reason, ids: [] };
    g.ids.push(r.id);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    for (const batch of chunks(g.ids)) {
      const { error } = await admin
        .from("photos")
        .update({ status: g.status, drop_reason: g.reason })
        .eq("book_id", bookId)
        .eq("user_override", false)
        .in("id", batch);
      if (error) throw new PhotosQueryError("write photo curation", error.code);
    }
  }
}

/** drop_reason written when the user removes a photo themselves. */
export const USER_DROP_REASON = "user_removed";

/**
 * The user's own keep/drop decision (RLS client; these columns are
 * client-writable by design, 0500). Sets user_override = true so the AI never
 * changes it again. Returns false when the photo isn't visible / not in the book.
 */
export async function setUserOverride(bookId: string, photoId: string, keep: boolean): Promise<boolean> {
  if (!isUuid(bookId) || !isUuid(photoId)) return false;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("photos")
    .update({
      status: keep ? "kept" : "dropped",
      drop_reason: keep ? null : USER_DROP_REASON,
      user_override: true,
    })
    .eq("id", photoId)
    .eq("book_id", bookId)
    .select("id");
  if (error) throw new PhotosQueryError("save photo choice", error.code);
  return data.length === 1;
}

export type ReviewPhoto = {
  id: string;
  status: string;
  dropReason: string | null;
  userOverride: boolean;
  dupGroup: number | null;
  quality: number | null;
  scene: string | null;
  coverWorthy: boolean | null;
  width: number | null;
  height: number | null;
  takenAt: string | null;
  /** Signed thumb URL (valid REVIEW_URL_TTL_SECONDS), null when unavailable. */
  thumbUrl: string | null;
};

export const REVIEW_URL_TTL_SECONDS = 600;

/**
 * Photos for the keep/drop review screen (RLS client). Only small AI fields
 * (quality / scene / coverWorthy) are selected — never the description.
 * Thumb URLs are signed in one createSignedUrls call.
 */
export async function listReviewPhotos(bookId: string): Promise<ReviewPhoto[]> {
  if (!isUuid(bookId)) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("photos")
    .select(
      "id, status, drop_reason, user_override, dup_group, width, height, taken_at, thumb_path, quality:ai->quality, scene:ai->>scene, coverWorthy:ai->coverWorthy",
    )
    .eq("book_id", bookId)
    .eq("upload_state", "ready")
    .order("taken_at", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });
  if (error) throw new PhotosQueryError("list review photos", error.code);
  const rows = data as unknown as {
    id: string;
    status: string;
    drop_reason: string | null;
    user_override: boolean;
    dup_group: number | null;
    width: number | null;
    height: number | null;
    taken_at: string | null;
    thumb_path: string | null;
    quality: unknown;
    scene: unknown;
    coverWorthy: unknown;
  }[];

  const paths = [...new Set(rows.map((r) => r.thumb_path).filter((p): p is string => !!p))];
  const urls = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed, error: signError } = await supabase.storage
      .from(PHOTOS_BUCKET)
      .createSignedUrls(paths, REVIEW_URL_TTL_SECONDS);
    if (signError) {
      const code =
        "statusCode" in signError && typeof signError.statusCode === "string" ? signError.statusCode : "storage";
      throw new PhotosQueryError("sign thumb urls", code);
    }
    for (const s of signed) if (s.path && s.signedUrl && !s.error) urls.set(s.path, s.signedUrl);
  }

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    dropReason: r.drop_reason,
    userOverride: r.user_override,
    dupGroup: r.dup_group,
    quality: typeof r.quality === "number" && Number.isFinite(r.quality) ? r.quality : null,
    scene: typeof r.scene === "string" ? r.scene : null,
    coverWorthy: typeof r.coverWorthy === "boolean" ? r.coverWorthy : null,
    width: r.width,
    height: r.height,
    takenAt: r.taken_at,
    thumbUrl: r.thumb_path ? (urls.get(r.thumb_path) ?? null) : null,
  }));
}
