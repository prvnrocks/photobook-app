"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getMyBook } from "@/lib/db/books";
import { setUserOverride } from "@/lib/db/photos";
import { errorCodeOf } from "@/lib/http/json";
import { isUuid } from "@/lib/uuid";

const MSG_SIGNED_OUT = "Please sign in again.";
const MSG_NOT_FOUND = "That book or photo wasn't found.";
const MSG_SAVE_FAILED = "We couldn't save that. Please try again.";

/**
 * Review screen (M3): the user keeps or removes one photo. Sets user_override so the AI never
 * changes this choice again ("AI drafts, the user decides").
 */
export async function togglePhotoAction(
  bookId: string,
  photoId: string,
  keep: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isUuid(bookId) || !isUuid(photoId) || typeof keep !== "boolean") {
    return { ok: false, error: MSG_NOT_FOUND };
  }
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: MSG_SIGNED_OUT };

  try {
    const book = await getMyBook(bookId);
    if (!book) return { ok: false, error: MSG_NOT_FOUND };
    const saved = await setUserOverride(book.id, photoId, keep);
    if (!saved) return { ok: false, error: MSG_NOT_FOUND };
  } catch (err) {
    console.error(`[review] toggle photo failed (${errorCodeOf(err)})`);
    return { ok: false, error: MSG_SAVE_FAILED };
  }
  revalidatePath(`/books/${bookId}/review`);
  return { ok: true };
}
