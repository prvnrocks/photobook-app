// PUT /api/books/[id]/doc (M5, D-036 / D-037): editor save with optimistic concurrency.
// Body: { doc: BookDoc, baseRev: non-negative integer } — at most 256 KB.
// Never trusts the client: the doc is re-validated against the book's own upload-ready photos
// and books.max_pages from the DB; meta origin fields come from the saved doc and
// meta.userEdited is forced true; the cover title is synced to books.title (D-037 (7));
// dropped photos placed in the doc become kept with user_override (D-037 (4)). Photo
// backgrounds may use any upload-ready photo of the book (kept or dropped) and are not
// "placed": they never mark a dropped photo kept (M10a A8, validate-editor-doc.ts).
// Format + design style come from books.format / books.design_style (D-063, M10b A6): the stored
// doc always carries the columns' values whatever the client sent; layouts of another format or
// style, and misaligned spreads, → 422 invalid_doc.
// Responses (all no-store):
//   200 { rev, savedAt }
//   400 { error: 'invalid_body' }                        — not JSON / bad shape / bad baseRev
//   401 { error: 'unauthenticated' }   403 { error: 'forbidden' } (cross-origin)
//   404 { error: 'not_found' }                           — bad id / missing / not the caller's
//   409 { error: 'conflict' }                            — baseRev is not the stored doc_rev
//                                                          (an identical replay of the save that made
//                                                          doc_rev = baseRev + 1 → 200, M12 T3)
//   413 { error: 'too_large' }
//   422 { error: 'invalid_doc' | 'page_limit' | 'foreign_photo' | 'duplicate_photo' | 'invalid_font'
//               | 'unsupported_design' }                 — design style without layouts (M10b A19 S1)
//   503 { error: 'saving_unavailable' }                  — migration 0900 not applied
//   503 { error: 'unavailable' } + Retry-After: 3       — Supabase timeout (M12); retrying is safe
//   500 { error: 'server_error' }
// Logs carry error codes only — never ids or doc contents.
import { type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { bookDesignOf } from "@/lib/book/book-design";
import { serializeDoc } from "@/lib/book/doc-version";
import { validateEditorDoc } from "@/lib/book/validate-editor-doc";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { getMyBook, saveDocIfRev } from "@/lib/db/books";
import { listPlaceablePhotos, markPlacedPhotosKept } from "@/lib/db/photos";
import { readBodyWithLimit } from "@/lib/http/body";
import { errorCodeOf, json, unavailableIfTimeout } from "@/lib/http/json";
import type { Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

const BodySchema = z.object({
  doc: z.unknown(),
  baseRev: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);

  try {
    const user = await getCurrentUser();
    if (!user) return json({ error: "unauthenticated" }, 401);

    const { id } = await params;
    if (!isUuid(id)) return json({ error: "not_found" }, 404);

    const body = await readBodyWithLimit(request, MAX_BODY_BYTES);
    if (!body.ok) return json({ error: "too_large" }, 413);
    let raw: unknown;
    try {
      raw = JSON.parse(body.text);
    } catch {
      return json({ error: "invalid_body" }, 400);
    }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success || parsed.data.doc === undefined) return json({ error: "invalid_body" }, 400);
    const { doc: inputDoc, baseRev } = parsed.data;

    const book = await getMyBook(id);
    if (!book) return json({ error: "not_found" }, 404);
    if (book.doc_rev === null) return json({ error: "saving_unavailable" }, 503);
    // The forced meta below comes from the doc at book.doc_rev; saving over any other
    // revision would mix origins. saveDocIfRev re-checks atomically.
    // One exception (M12 T3): doc_rev = baseRev + 1 may be THIS save, committed while its response
    // timed out. It goes on to saveDocIfRev, whose UPDATE (doc_rev = baseRev) matches 0 rows and
    // which answers ok only for an identical replay (canonical doc + title), else conflict.
    if (baseRev !== book.doc_rev && baseRev + 1 !== book.doc_rev) return json({ error: "conflict" }, 409);

    const photos = await listPlaceablePhotos(book.id);
    const result = validateEditorDoc(inputDoc, {
      photoIds: new Set(photos.map((p) => p.id)),
      maxPages: book.max_pages,
      savedDoc: book.doc,
      design: bookDesignOf(book),
    });
    if (!result.ok) return json({ error: result.code }, 422);

    const saved = await saveDocIfRev(
      book.id,
      user.id,
      serializeDoc(result.doc) as unknown as Json,
      result.pageCount,
      baseRev,
      result.title === null ? {} : { title: result.title },
    );
    if (!saved.ok) {
      return saved.reason === "conflict" ? json({ error: "conflict" }, 409) : json({ error: "not_found" }, 404);
    }

    // D-037 (4), after the save: best effort — the doc is saved either way, and the next
    // save retries any photo still marked dropped.
    const placed = new Set(result.placedPhotoIds);
    const toKeep = photos.filter((p) => p.status === "dropped" && placed.has(p.id)).map((p) => p.id);
    if (toKeep.length > 0) {
      try {
        await markPlacedPhotosKept(book.id, toKeep);
      } catch (err) {
        console.error(`[doc-save] mark placed photos kept failed (${errorCodeOf(err)})`);
      }
    }

    return json({ rev: saved.rev, savedAt: saved.savedAt }, 200);
  } catch (err) {
    const unavailable = unavailableIfTimeout(err);
    if (unavailable) return unavailable;
    console.error(`[doc-save] failed (${errorCodeOf(err)})`);
    return json({ error: "server_error" }, 500);
  }
}
