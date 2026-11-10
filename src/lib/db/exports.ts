import "server-only";
// public.exports queries + RPC wrappers (M8, migration 1400, D-047 / D-051).
//
// Everything here uses the secret-key admin client: clients have no write privileges on exports
// and may only SELECT the status columns (OWNER_EXPORT_COLUMNS). Owner-facing reads therefore
// ALWAYS filter by user_id themselves (getExportForOwner). The doc snapshot, the storage path and
// the lease never leave the server (getExportForRender is for the internal print route only).
//
// Errors carry only the operation and a Postgres code — never ids, paths or doc content.
// Nothing here logs.
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";

export type ExportStatus = "queued" | "rendering" | "ready" | "failed";
export type ExportCaptionLang = "en" | "ar";

/** Columns granted to `authenticated` in 1400 — owner reads must stay within this list. */
export const OWNER_EXPORT_COLUMNS = "id, book_id, doc_rev, status, bytes, page_count, error_code, created_at, finished_at";

const RENDER_EXPORT_COLUMNS = "id, book_id, user_id, doc_rev, doc, caption_lang, status";

/** Claims per job (claim_export refuses the 4th). */
export const EXPORT_MAX_ATTEMPTS = 3;

export class ExportsQueryError extends Error {
  readonly code: string;
  constructor(op: string, code: string | undefined) {
    const safe = (code ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
    super(`exports: ${op} failed (${safe})`);
    this.name = "ExportsQueryError";
    this.code = safe;
  }
}

/** Object path in bucket `exports` (0200 policies + the 1400 path check): {user}/{book}/{export}.pdf */
export function exportObjectPath(userId: string, bookId: string, exportId: string): string {
  return `${userId}/${bookId}/${exportId}.pdf`;
}

// ---------------------------------------------------------------------------
// create_export_job

export interface CreateExportJobArgs {
  bookId: string;
  userId: string;
  /** books.doc_rev the snapshot was read at. */
  docRev: number;
  /** books.doc as saved (a JSON object). */
  doc: Json;
  captionLang: ExportCaptionLang;
  /** Jobs per user per rolling 24 h, any outcome. */
  dailyCap: number;
  /** queued / rendering jobs older than this are failed as 'stale' (60..86400). */
  staleSeconds: number;
}

export type CreateExportJobResult =
  /** New queued job — start rendering it. */
  | { status: "created"; exportId: string }
  /** A ready PDF exists for this doc_rev + caption_lang — reuse it. */
  | { status: "ready"; exportId: string }
  /** Another job for this book is in flight (maybe for an older doc_rev). */
  | { status: "running"; exportId: string; docRev: number }
  | { status: "daily_cap" }
  | { status: "not_paid" }
  | { status: "not_found" }
  /** The doc was saved again after the caller read it — re-read and retry. */
  | { status: "stale_rev"; docRev: number };

const uuid = z.string().refine(isUuid);
const rev = z.number().int().nonnegative();
const CreateResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), export_id: uuid }),
  z.object({ status: z.literal("ready"), export_id: uuid }),
  z.object({ status: z.literal("running"), export_id: uuid, doc_rev: rev }),
  z.object({ status: z.literal("daily_cap") }),
  z.object({ status: z.literal("not_paid") }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("stale_rev"), doc_rev: rev }),
]);

/**
 * Atomic (per-user advisory lock) job creation: ownership + live is_paid, stale reaping, ready
 * reuse, one job in flight per book, daily cap, insert. See migration 1400 for the exact order.
 */
export async function createExportJob(args: CreateExportJobArgs): Promise<CreateExportJobResult> {
  if (!isUuid(args.bookId) || !isUuid(args.userId)) return { status: "not_found" };
  const { data, error } = await createAdminClient().rpc("create_export_job", {
    p_book: args.bookId,
    p_user: args.userId,
    p_doc_rev: args.docRev,
    p_doc: args.doc,
    p_caption_lang: args.captionLang,
    p_daily_cap: Math.floor(args.dailyCap),
    p_stale_seconds: Math.floor(args.staleSeconds),
  });
  if (error) throw new ExportsQueryError("create", error.code);
  const parsed = CreateResultSchema.safeParse(data);
  if (!parsed.success) throw new ExportsQueryError("create", "bad_result");
  const r = parsed.data;
  switch (r.status) {
    case "created":
    case "ready":
      return { status: r.status, exportId: r.export_id };
    case "running":
      return { status: "running", exportId: r.export_id, docRev: r.doc_rev };
    case "stale_rev":
      return { status: "stale_rev", docRev: r.doc_rev };
    default:
      return { status: r.status };
  }
}

// ---------------------------------------------------------------------------
// Lease: claim / finish / fail

/** Leases a queued (or expired-lease) job. Returns the lease token, or null when not claimable. */
export async function claimExport(exportId: string, leaseSeconds: number): Promise<string | null> {
  if (!isUuid(exportId)) return null;
  const { data, error } = await createAdminClient().rpc("claim_export", {
    p_export: exportId,
    p_lease_seconds: Math.floor(leaseSeconds),
  });
  if (error) throw new ExportsQueryError("claim", error.code);
  // gen types says `string`, but the function returns NULL when not claimable.
  const token = data as string | null;
  return typeof token === "string" && isUuid(token) ? token : null;
}

export interface FinishExportArgs {
  exportId: string;
  token: string;
  /** Must be exportObjectPath(userId, bookId, exportId) — the table check rejects anything else. */
  path: string;
  bytes: number;
  pageCount: number;
}

/**
 * Marks the job ready. false = the lease is gone (job reaped / re-claimed): the caller must delete
 * the object it uploaded and stop.
 */
export async function finishExport(args: FinishExportArgs): Promise<boolean> {
  if (!isUuid(args.exportId) || !isUuid(args.token)) return false;
  const { data, error } = await createAdminClient().rpc("finish_export", {
    p_export: args.exportId,
    p_token: args.token,
    p_path: args.path,
    p_bytes: Math.floor(args.bytes),
    p_pages: Math.floor(args.pageCount),
  });
  if (error) throw new ExportsQueryError("finish", error.code);
  return data === true;
}

const ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;

/** Marks the job failed with a short code ([a-z0-9_]{1,64}; anything else becomes 'error'). */
export async function failExport(exportId: string, token: string, code: string): Promise<boolean> {
  if (!isUuid(exportId) || !isUuid(token)) return false;
  const { data, error } = await createAdminClient().rpc("fail_export", {
    p_export: exportId,
    p_token: token,
    p_code: ERROR_CODE_RE.test(code) ? code : "error",
  });
  if (error) throw new ExportsQueryError("fail", error.code);
  return data === true;
}

// ---------------------------------------------------------------------------
// Reads

export interface OwnerExport {
  id: string;
  bookId: string;
  docRev: number;
  status: ExportStatus;
  bytes: number | null;
  pageCount: number | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

type OwnerRow = {
  id: string;
  book_id: string;
  doc_rev: number;
  status: string;
  bytes: number | null;
  page_count: number | null;
  error_code: string | null;
  created_at: string;
  finished_at: string | null;
};

const STATUSES: readonly ExportStatus[] = ["queued", "rendering", "ready", "failed"];

function toOwnerExport(row: OwnerRow): OwnerExport {
  if (!(STATUSES as readonly string[]).includes(row.status)) throw new ExportsQueryError("read", "bad_status");
  return {
    id: row.id,
    bookId: row.book_id,
    docRev: row.doc_rev,
    status: row.status as ExportStatus,
    bytes: row.bytes,
    pageCount: row.page_count,
    errorCode: row.error_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** The job's status columns, only if it belongs to `userId` (admin read + explicit owner filter). */
export async function getExportForOwner(exportId: string, userId: string): Promise<OwnerExport | null> {
  if (!isUuid(exportId) || !isUuid(userId)) return null;
  const { data, error } = await createAdminClient()
    .from("exports")
    .select(OWNER_EXPORT_COLUMNS)
    .eq("id", exportId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new ExportsQueryError("read", error.code);
  return data ? toOwnerExport(data as OwnerRow) : null;
}

export interface RenderExport {
  id: string;
  bookId: string;
  userId: string;
  docRev: number;
  doc: Json;
  captionLang: ExportCaptionLang;
  status: ExportStatus;
}

/** Doc snapshot for the internal print route (server only; the route checks its signed token first). */
export async function getExportForRender(exportId: string): Promise<RenderExport | null> {
  if (!isUuid(exportId)) return null;
  const { data, error } = await createAdminClient()
    .from("exports")
    .select(RENDER_EXPORT_COLUMNS)
    .eq("id", exportId)
    .maybeSingle();
  if (error) throw new ExportsQueryError("read render", error.code);
  if (!data) return null;
  const row = data as {
    id: string;
    book_id: string;
    user_id: string;
    doc_rev: number;
    doc: Json;
    caption_lang: string;
    status: string;
  };
  if (!(STATUSES as readonly string[]).includes(row.status)) throw new ExportsQueryError("read render", "bad_status");
  return {
    id: row.id,
    bookId: row.book_id,
    userId: row.user_id,
    docRev: row.doc_rev,
    doc: row.doc,
    captionLang: row.caption_lang === "ar" ? "ar" : "en",
    status: row.status as ExportStatus,
  };
}

/** Newest ready export of the book for this doc_rev (optionally this caption_lang), or null. */
export async function latestReadyExport(
  bookId: string,
  docRev: number,
  captionLang?: ExportCaptionLang,
): Promise<OwnerExport | null> {
  if (!isUuid(bookId)) return null;
  let q = createAdminClient()
    .from("exports")
    .select(OWNER_EXPORT_COLUMNS)
    .eq("book_id", bookId)
    .eq("status", "ready")
    .eq("doc_rev", docRev);
  if (captionLang) q = q.eq("caption_lang", captionLang);
  const { data, error } = await q.order("finished_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new ExportsQueryError("read latest", error.code);
  return data ? toOwnerExport(data as OwnerRow) : null;
}

export interface StoredExport {
  id: string;
  path: string;
}

/** Ready exports of the book other than `keepId` (D-051: keep only the latest PDF) — for cleanup. */
export async function listOlderReadyExports(bookId: string, keepId: string): Promise<StoredExport[]> {
  if (!isUuid(bookId) || !isUuid(keepId)) return [];
  const { data, error } = await createAdminClient()
    .from("exports")
    .select("id, path")
    .eq("book_id", bookId)
    .eq("status", "ready")
    .neq("id", keepId);
  if (error) throw new ExportsQueryError("list older", error.code);
  return ((data ?? []) as { id: string; path: string | null }[])
    .filter((r): r is StoredExport => typeof r.path === "string")
    .map((r) => ({ id: r.id, path: r.path }));
}

/**
 * Deletes export rows of the book (after their PDFs were removed from Storage). Only ready / failed
 * rows — never a job in flight. Returns the number of rows deleted.
 */
export async function deleteExportRows(bookId: string, exportIds: readonly string[]): Promise<number> {
  const ids = exportIds.filter(isUuid);
  if (!isUuid(bookId) || ids.length === 0) return 0;
  const { data, error } = await createAdminClient()
    .from("exports")
    .delete()
    .eq("book_id", bookId)
    .in("id", ids)
    .in("status", ["ready", "failed"])
    .select("id");
  if (error) throw new ExportsQueryError("delete", error.code);
  return (data ?? []).length;
}

// ---------------------------------------------------------------------------
// Storage (bucket `exports`, private, 50 MB, application/pdf — migration 0200). Admin client:
// clients may only read their own folder. Callers pass paths built by exportObjectPath from ids
// they verified; errors carry the storage status code only (never the path).

export const EXPORTS_BUCKET = "exports";
/** Bucket file_size_limit (0200): 52428800 bytes. */
export const EXPORT_MAX_BYTES = 50 * 1024 * 1024;
const REMOVE_BATCH = 100;

export class ExportStorageError extends Error {
  readonly code: string;
  constructor(op: string, code: string | undefined) {
    const safe = (code ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
    super(`exports storage: ${op} failed (${safe})`);
    this.name = "ExportStorageError";
    this.code = safe;
  }
}

function storageCode(error: unknown): string {
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "string") {
    return error.statusCode;
  }
  return "storage";
}

function isNotFound(error: unknown): boolean {
  if (storageCode(error) === "404") return true;
  const msg = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  return /not[ _]?found/i.test(msg);
}

/**
 * Uploads a finished PDF (upsert false). A leftover object at the same path (an earlier attempt
 * of the same job that died between upload and finish) is removed and the upload retried once.
 */
export async function uploadExportPdf(path: string, bytes: Uint8Array): Promise<void> {
  const bucket = createAdminClient().storage.from(EXPORTS_BUCKET);
  const opts = { contentType: "application/pdf", upsert: false, cacheControl: "0" };
  let { error } = await bucket.upload(path, bytes, opts);
  if (error && storageCode(error) === "409") {
    const removed = await bucket.remove([path]);
    if (removed.error) throw new ExportStorageError("upload", storageCode(removed.error));
    ({ error } = await bucket.upload(path, bytes, opts));
  }
  if (error) throw new ExportStorageError("upload", storageCode(error));
}

/** Removes objects from the exports bucket (missing objects are not an error). */
export async function removeExportObjects(paths: readonly string[]): Promise<void> {
  const bucket = createAdminClient().storage.from(EXPORTS_BUCKET);
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const { error } = await bucket.remove(paths.slice(i, i + REMOVE_BATCH));
    if (error) throw new ExportStorageError("remove", storageCode(error));
  }
}

/**
 * Signed download URL (Content-Disposition attachment; filename=`filename`). Signing checks the
 * object exists: returns null when it is missing, throws on other storage errors.
 */
export async function signExportUrl(path: string, ttlSeconds: number, filename: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .storage.from(EXPORTS_BUCKET)
    .createSignedUrl(path, Math.floor(ttlSeconds), { download: filename });
  if (error) {
    if (isNotFound(error)) return null;
    throw new ExportStorageError("sign", storageCode(error));
  }
  return data?.signedUrl ?? null;
}
