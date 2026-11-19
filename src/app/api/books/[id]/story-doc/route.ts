// GET /api/books/[id]/story-doc (Task 8): the caller's current book doc + doc_rev, read after the
// editor's "Regenerate story" job finished — the editor applies it as ONE undo step and adopts the
// rev as its save base (so Undo reverts the regeneration and the next save stores that).
// Responses (no-store): 200 { doc, rev } | 401 | 404 { error: 'not_found' } (also: no parsable doc)
// | 503 | 500. Never logs ids or doc contents.
import { type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { parseBookDoc } from "@/lib/book/schema";
import { getMyBook } from "@/lib/db/books";
import { errorCodeOf, json, unavailableIfTimeout } from "@/lib/http/json";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not_found" }, 404);
    const book = await getMyBook(id);
    if (!book || book.doc_rev === null) return json({ error: "not_found" }, 404);
    const parsed = parseBookDoc(book.doc);
    if (!parsed.ok) return json({ error: "not_found" }, 404);
    return json({ doc: parsed.doc, rev: book.doc_rev });
  } catch (err) {
    const unavailable = unavailableIfTimeout(err, { route: "story-doc" });
    if (unavailable) return unavailable;
    console.error(`[story-doc] failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
