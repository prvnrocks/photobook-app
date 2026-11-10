import "server-only";
// Housekeeping queries (M9, migration 1600, D-055 / D-056 / D-057). admin_ai_spend_daily (D-059)
// is wrapped in src/lib/db/ai-spend.ts. Secret-key admin
// client only: every 1600 RPC is EXECUTE-granted to service_role alone.
//
// `supabase gen types` types RETURNS TABLE columns as non-null — the wrappers below correct that
// (books.title is nullable; auth_user_email may be null if the account vanished mid-claim).
//
// Errors carry only the operation and a Postgres / Storage code — never ids, paths, titles or
// emails. Nothing here logs; callers log counts only.
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";
import { STORAGE_REMOVE_MAX, type CleanupBucket, type WarningKind } from "@/lib/cleanup/rules";

/** Order statuses that make a book "protected" (same list as the 1600 RPCs). */
export const PROTECTED_ORDER_STATUSES = ["pending", "paid", "needs_review", "disputed"] as const;

/** Objects per Storage list() page. */
export const STORAGE_LIST_PAGE = 1000;
/** Hard cap on objects one removeStoragePrefix call collects (a book has ≤ 500 photos × 5 files). */
export const STORAGE_PREFIX_MAX_OBJECTS = 20_000;

function safeCode(code: unknown): string {
  const s = typeof code === "string" ? code : "unknown";
  return s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
}

export class CleanupQueryError extends Error {
  readonly code: string;
  constructor(op: string, code: unknown) {
    const safe = safeCode(code);
    super(`cleanup: ${op} failed (${safe})`);
    this.name = "CleanupQueryError";
    this.code = safe;
  }
}

export class CleanupStorageError extends Error {
  readonly code: string;
  constructor(op: string, code: unknown) {
    const safe = safeCode(code);
    super(`cleanup storage: ${op} failed (${safe})`);
    this.name = "CleanupStorageError";
    this.code = safe;
  }
}

/** Storage errors: `statusCode` is a string ("403"/"404"/…), `status` is always 400. */
function storageCode(error: unknown): string {
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "string") {
    return error.statusCode;
  }
  return "storage";
}

// ---------------------------------------------------------------------------
// Row types (corrected nullability)

export type BookRef = { userId: string; bookId: string };

export type PendingUploadRow = BookRef & { photoId: string; paths: string[] };

export type ExpiryWarningRow = {
  bookId: string;
  userId: string;
  email: string | null;
  title: string | null;
  expiresAt: string;
  isLive: boolean;
};

export type DraftWarningRow = {
  bookId: string;
  userId: string;
  email: string | null;
  title: string | null;
  lastActivityAt: string;
  deleteAfter: string;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

function bookRefs(rows: { user_id: string | null; book_id: string | null }[] | null): BookRef[] {
  const out: BookRef[] = [];
  for (const r of rows ?? []) {
    if (isUuid(r.user_id) && isUuid(r.book_id)) out.push({ userId: r.user_id, bookId: r.book_id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RPC wrappers

/** Deletes up to `limit` free books expired more than `graceDays` ago; returns their prefixes. */
export async function deleteExpiredBooks(limit: number, graceDays: number): Promise<BookRef[]> {
  const { data, error } = await createAdminClient().rpc("cleanup_delete_expired_books", {
    p_limit: limit,
    p_grace_days: graceDays,
  });
  if (error) throw new CleanupQueryError("delete expired books", error.code);
  return bookRefs(data);
}

/** Deletes up to `limit` abandoned never-published drafts; returns their prefixes. */
export async function deleteAbandonedDrafts(limit: number, days: number, noticeDays: number): Promise<BookRef[]> {
  const { data, error } = await createAdminClient().rpc("cleanup_delete_abandoned_drafts", {
    p_limit: limit,
    p_days: days,
    p_notice_days: noticeDays,
  });
  if (error) throw new CleanupQueryError("delete abandoned drafts", error.code);
  return bookRefs(data);
}

/** Deletes up to `limit` photo rows stuck in 'pending'; returns the storage paths to remove. */
export async function deletePendingUploads(limit: number, days: number): Promise<PendingUploadRow[]> {
  const { data, error } = await createAdminClient().rpc("cleanup_pending_uploads", {
    p_limit: limit,
    p_days: days,
  });
  if (error) throw new CleanupQueryError("delete pending uploads", error.code);
  const out: PendingUploadRow[] = [];
  for (const r of data ?? []) {
    if (!isUuid(r.photo_id)) continue;
    out.push({
      userId: r.user_id,
      bookId: r.book_id,
      photoId: r.photo_id,
      paths: Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === "string" && p !== "") : [],
    });
  }
  return out;
}

/** Read-only: names of objects in `bucket` older than `days` with no matching row. */
export async function listOrphanObjects(bucket: CleanupBucket, days: number, limit: number): Promise<string[]> {
  const { data, error } = await createAdminClient().rpc("cleanup_orphan_objects", {
    p_bucket: bucket,
    p_days: days,
    p_limit: limit,
  });
  if (error) throw new CleanupQueryError("list orphan objects", error.code);
  return (data ?? []).map((r) => r.name).filter((n): n is string => typeof n === "string" && n !== "");
}

/** Deletes superseded / failed export rows (no object) finished more than `days` ago. */
export async function deleteOldExportRows(days: number): Promise<number> {
  const { data, error } = await createAdminClient().rpc("cleanup_old_exports", { p_days: days });
  if (error) throw new CleanupQueryError("delete old exports", error.code);
  return num(data);
}

/** Deletes password unlock attempts older than `hours` (≥ 24). */
export async function deleteOldUnlockAttempts(hours: number): Promise<number> {
  const { data, error } = await createAdminClient().rpc("cleanup_unlock_attempts", { p_hours: hours });
  if (error) throw new CleanupQueryError("delete unlock attempts", error.code);
  return num(data);
}

/** Marks unfinished AI runs idle for `hours` as failed ('stale') and settles their books. */
export async function reapStaleAgentRuns(hours: number): Promise<number> {
  const { data, error } = await createAdminClient().rpc("reap_stale_agent_runs", { p_hours: hours });
  if (error) throw new CleanupQueryError("reap stale agent runs", error.code);
  return num(data);
}

/**
 * Claims (marks sent) up to `limit` "link expires soon" warnings. The caller sends the emails and
 * calls releaseWarning(bookId, "expiry") for any that failed, so the next run retries them.
 */
export async function claimExpiryWarnings(limit: number, daysBefore: number): Promise<ExpiryWarningRow[]> {
  const { data, error } = await createAdminClient().rpc("claim_expiry_warnings", {
    p_limit: limit,
    p_days_before: daysBefore,
  });
  if (error) throw new CleanupQueryError("claim expiry warnings", error.code);
  return (data ?? []).map((r) => ({
    bookId: r.book_id,
    userId: r.user_id,
    email: strOrNull(r.email),
    title: strOrNull(r.title),
    expiresAt: r.expires_at,
    isLive: r.is_live === true,
  }));
}

/** Claims up to `limit` "draft will be deleted" warnings (see claimExpiryWarnings). */
export async function claimDraftWarnings(limit: number, warnDays: number, deleteDays: number): Promise<DraftWarningRow[]> {
  const { data, error } = await createAdminClient().rpc("claim_draft_warnings", {
    p_limit: limit,
    p_warn_days: warnDays,
    p_delete_days: deleteDays,
  });
  if (error) throw new CleanupQueryError("claim draft warnings", error.code);
  return (data ?? []).map((r) => ({
    bookId: r.book_id,
    userId: r.user_id,
    email: strOrNull(r.email),
    title: strOrNull(r.title),
    lastActivityAt: r.last_activity_at,
    deleteAfter: r.delete_after,
  }));
}

/** Un-claims a warning (email failed) so the next run retries it. True when a claim was cleared. */
export async function releaseWarning(bookId: string, kind: WarningKind): Promise<boolean> {
  if (!isUuid(bookId)) return false;
  const { data, error } = await createAdminClient().rpc("release_warning", { p_book: bookId, p_kind: kind });
  if (error) throw new CleanupQueryError("release warning", error.code);
  return data === true;
}

// ---------------------------------------------------------------------------
// Owner book delete (D-060) — used by deleteBookCompletely

export type DeleteBookRowResult = "deleted" | "not_found" | "protected";

async function hasProtectedOrder(bookId: string): Promise<boolean> {
  const { count, error } = await createAdminClient()
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId)
    .in("status", [...PROTECTED_ORDER_STATUSES]);
  if (error) throw new CleanupQueryError("check book orders", error.code);
  return (count ?? 0) > 0;
}

/**
 * Deletes the owner's book row unless it is protected (is_paid, or an order in a protected
 * status). The delete itself is guarded (`id` + `user_id` + `is_paid = false`), so a book that
 * became paid after the order check is never deleted. Cascades photos / exports / unlock attempts
 * / AI notes; orders and agent runs keep their rows with book_id null.
 *
 * Known window (no migration in this wave): an order inserted between the order check and the
 * delete would end up with book_id null. Only the owner can create one, by starting checkout on
 * the book they are deleting at the same moment. A guarded RPC can close it later.
 */
export async function deleteOwnUnprotectedBook(bookId: string, userId: string): Promise<DeleteBookRowResult> {
  if (!isUuid(bookId) || !isUuid(userId)) return "not_found";
  const admin = createAdminClient();

  const { data: book, error: readError } = await admin
    .from("books")
    .select("id, is_paid")
    .eq("id", bookId)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) throw new CleanupQueryError("read book", readError.code);
  if (!book) return "not_found";
  if (book.is_paid) return "protected";
  if (await hasProtectedOrder(bookId)) return "protected";

  const { data: deleted, error: deleteError } = await admin
    .from("books")
    .delete()
    .eq("id", bookId)
    .eq("user_id", userId)
    .eq("is_paid", false)
    .select("id");
  if (deleteError) throw new CleanupQueryError("delete book", deleteError.code);
  if ((deleted ?? []).length > 0) return "deleted";

  // Nothing deleted: either it became paid meanwhile, or it is gone.
  const { data: again, error: againError } = await admin
    .from("books")
    .select("id")
    .eq("id", bookId)
    .eq("user_id", userId)
    .maybeSingle();
  if (againError) throw new CleanupQueryError("read book", againError.code);
  return again ? "protected" : "not_found";
}

// ---------------------------------------------------------------------------
// Storage

const PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;

/** `{userId}/{bookId}/` — the only prefix shape removeStoragePrefix accepts. */
export function bookPrefix(userId: string, bookId: string): string {
  return `${userId}/${bookId}/`;
}

/**
 * Removes `paths` from `bucket` in batches of ≤ STORAGE_REMOVE_MAX. Missing objects are not an
 * error. Returns the number of objects Storage reports removed. Throws CleanupStorageError.
 */
export async function removeStoragePaths(bucket: CleanupBucket, paths: readonly string[]): Promise<number> {
  const unique = [...new Set(paths.filter((p) => typeof p === "string" && p !== ""))];
  if (unique.length === 0) return 0;
  const store = createAdminClient().storage.from(bucket);
  let removed = 0;
  for (let i = 0; i < unique.length; i += STORAGE_REMOVE_MAX) {
    const { data, error } = await store.remove(unique.slice(i, i + STORAGE_REMOVE_MAX));
    if (error) throw new CleanupStorageError("remove", storageCode(error));
    removed += Array.isArray(data) ? data.length : 0;
  }
  return removed;
}

/**
 * Lists every object under `{userId}/{bookId}/` (recursively, paginated) and removes them.
 * Refuses any other prefix shape so a bug can never empty a bucket. Throws CleanupStorageError.
 */
export async function removeStoragePrefix(bucket: CleanupBucket, prefix: string): Promise<number> {
  if (!PREFIX_RE.test(prefix)) throw new CleanupStorageError("remove prefix", "invalid_prefix");
  const store = createAdminClient().storage.from(bucket);
  const names: string[] = [];
  const dirs = [prefix.replace(/\/+$/, "")];

  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    for (let offset = 0; ; offset += STORAGE_LIST_PAGE) {
      const { data, error } = await store.list(dir, {
        limit: STORAGE_LIST_PAGE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new CleanupStorageError("list", storageCode(error));
      const items = data ?? [];
      for (const item of items) {
        if (!item?.name) continue;
        const full = `${dir}/${item.name}`;
        // Folders (common prefixes) come back with id null.
        if (item.id === null || item.id === undefined) dirs.push(full);
        else names.push(full);
      }
      if (names.length > STORAGE_PREFIX_MAX_OBJECTS) {
        throw new CleanupStorageError("list", "too_many_objects");
      }
      if (items.length < STORAGE_LIST_PAGE) break;
    }
  }

  return removeStoragePaths(bucket, names);
}
