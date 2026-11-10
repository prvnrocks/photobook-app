import "server-only";
// Review S3: the draft warning email says "open it to keep it" — so opening a WARNED draft in the
// editor or on the review page must count as activity. Otherwise the idle clock (books.updated_at
// / last photo upload) stays where it was and the draft is still deleted on the warned date.
//
// touchWarnedDraft(bookId, userId), called by the edit + review pages after their ownership check:
//   1. bump books.updated_at to now() — only for the owner's (user_id filter) never-published,
//      unpaid draft whose draft_warning_sent_at is set. The update names no warning column, so the
//      updated_at trigger (1600 / 1800) sets now();
//   2. only if 1 matched: clear draft_warning_sent_at, so the deletion chip disappears and a fresh
//      warning (after another DRAFT_WARNING_DAYS idle days) is needed before any deletion. This
//      update changes only a warning column, so it keeps the new updated_at.
// Either step alone is already safe: after (1) sent_at < last activity, which neither
// cleanup_delete_abandoned_drafts nor the chip accept as a warning. Works with and without 1800
// (names no claimed_at column; an in-flight claim confirms to a sent_at older than the new activity).
//
// Secret-key admin client (the warning columns are server-only via the guard trigger — a
// user-scoped write would "succeed" while silently keeping the old value). Never throws: a
// failure only logs `[books] touch draft failed code=…` (no ids) and the page renders normally.
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";

export type TouchDraftResult = "touched" | "noop" | "failed";

function code(e: unknown): string {
  const raw = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "unknown";
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
}

export async function touchWarnedDraft(bookId: string, userId: string): Promise<TouchDraftResult> {
  if (!isUuid(bookId) || !isUuid(userId)) return "noop";
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("books")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", bookId)
      .eq("user_id", userId)
      .eq("is_paid", false)
      .is("published_at", null)
      .not("draft_warning_sent_at", "is", null)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) return "noop";

    const { error: clearError } = await admin
      .from("books")
      .update({ draft_warning_sent_at: null })
      .eq("id", bookId)
      .eq("user_id", userId);
    if (clearError) throw clearError;
    return "touched";
  } catch (e) {
    console.error(`[books] touch draft failed code=${code(e)}`);
    return "failed";
  }
}
