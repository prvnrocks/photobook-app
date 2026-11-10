"use server";

import { revalidatePath } from "next/cache";
import { learnFromBook } from "@/lib/ai/learn-from-book";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getMyBook } from "@/lib/db/books";
import { errorCodeOf } from "@/lib/http/json";
import { isUuid } from "@/lib/uuid";

export type FinishEditingResult =
  | { ok: true; redirectTo: string }
  | { ok: false; error: "signed_out" | "not_found" | "failed" };

/** Where the editor goes after Done: the publish step (D-040). */
const afterEditPath = (bookId: string) => `/books/${bookId}/publish`;

/**
 * Editor "Done" (M5, D-032): the Memory Keeper learns from the SAVED book (tone if it differs
 * from the occasion default, caption language, caption length from ≥ 3 captions with source
 * "user" — which includes accepted ✨ rewrites, D-037 #1). Code only, no model call.
 *
 * - Takes only the book id; the doc is read server-side (never from the client). Flush any
 *   pending save (PUT /api/books/[id]/doc) before calling, or the last edits won't be learned.
 * - Never writes the book doc. Ownership is checked under RLS (getMyBook) and again on the admin
 *   read inside learnFromBook.
 * - Memory failures never block the user: still `{ ok: true }` (code-only log, D-027).
 * - Does not redirect itself; the client navigates to `redirectTo`.
 */
export async function finishEditingAction(bookId: string): Promise<FinishEditingResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "signed_out" };
  if (typeof bookId !== "string" || !isUuid(bookId)) return { ok: false, error: "not_found" };

  let mine: Awaited<ReturnType<typeof getMyBook>>;
  try {
    mine = await getMyBook(bookId);
  } catch (err) {
    console.error(`[editor] finish: load failed (${errorCodeOf(err)})`);
    return { ok: false, error: "failed" };
  }
  if (!mine) return { ok: false, error: "not_found" };

  await learnFromBook(user.id, mine.id, "editor");
  revalidatePath("/dashboard");
  return { ok: true, redirectTo: afterEditPath(mine.id) };
}
