// Maps Postgres/PostgREST errors from photo inserts/updates to typed upload
// errors. Pure — used by the browser upload queue (direct inserts under RLS)
// and by server code. Never echoes the error text back to the user.
import { LIMITS } from "@/lib/ai/limits";

export type UploadDbError =
  | { kind: "photo_limit_reached"; limit: number }
  | { kind: "duplicate" }
  | { kind: "not_allowed" }
  | { kind: "unknown" };

export type DbErrorLike = {
  code?: string;
  message?: string;
  hint?: string;
  details?: string;
};

const FINGERPRINT_KEY = "photos_book_fingerprint_key";

/**
 * - P0001 'photo_limit_reached' (photos_enforce_cap trigger, hint = limit) →
 *   photo_limit_reached. A missing/garbled hint falls back to the free limit.
 * - 23505 on photos_book_fingerprint_key → duplicate (same file already in the
 *   book: treat as "already have it", look up the existing row).
 * - 42501 (RLS / grants) → not_allowed.
 * - anything else (including other unique violations) → unknown.
 */
export function mapUploadDbError(e: DbErrorLike | null | undefined): UploadDbError {
  if (!e) return { kind: "unknown" };

  if (e.code === "P0001" && e.message === "photo_limit_reached") {
    const n = Number.parseInt(e.hint ?? "", 10);
    return {
      kind: "photo_limit_reached",
      limit: Number.isFinite(n) && n > 0 ? n : LIMITS.free.maxUploadPhotos,
    };
  }

  if (e.code === "23505") {
    const text = `${e.message ?? ""} ${e.details ?? ""}`;
    return text.includes(FINGERPRINT_KEY) ? { kind: "duplicate" } : { kind: "unknown" };
  }

  if (e.code === "42501") return { kind: "not_allowed" };

  return { kind: "unknown" };
}
