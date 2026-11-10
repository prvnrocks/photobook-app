import "server-only";
// Deletes one book of one user completely (D-060): row first via the delete_book_guarded RPC
// (migration 1700 — never a paid / comped / payment-pending book),
// then its Storage prefixes in `photos` and `exports`. Row-then-storage (D-056): a Storage failure
// leaves invisible objects without a row, which the daily orphan sweep removes after
// ORPHAN_OBJECT_DAYS; it never leaves a visible book with missing files.
//
// The caller (delete-book / delete-account server actions) must pass the AUTHENTICATED user's id;
// the delete filters on it, so a foreign book id answers 'not_found'.
// Logs: codes and counts only — never ids, paths or titles.
import { CLEANUP_BUCKETS } from "@/lib/cleanup/rules";
import {
  CleanupStorageError,
  bookPrefix,
  deleteOwnUnprotectedBook,
  removeStoragePrefix,
} from "@/lib/db/cleanup";
import { isUuid } from "@/lib/uuid";

export type DeleteBookError = "invalid" | "not_found" | "protected" | "failed";

export type DeleteBookResult =
  | { ok: true; storageRemoved: number; storageFailures: number }
  | { ok: false; error: DeleteBookError };

export async function deleteBookCompletely({
  bookId,
  userId,
}: {
  bookId: string;
  userId: string;
}): Promise<DeleteBookResult> {
  if (!isUuid(bookId) || !isUuid(userId)) return { ok: false, error: "invalid" };

  let row: Awaited<ReturnType<typeof deleteOwnUnprotectedBook>>;
  try {
    row = await deleteOwnUnprotectedBook(bookId, userId);
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String(e.code) : "unknown";
    console.error(`[cleanup] delete_book failed code=${code}`);
    return { ok: false, error: "failed" };
  }
  if (row !== "deleted") return { ok: false, error: row };

  return { ok: true, ...(await removeBookPrefixes([{ userId, bookId }], "delete_book")) };
}

/**
 * Removes `{user}/{book}/` in every cleanup bucket for each book. Never throws: failures are
 * counted (and, with `logTag`, logged as bucket + code) and left to the orphan sweep. The cron
 * passes no tag — it logs one count line per sweep instead.
 */
export async function removeBookPrefixes(
  books: readonly { userId: string; bookId: string }[],
  logTag?: string,
): Promise<{ storageRemoved: number; storageFailures: number }> {
  let storageRemoved = 0;
  let storageFailures = 0;
  for (const b of books) {
    for (const bucket of CLEANUP_BUCKETS) {
      try {
        storageRemoved += await removeStoragePrefix(bucket, bookPrefix(b.userId, b.bookId));
      } catch (e) {
        storageFailures += 1;
        const code = e instanceof CleanupStorageError ? e.code : "unknown";
        if (logTag) console.error(`[cleanup] ${logTag} storage_fail bucket=${bucket} code=${code}`);
      }
    }
  }
  return { storageRemoved, storageFailures };
}
