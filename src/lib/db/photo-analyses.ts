import "server-only";
// photo_analyses (migration 2400): the Photo Intelligence cache + usage log, and the
// access-checked photo read the service starts from.
//
// The table is service-role only. Every function takes the user id that the caller proved
// (loadOwnPhoto reads through RLS, so a photo of another user simply does not exist here) and
// filters by it. Nothing in this file logs; errors carry an operation name and a Postgres code.

import type { PhotoVision } from "@/lib/storybook/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export class PhotoAnalysesError extends Error {
  constructor(
    what: string,
    public readonly code: string | undefined,
  ) {
    super(`${what} failed${code ? ` (${code})` : ""}`);
    this.name = "PhotoAnalysesError";
  }
}

const missingTable = (code: string | undefined) => code === "42P01" || code === "PGRST205";

export type OwnPhoto = {
  id: string;
  user_id: string;
  book_id: string;
  upload_state: string;
  thumb_path: string | null;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  date_source: string | null;
  lat: number | null;
  lng: number | null;
  place: string | null;
  blur_score: number | null;
  dup_group: number | null;
  color: string | null;
  ai: Json | null;
  status: string;
  drop_reason: string | null;
  user_override: boolean;
  /** books.is_paid of the photo's book (limits). */
  bookIsPaid: boolean;
};

/**
 * The signed-in user's own photo, read with THEIR session (RLS): another user's photo, a missing
 * photo and a malformed id all return null — the caller cannot tell them apart, on purpose.
 */
export async function loadOwnPhoto(photoId: string): Promise<OwnPhoto | null> {
  if (!isUuid(photoId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("photos")
    .select(
      "id, user_id, book_id, upload_state, thumb_path, width, height, taken_at, date_source, lat, lng, place, blur_score, dup_group, color, ai, status, drop_reason, user_override, books!inner(is_paid)",
    )
    .eq("id", photoId)
    .maybeSingle();
  if (error) throw new PhotoAnalysesError("load photo", error.code);
  if (!data) return null;
  const { books, ...row } = data as typeof data & { books: { is_paid: boolean } | { is_paid: boolean }[] };
  const book = Array.isArray(books) ? books[0] : books;
  return { ...row, bookIsPaid: book?.is_paid === true };
}

/**
 * loadOwnPhoto for several ids in ONE RLS read (photo analysis batches). Same columns, same rule:
 * ids that are malformed, missing or not the caller's are simply absent from the map.
 */
export async function loadOwnPhotos(photoIds: readonly string[]): Promise<Map<string, OwnPhoto>> {
  const ids = [...new Set(photoIds.filter((id) => isUuid(id)))];
  const out = new Map<string, OwnPhoto>();
  if (ids.length === 0) return out;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("photos")
    .select(
      "id, user_id, book_id, upload_state, thumb_path, width, height, taken_at, date_source, lat, lng, place, blur_score, dup_group, color, ai, status, drop_reason, user_override, books!inner(is_paid)",
    )
    .in("id", ids);
  if (error) throw new PhotoAnalysesError("load photos", error.code);
  for (const d of data ?? []) {
    const { books, ...row } = d as typeof d & { books: { is_paid: boolean } | { is_paid: boolean }[] };
    const book = Array.isArray(books) ? books[0] : books;
    out.set(row.id, { ...row, bookIsPaid: book?.is_paid === true });
  }
  return out;
}

export type CacheKey = { userId: string; imageSha256: string; model: string; promptVersion: string };

export type CachedAnalysis = { analysis: unknown; model: string; promptVersion: string };

/** The stored analysis for the key, `null` on a miss, `"unavailable"` while migration 2400 is missing. */
export async function getCachedAnalysis(key: CacheKey): Promise<CachedAnalysis | null | "unavailable"> {
  const { data, error } = await createAdminClient()
    .from("photo_analyses")
    .select("analysis, model, prompt_version")
    .eq("user_id", key.userId)
    .eq("image_sha256", key.imageSha256)
    .eq("model", key.model)
    .eq("prompt_version", key.promptVersion)
    .eq("status", "ok")
    .maybeSingle();
  if (error) {
    if (missingTable(error.code)) return "unavailable";
    throw new PhotoAnalysesError("read analysis cache", error.code);
  }
  return data ? { analysis: data.analysis, model: data.model, promptVersion: data.prompt_version } : null;
}

/**
 * getCachedAnalysis for several images of ONE user / model / prompt version in one read:
 * sha → stored analysis (misses are absent), or `"unavailable"` while migration 2400 is missing.
 * The cache key is unique for 'ok' rows (photo_analyses_cache_key_idx), so a sha has ≤ 1 row.
 */
export async function getCachedAnalyses(key: Omit<CacheKey, "imageSha256">, imageSha256s: readonly string[]): Promise<Map<string, CachedAnalysis> | "unavailable"> {
  const shas = [...new Set(imageSha256s)];
  const out = new Map<string, CachedAnalysis>();
  if (shas.length === 0) return out;
  const { data, error } = await createAdminClient()
    .from("photo_analyses")
    .select("image_sha256, analysis, model, prompt_version")
    .eq("user_id", key.userId)
    .in("image_sha256", shas)
    .eq("model", key.model)
    .eq("prompt_version", key.promptVersion)
    .eq("status", "ok");
  if (error) {
    if (missingTable(error.code)) return "unavailable";
    throw new PhotoAnalysesError("read analysis cache", error.code);
  }
  for (const r of data ?? []) out.set(r.image_sha256, { analysis: r.analysis, model: r.model, promptVersion: r.prompt_version });
  return out;
}

export type CallRecord = {
  userId: string;
  bookId: string;
  photoId: string;
  imageSha256: string;
  model: string;
  promptVersion: string;
  mode: "live" | "replay";
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  latencyMs: number;
} & ({ status: "ok"; analysis: PhotoVision } | { status: "error"; error: string });

/**
 * Stores one call. An 'ok' row that loses the race for its cache key (another request stored the
 * same analysis first — unique violation) is not an error: the result is still returned to the
 * caller, and the row is kept as an 'error' row "cache_race" so its cost is still counted.
 */
export async function recordAnalysisCall(rec: CallRecord): Promise<void> {
  const base = {
    user_id: rec.userId,
    book_id: rec.bookId,
    photo_id: rec.photoId,
    image_sha256: rec.imageSha256,
    model: rec.model.slice(0, 64),
    prompt_version: rec.promptVersion,
    mode: rec.mode,
    input_tokens: Math.max(0, Math.round(rec.usage.input)),
    output_tokens: Math.max(0, Math.round(rec.usage.output)),
    cache_read_tokens: Math.max(0, Math.round(rec.usage.cacheRead)),
    cache_write_tokens: Math.max(0, Math.round(rec.usage.cacheWrite)),
    cost_usd: Math.max(0, rec.costUsd),
    latency_ms: Math.max(0, Math.round(rec.latencyMs)),
  };
  const admin = createAdminClient();
  const row: Database["public"]["Tables"]["photo_analyses"]["Insert"] =
    rec.status === "ok"
      ? { ...base, status: "ok", analysis: rec.analysis as unknown as Json, error: null }
      : { ...base, status: "error", analysis: null, error: rec.error.replace(/[^a-z_]/g, "_").slice(0, 40).padEnd(3, "_") };
  const { error } = await admin.from("photo_analyses").insert(row);
  if (!error) return;
  if (error.code === "23505" && rec.status === "ok") {
    const again = await admin.from("photo_analyses").insert({ ...base, status: "error", analysis: null, error: "cache_race" });
    if (!again.error) return;
    throw new PhotoAnalysesError("record analysis call", again.error.code);
  }
  throw new PhotoAnalysesError("record analysis call", error.code);
}

/** Photos of the book that already have a usable LIVE analysis (the free / paid analysis limit). */
export async function countAnalysedPhotos(bookId: string, userId: string): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("photo_analyses")
    .select("photo_id")
    .eq("book_id", bookId)
    .eq("user_id", userId)
    .eq("status", "ok")
    .eq("mode", "live")
    .limit(2000);
  if (error) throw new PhotoAnalysesError("count analysed photos", error.code);
  return new Set(data.map((r) => r.photo_id)).size;
}

/** Start of the current Asia/Dubai day (UTC+4, no DST) — the day the AI budget is counted over (D-059). */
export function dubaiDayStart(now: number = Date.now()): string {
  const offset = 4 * 60 * 60 * 1000;
  const day = Math.floor((now + offset) / 86_400_000) * 86_400_000 - offset;
  return new Date(day).toISOString();
}

/** USD spent by live photo-analysis calls today (all users). */
export async function getTodayPhotoAnalysisSpendUsd(now: number = Date.now()): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("photo_analyses")
    .select("cost_usd")
    .eq("mode", "live")
    .gte("created_at", dubaiDayStart(now))
    .limit(10000);
  if (error) throw new PhotoAnalysesError("read photo analysis spend", error.code);
  return data.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);
}
