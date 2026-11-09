import "server-only";
// Editor data loader (M5 Task 4) + fresh signed photo URLs for the editor.
//
// Everything here uses the RLS-enforced server client: books / photos /
// agent_runs are owner-only (agent_runs via column-level grants, 0700 — only
// granted columns are selected) and storage.objects in bucket "photos" is
// owner-only too, so a foreign book simply yields null.
//
// Privacy (D-027, CLAUDE.md): the payload never contains storage paths, AI
// descriptions (photos.ai), GPS, EXIF, camera or dates — paths are selected
// only to sign them and are dropped before returning.
//
// Errors carry only the operation and a Postgres/Storage code.
import { resolveAiMode, type AiMode } from "@/lib/ai/client";
import { limitsFor } from "@/lib/ai/limits";
import { getMyBook } from "@/lib/db/books";
import { PHOTOS_BUCKET } from "@/lib/db/photos";
import type { CaptionLang, Occasion, Tone } from "@/lib/book/options";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

/** TTL of editor image URLs. The client refreshes via POST /api/books/[id]/photo-urls on 403. */
export const EDITOR_URL_TTL_SECONDS = 3600;

/** Max ids per photo-urls request (= paid upload cap). */
export const MAX_PHOTO_URL_IDS = 500;

/** Ids per PostgREST `in` filter (keeps request URLs short; same as photos.ts). */
const ID_CHUNK = 100;

export class EditorQueryError extends Error {
  readonly code: string | undefined;

  constructor(operation: string, code?: string) {
    super(`Failed to ${operation}${code ? ` (${code})` : ""}`);
    this.name = "EditorQueryError";
    this.code = code;
  }
}

export type EditorPhotoUrls = {
  id: string;
  /** Signed ≤1600px web image (EDITOR_URL_TTL_SECONDS), null when unavailable. */
  webUrl: string | null;
  /** Signed 512px thumb (EDITOR_URL_TTL_SECONDS), null when unavailable. */
  thumbUrl: string | null;
};

export type EditorPhoto = EditorPhotoUrls & {
  status: "kept" | "dropped";
  userOverride: boolean;
  /** Display-oriented size of the ORIGINAL file (upload pipeline), null if unknown. */
  width: number | null;
  height: number | null;
};

export type EditorBook = {
  id: string;
  title: string | null;
  occasion: Occasion;
  tone: Tone;
  captionLang: CaptionLang;
  isPaid: boolean;
  maxPages: number;
};

export type EditorData = {
  book: EditorBook;
  /** Parsed book doc, or null when books.doc is empty / doesn't parse (see docError). */
  doc: BookDoc | null;
  /** Why doc is null: "empty" = `{}` (album not built yet), "invalid" = fails parseBookDoc. */
  docError: "empty" | "invalid" | null;
  /** books.doc_rev; null = migration 0900 not applied → editor must be read-only. */
  docRev: number | null;
  canSave: boolean;
  aiMode: AiMode;
  /** Successful (ai_status 'ok') rewrite runs of this book (D-037 (6)). */
  rewritesUsed: number;
  rewritesLeft: number;
  /** The book's active (not done/failed) build or rebuild run, if any. */
  activeBuildRunId: string | null;
  /** Upload-finished photos (kept + dropped), oldest first. */
  photos: EditorPhoto[];
};

type PhotoRow = {
  id: string;
  status: string;
  user_override: boolean;
  width: number | null;
  height: number | null;
  web_path: string | null;
  thumb_path: string | null;
};

const PHOTO_COLUMNS = "id, status, user_override, width, height, web_path, thumb_path";

function storageCode(err: unknown): string {
  if (err && typeof err === "object" && "statusCode" in err && typeof err.statusCode === "string") {
    return err.statusCode;
  }
  return "storage";
}

function chunks<T>(items: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function positiveInt(n: number | null): number | null {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Signs web + thumb paths of all rows in ONE createSignedUrls call (all files
 * live in the single "photos" bucket), then maps the URLs back to photo ids.
 */
async function signRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rows: PhotoRow[],
): Promise<EditorPhotoUrls[]> {
  const paths = new Set<string>();
  for (const r of rows) {
    if (r.web_path) paths.add(r.web_path);
    if (r.thumb_path) paths.add(r.thumb_path);
  }
  const urls = new Map<string, string>();
  if (paths.size > 0) {
    const { data, error } = await supabase.storage
      .from(PHOTOS_BUCKET)
      .createSignedUrls([...paths], EDITOR_URL_TTL_SECONDS);
    if (error) throw new EditorQueryError("sign photo urls", storageCode(error));
    for (const s of data) if (s.path && s.signedUrl && !s.error) urls.set(s.path, s.signedUrl);
  }
  return rows.map((r) => ({
    id: r.id,
    webUrl: r.web_path ? (urls.get(r.web_path) ?? null) : null,
    thumbUrl: r.thumb_path ? (urls.get(r.thumb_path) ?? null) : null,
  }));
}

async function listReadyPhotoRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  bookId: string,
): Promise<PhotoRow[]> {
  const { data, error } = await supabase
    .from("photos")
    .select(PHOTO_COLUMNS)
    .eq("book_id", bookId)
    .eq("upload_state", "ready")
    .order("taken_at", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });
  if (error) throw new EditorQueryError("list editor photos", error.code);
  return data as PhotoRow[];
}

async function countOkRewrites(
  supabase: Awaited<ReturnType<typeof createClient>>,
  bookId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId)
    .eq("trigger", "rewrite")
    .eq("ai_status", "ok");
  if (error) throw new EditorQueryError("count rewrites", error.code);
  return count ?? 0;
}

async function activeBuildRun(
  supabase: Awaited<ReturnType<typeof createClient>>,
  bookId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("agent_runs")
    .select("id")
    .eq("book_id", bookId)
    .in("trigger", ["build", "rebuild"])
    .not("state", "in", "(done,failed)")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new EditorQueryError("load active run", error.code);
  return data?.id ?? null;
}

function isEmptyObject(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
}

/**
 * Everything the editor page needs, or null when the id is malformed, the
 * book doesn't exist / isn't the signed-in user's, or the user is signed out.
 */
export async function getEditorData(bookId: string): Promise<EditorData | null> {
  if (!isUuid(bookId)) return null;
  const book = await getMyBook(bookId);
  if (!book) return null;

  const supabase = await createClient();
  const [rows, rewritesUsed, activeBuildRunId] = await Promise.all([
    listReadyPhotoRows(supabase, book.id),
    countOkRewrites(supabase, book.id),
    activeBuildRun(supabase, book.id),
  ]);
  const signed = await signRows(supabase, rows);

  const photos: EditorPhoto[] = rows.map((r, i) => ({
    id: r.id,
    status: r.status === "dropped" ? "dropped" : "kept",
    userOverride: r.user_override === true,
    width: positiveInt(r.width),
    height: positiveInt(r.height),
    webUrl: signed[i].webUrl,
    thumbUrl: signed[i].thumbUrl,
  }));

  let doc: BookDoc | null = null;
  let docError: EditorData["docError"] = null;
  if (isEmptyObject(book.doc)) docError = "empty";
  else {
    const parsed = parseBookDoc(book.doc);
    if (parsed.ok) doc = parsed.doc;
    else docError = "invalid";
  }

  const cap = limitsFor(book.is_paid).maxCaptionRewrites;
  return {
    book: {
      id: book.id,
      title: book.title,
      occasion: book.occasion as Occasion,
      tone: book.tone as Tone,
      captionLang: book.caption_lang as CaptionLang,
      isPaid: book.is_paid,
      maxPages: book.max_pages,
    },
    doc,
    docError,
    docRev: book.doc_rev,
    canSave: book.doc_rev !== null,
    aiMode: resolveAiMode(),
    rewritesUsed,
    rewritesLeft: Math.max(0, cap - rewritesUsed),
    activeBuildRunId,
    photos,
  };
}

/**
 * Fresh signed web + thumb URLs for the signed-in user's photos of a book
 * (used when an editor image 403s after expiry). `ids` omitted → all
 * upload-finished photos of the book; ids not in the book are silently
 * skipped. Returns null when the book isn't visible to the user.
 * Callers must cap ids at MAX_PHOTO_URL_IDS (the route validates with zod).
 */
export async function getPhotoUrls(bookId: string, ids?: string[]): Promise<EditorPhotoUrls[] | null> {
  if (!isUuid(bookId)) return null;
  const supabase = await createClient();

  const { data: book, error: bookError } = await supabase
    .from("books")
    .select("id")
    .eq("id", bookId)
    .maybeSingle();
  if (bookError) throw new EditorQueryError("load book", bookError.code);
  if (!book) return null;

  let rows: PhotoRow[];
  if (ids === undefined) {
    rows = await listReadyPhotoRows(supabase, bookId);
  } else {
    const unique = [...new Set(ids.filter(isUuid))];
    if (unique.length > MAX_PHOTO_URL_IDS) throw new EditorQueryError("load photo urls", "too_many_ids");
    rows = [];
    for (const part of chunks(unique)) {
      const { data, error } = await supabase
        .from("photos")
        .select(PHOTO_COLUMNS)
        .eq("book_id", bookId)
        .eq("upload_state", "ready")
        .in("id", part);
      if (error) throw new EditorQueryError("load photo urls", error.code);
      rows.push(...(data as PhotoRow[]));
    }
  }
  return signRows(supabase, rows);
}
