import "server-only";
// Memory Keeper trigger (D-032): best-effort "learn from this book" used by review Continue and
// the editor Share / publish (M13 T9: shareBookAction, publishBookAction). Code only — no model call.
//
// Reads the SAVED book server-side with the admin client (never a client-supplied doc), checks the
// row still belongs to `userId` (resolved by the caller from the session), derives the update with
// `deriveMemoryUpdate` and upserts it when something changed. Never writes the book.
//
// Privacy (D-027): logs only "[tag] memory update failed (<code>)" — never prefs, captions or ids.

import { deriveMemoryUpdate } from "@/lib/ai/agents/memory-keeper";
import { getBookForRun } from "@/lib/db/books";
import { getUserMemoryAdmin, upsertUserMemory } from "@/lib/db/memory";
import { errorCodeOf } from "@/lib/http/json";
import type { Json } from "@/lib/supabase/database.types";

export type LearnFromBookOutcome = "updated" | "unchanged" | "skipped" | "failed";

/** Never throws. `skipped` = book missing or not owned by `userId`. */
export async function learnFromBook(
  userId: string,
  bookId: string,
  logTag: string,
): Promise<LearnFromBookOutcome> {
  try {
    const book = await getBookForRun(bookId);
    // Belt and braces: the admin read must still be this user's book.
    if (!book || book.user_id !== userId) return "skipped";
    const prev = await getUserMemoryAdmin(userId);
    const { next, changed } = deriveMemoryUpdate(
      prev?.prefs ?? null,
      { occasion: book.occasion, tone: book.tone, caption_lang: book.caption_lang, title: book.title },
      book.doc,
    );
    if (!changed) return "unchanged";
    await upsertUserMemory(userId, next as unknown as Json);
    return "updated";
  } catch (err) {
    console.error(`[${logTag}] memory update failed (${errorCodeOf(err)})`);
    return "failed";
  }
}
