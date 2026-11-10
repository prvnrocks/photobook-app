import "server-only";
// Delete account (D-060, M9 T6). Paid books belong to the user, so account deletion removes them
// too — unlike the per-book delete, which refuses protected books. The one exception: while any
// order is still 'pending' (a Checkout Session could be paid any moment) we refuse with
// 'payment_in_progress' so no money arrives for a deleted account.
//
// Order (row-then-storage, D-056):
//   1. list the user's books; refuse when a pending order exists (by user or on any book);
//   2. delete ALL book rows of the user (admin, user_id filter) — orders keep their rows with
//      book_id null for accounting; agent_steps content is nulled by the 0600 trigger;
//   3. remove {user}/{book}/ in `photos` and `exports` for every deleted book (failures counted,
//      logged as codes, left to the orphan sweep);
//   4. delete the auth user (cascades profiles, user_memory; orders keep user_id null).
// If step 4 fails the account still exists without books; the user can retry.
//
// Residual race (documented in the T6 HANDOFF): a checkout started in another tab between the
// pending check and step 2 leaves a pending order with book_id null; if paid, the webhook logs
// 'book_missing' and RUNBOOK §2 covers the refund.
//
// The caller MUST pass the authenticated session user's id. Logs: codes and counts only.
import { removeBookPrefixes } from "@/lib/cleanup/delete-book";
import { deleteAllUserBooks, deleteAuthUser, hasPendingOrder, listUserBookIds } from "@/lib/db/account";
import { errorCodeOf } from "@/lib/http/json";
import { isUuid } from "@/lib/uuid";

export type DeleteAccountResult =
  | { ok: true; booksDeleted: number; storageFailures: number }
  | { ok: false; error: "invalid" | "payment_in_progress" | "failed" };

export async function deleteAccountCompletely(userId: string): Promise<DeleteAccountResult> {
  if (!isUuid(userId)) return { ok: false, error: "invalid" };

  let step = "check";
  try {
    const bookIds = await listUserBookIds(userId);
    if (await hasPendingOrder(userId, bookIds)) return { ok: false, error: "payment_in_progress" };

    step = "books";
    const deleted = await deleteAllUserBooks(userId);

    step = "storage";
    const { storageFailures } = await removeBookPrefixes(deleted, "delete_account");

    step = "user";
    await deleteAuthUser(userId);

    console.info(`[account] deleted books=${deleted.length} storage_failures=${storageFailures}`);
    return { ok: true, booksDeleted: deleted.length, storageFailures };
  } catch (err) {
    console.error(`[account] delete failed step=${step} code=${errorCodeOf(err)}`);
    return { ok: false, error: "failed" };
  }
}
