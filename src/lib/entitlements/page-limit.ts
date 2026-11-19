import "server-only";
// Task 10: the page limit that goes with a full storybook grant. Service role only (the books column
// guard keeps clients out of max_pages); never touches is_paid, so a grant still unlocks no PDF,
// no watermark-free viewer and no permanent link (D-093).

import { LIMITS } from "@/lib/ai/limits";
import type { createAdminClient } from "@/lib/supabase/admin";

/** Raises books.max_pages to the paid limit for an UNPAID book (paid books already have it). False on a DB error. */
export async function raiseGrantPageLimit(db: ReturnType<typeof createAdminClient>, bookId: string): Promise<boolean> {
  const { error } = await db.from("books").update({ max_pages: LIMITS.paid.maxPages }).eq("id", bookId).eq("is_paid", false).lt("max_pages", LIMITS.paid.maxPages);
  return !error;
}
