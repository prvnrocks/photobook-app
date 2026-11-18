import "server-only";
// photo_ingest (migration 2300) + the storage reads/writes of server-side ingestion.
//
// Admin client throughout: the table is server-written, and the storage objects are read with
// the service role so NO signed URL or path ever leaves the server. Callers MUST have checked
// book ownership under RLS first (getMyBook); every query is filtered by book_id + user_id.
// Never log paths (they contain user / book ids), bytes or metadata — codes only.

import { PHOTOS_BUCKET } from "@/lib/db/photos";
import { HEADER_SCAN_BYTES } from "@/lib/image/header-size";
import { AI_COPY_MAX_BYTES, type IngestRejectReason } from "@/lib/photos/ingest-verify";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";

export class PhotoIngestError extends Error {
  constructor(
    what: string,
    public readonly code: string | undefined,
  ) {
    super(`${what} failed${code ? ` (${code})` : ""}`);
    this.name = "PhotoIngestError";
  }
}

/** Postgres "relation does not exist" / PostgREST "table not in schema cache": migration 2300 not applied yet. */
export function isMissingTable(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

export type IngestPhotoRow = {
  id: string;
  fingerprint: string;
  original_path: string | null;
  thumb_path: string | null;
  original_mime: string | null;
  original_bytes: number | null;
  width: number | null;
  height: number | null;
};

export type IngestStateRow = { photo_id: string; state: string; fingerprint: string; attempts: number };

/** Ready photos of the user's book with what ingestion needs. */
export async function listPhotosForIngest(bookId: string, userId: string): Promise<IngestPhotoRow[]> {
  if (!isUuid(bookId) || !isUuid(userId)) return [];
  const { data, error } = await createAdminClient()
    .from("photos")
    .select("id, fingerprint, original_path, thumb_path, original_mime, original_bytes, width, height")
    .eq("book_id", bookId)
    .eq("user_id", userId)
    .eq("upload_state", "ready")
    .order("id", { ascending: true });
  if (error) throw new PhotoIngestError("list photos for ingest", error.code);
  return data;
}

/** Existing ingest rows of the book. `null` = the table does not exist yet (migration pending). */
export async function listIngestStates(bookId: string, userId: string): Promise<IngestStateRow[] | null> {
  if (!isUuid(bookId) || !isUuid(userId)) return [];
  const { data, error } = await createAdminClient()
    .from("photo_ingest")
    .select("photo_id, state, fingerprint, attempts")
    .eq("book_id", bookId)
    .eq("user_id", userId);
  if (error) {
    if (isMissingTable(error.code)) return null;
    throw new PhotoIngestError("list ingest states", error.code);
  }
  return data;
}

/** Photo ids of the book the server rejected. Empty when the table is missing or unreadable (fail open: the AI loader re-validates every copy itself). */
export async function listRejectedPhotoIds(bookId: string): Promise<Set<string>> {
  if (!isUuid(bookId)) return new Set();
  try {
    const { data, error } = await createAdminClient().from("photo_ingest").select("photo_id").eq("book_id", bookId).eq("state", "rejected");
    if (error || !data) return new Set();
    return new Set(data.map((r) => r.photo_id));
  } catch {
    return new Set();
  }
}

export type IngestOutcome =
  | { state: "verified"; originalFormat: "jpeg" | "png" | "webp"; originalBytes: number; aiCopySha256: string; aiCopyBytes: number; aiCopySanitized: boolean }
  | { state: "rejected"; reason: IngestRejectReason };

/** Upsert by photo_id — writing the same outcome twice leaves one row. */
export async function saveIngestOutcome(
  key: { photoId: string; bookId: string; userId: string; fingerprint: string; attempts: number },
  outcome: IngestOutcome,
): Promise<void> {
  const base = {
    photo_id: key.photoId,
    book_id: key.bookId,
    user_id: key.userId,
    fingerprint: key.fingerprint,
    attempts: key.attempts,
    checked_at: new Date().toISOString(),
  };
  const row: Database["public"]["Tables"]["photo_ingest"]["Insert"] =
    outcome.state === "verified"
      ? {
          ...base,
          state: "verified",
          reason: null,
          original_format: outcome.originalFormat,
          original_bytes: outcome.originalBytes,
          ai_copy_sha256: outcome.aiCopySha256,
          ai_copy_bytes: outcome.aiCopyBytes,
          ai_copy_sanitized: outcome.aiCopySanitized,
        }
      : { ...base, state: "rejected", reason: outcome.reason, original_format: null, original_bytes: null, ai_copy_sha256: null, ai_copy_bytes: null, ai_copy_sanitized: false };
  const { error } = await createAdminClient().from("photo_ingest").upsert(row, { onConflict: "photo_id" });
  if (error) throw new PhotoIngestError("save ingest outcome", error.code);
}

/**
 * First HEADER_SCAN_BYTES of a stored original + the object's total size, WITHOUT downloading
 * the file: a 60-second signed URL is created and fetched here, server-side, with a Range
 * header. The URL is never returned, logged or stored. `null` = object not found.
 */
export async function readOriginalHead(path: string, signal?: AbortSignal): Promise<{ head: Uint8Array; totalBytes: number } | null> {
  const { data, error } = await createAdminClient().storage.from(PHOTOS_BUCKET).createSignedUrl(path, 60);
  if (error || !data?.signedUrl) {
    if (error && /not.?found/i.test(error.message)) return null;
    throw new PhotoIngestError("sign original", undefined);
  }
  const res = await fetch(data.signedUrl, { headers: { range: `bytes=0-${HEADER_SCAN_BYTES - 1}` }, cache: "no-store", signal });
  if (res.status === 404 || res.status === 400) return null;
  if (res.status !== 206 && res.status !== 200) throw new PhotoIngestError("read original head", String(res.status));
  const total = totalFromHeaders(res);
  if (res.status === 200 && total !== null && total > HEADER_SCAN_BYTES * 8) {
    // The server ignored Range for a big object: don't buffer it.
    await res.body?.cancel();
    throw new PhotoIngestError("read original head", "range_ignored");
  }
  const head = new Uint8Array(await res.arrayBuffer()).subarray(0, HEADER_SCAN_BYTES);
  return { head, totalBytes: total ?? head.length };
}

function totalFromHeaders(res: Response): number | null {
  const range = res.headers.get("content-range"); // "bytes 0-262143/5242880"
  const m = range ? /\/(\d+)\s*$/.exec(range) : null;
  if (m) return Number(m[1]);
  if (res.status === 200) {
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > 0) return len;
  }
  return null;
}

/** Whole AI copy (thumb), refused above AI_COPY_MAX_BYTES. `null` = not found; `"too_large"` when oversized. */
export async function downloadAiCopy(path: string): Promise<Uint8Array | "too_large" | null> {
  const { data, error } = await createAdminClient().storage.from(PHOTOS_BUCKET).download(path);
  if (error || !data) {
    if (error && /not.?found/i.test(error.message)) return null;
    throw new PhotoIngestError("download ai copy", undefined);
  }
  if (data.size > AI_COPY_MAX_BYTES) return "too_large";
  return new Uint8Array(await data.arrayBuffer());
}

/** Replaces the stored AI copy with its metadata-free version (same path; the original is never touched). */
export async function replaceAiCopy(path: string, bytes: Uint8Array): Promise<void> {
  const { error } = await createAdminClient()
    .storage.from(PHOTOS_BUCKET)
    .upload(path, new Blob([bytes as BlobPart], { type: "image/jpeg" }), { contentType: "image/jpeg", upsert: true, cacheControl: "3600" });
  if (error) throw new PhotoIngestError("replace ai copy", undefined);
}
