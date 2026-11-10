import "server-only";
// Photo dimensions for the internal print route /print/[bookId] (M8 T5, D-048/D-049).
//
// The print route is opened by headless Chromium with a signed print token, not a user session,
// so this uses the admin client. Scoping: only ids the print sheets show, only rows of THAT book,
// only upload_state 'ready' with an original (the renderer serves print copies made from the
// original). Selects id/width/height only — never paths, signed URLs, GPS, dates or AI notes.
//
// Errors carry only the operation and a Postgres code.
import type { PrintPhotoDims } from "@/lib/pdf/print-doc";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";

/** Ids per PostgREST `in` filter (keeps request URLs short; same as photos.ts). */
const ID_CHUNK = 100;

export class PrintQueryError extends Error {
  readonly code: string;
  constructor(op: string, code: string | undefined) {
    const safe = (code ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
    super(`print: ${op} failed (${safe})`);
    this.name = "PrintQueryError";
    this.code = safe;
  }
}

/** id + stored pixel size of the book's ready photos among `ids` (malformed / foreign ids are absent). */
export async function listPrintPhotoDims(bookId: string, ids: readonly string[]): Promise<PrintPhotoDims[]> {
  if (!isUuid(bookId)) return [];
  const wanted = [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))];
  if (wanted.length === 0) return [];
  const admin = createAdminClient();
  const out: PrintPhotoDims[] = [];
  for (let i = 0; i < wanted.length; i += ID_CHUNK) {
    const { data, error } = await admin
      .from("photos")
      .select("id, width, height")
      .eq("book_id", bookId)
      .eq("upload_state", "ready")
      .not("original_path", "is", null)
      .in("id", wanted.slice(i, i + ID_CHUNK));
    if (error) throw new PrintQueryError("list photo dims", error.code);
    for (const r of (data ?? []) as { id: string; width: number | null; height: number | null }[]) {
      out.push({ id: r.id, width: r.width, height: r.height });
    }
  }
  return out;
}

export interface PrintPhotoSourceRow {
  id: string;
  width: number | null;
  height: number | null;
  /** {user}/{book}/{photo}-original.{ext} — server only, never logged or returned to clients. */
  original_path: string;
}

/**
 * Renderer input for the PDF job (M8 T7): size + original path of the book's ready photos among
 * `ids`. Admin client, so it filters by book AND owner (the export row's user_id) itself.
 */
export async function listPrintPhotoSources(
  bookId: string,
  userId: string,
  ids: readonly string[],
): Promise<PrintPhotoSourceRow[]> {
  if (!isUuid(bookId) || !isUuid(userId)) return [];
  const wanted = [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))];
  if (wanted.length === 0) return [];
  const admin = createAdminClient();
  const out: PrintPhotoSourceRow[] = [];
  for (let i = 0; i < wanted.length; i += ID_CHUNK) {
    const { data, error } = await admin
      .from("photos")
      .select("id, width, height, original_path")
      .eq("book_id", bookId)
      .eq("user_id", userId)
      .eq("upload_state", "ready")
      .not("original_path", "is", null)
      .in("id", wanted.slice(i, i + ID_CHUNK));
    if (error) throw new PrintQueryError("list photo sources", error.code);
    for (const r of (data ?? []) as { id: string; width: number | null; height: number | null; original_path: string | null }[]) {
      if (r.original_path) out.push({ id: r.id, width: r.width, height: r.height, original_path: r.original_path });
    }
  }
  return out;
}
