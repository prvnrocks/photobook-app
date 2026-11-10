import "server-only";
// PDF export job (M8 T7, D-047 / D-051 / D-052): the server flow behind /api/books/[id]/pdf.
//
//   requestExport  — POST: owner + live is_paid + canExport → create_export_job (atomic: reuse a
//                    ready PDF of this doc_rev + caption_lang, join the book's in-flight job, daily
//                    cap, insert). New/queued jobs are handed to `schedule` (the route uses after()).
//   getExportState — GET: the owner's job status; ready → fresh signed URL.
//   runExport      — claim lease → render (Chromium, print route) → merge → upload → finish →
//                    delete older ready PDFs of the book. Any failure → fail_export with a code.
//
// Ownership: requestExport / getExportState read the book with the user's session (RLS) and pass
// the user id into every admin query; runExport only works on a row create_export_job inserted
// for the verified owner, and loads photos filtered by that row's book_id AND user_id.
//
// Logs: `[pdf-export] <event> <exportId> (<code>)` only — never paths, titles, captions, user ids.

import { getMyBook } from "@/lib/db/books";
import {
  claimExport,
  createExportJob,
  deleteExportRows,
  EXPORT_MAX_BYTES,
  exportObjectPath,
  failExport,
  finishExport,
  getExportForOwner,
  getExportForRender,
  listOlderReadyExports,
  removeExportObjects,
  signExportUrl,
  uploadExportPdf,
  type ExportCaptionLang,
} from "@/lib/db/exports";
import { listPrintPhotoSources } from "@/lib/db/print";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { getAccessSecret } from "@/lib/publish/access-cookie";
import type { Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";
import { chromeConfigured } from "./browser";
import { isPdfRenderError } from "./errors";
import { mergePdfs } from "./finalize";
import { planPrintImages } from "./image-plan";
import { createPrintImageLoader, PrintImageError } from "./images";
import { printPhotoIds, type PrintSheetTarget } from "./print-doc";
import { renderBook } from "./render-pdf";
import { canExport, EXPORT_DAILY_CAP, EXPORT_STALE_SECONDS, pdfFilename, SIGNED_URL_TTL_SECONDS } from "./rules";

/** claim_export lease; the route's maxDuration is 300 s, so a killed invocation frees it soon after. */
export const EXPORT_LEASE_SECONDS = 300;
/** Overall render budget inside one invocation (maxDuration 300 s minus response + cleanup). */
export const EXPORT_DEADLINE_MS = 270_000;
/** A queued job older than this is re-kicked by GET polls (its after() callback likely died). */
export const QUEUED_KICK_AFTER_MS = 10_000;

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Environment

/**
 * Origin Chromium opens /print/[bookId] on. Production / local: NEXT_PUBLIC_APP_URL (as getSiteUrl;
 * dev without it: http://localhost:3000).
 * Vercel Preview: the deployment's own https://$VERCEL_URL — NEXT_PUBLIC_APP_URL may point at
 * production, whose print route would not find this deployment's tokens/rows consistently; the
 * deployment URL is behind Vercel Authentication, so renderBook sends
 * VERCEL_AUTOMATION_BYPASS_SECRET (set "Protection Bypass for Automation" on the project).
 * null = not configured (production without NEXT_PUBLIC_APP_URL).
 */
export function renderOrigin(env: Env = process.env): string | null {
  const host = env.VERCEL_URL?.trim();
  if (env.VERCEL_ENV === "preview" && host && /^[a-z0-9.-]+(:\d+)?$/i.test(host)) return `https://${host}`;
  // Same rules as getSiteUrl (auth/redirect.ts), but over `env` so it is testable.
  const fromEnv = env.NEXT_PUBLIC_APP_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return env.NODE_ENV === "production" ? null : "http://localhost:3000";
}

/** Cheap up-front check: print-token secret, a render origin and a Chromium source exist. */
export function exportAvailable(env: Env = process.env, platform: string = process.platform): boolean {
  if (!getAccessSecret(env)) return false;
  if (!renderOrigin(env)) return false;
  return chromeConfigured(env, platform);
}

// ---------------------------------------------------------------------------
// POST

export interface ReadyExport {
  status: "ready";
  exportId: string;
  url: string;
  filename: string;
  bytes: number;
  pageCount: number;
}

export interface PendingExport {
  status: "queued" | "rendering";
  exportId: string;
}

export type RequestExportError =
  | "not_found"
  | "not_paid"
  | "invalid_doc"
  | "empty"
  | "page_limit"
  | "daily_cap"
  | "conflict"
  | "unavailable";

export type RequestExportResult =
  | { ok: true; httpStatus: 200; body: ReadyExport }
  | { ok: true; httpStatus: 202; body: PendingExport }
  | { ok: false; error: RequestExportError };

export interface RequestExportOptions {
  /** Starts runExport(exportId) after the response (route: after()). */
  schedule: (exportId: string) => void;
  env?: Env;
}

function captionLangOf(v: unknown): ExportCaptionLang {
  return v === "ar" ? "ar" : "en";
}

function filenameFor(title: string | null | undefined, doc?: BookDoc | null): string {
  return pdfFilename(title || doc?.cover.title || "");
}

/**
 * POST flow. Retries once on stale_rev (doc saved between read and create) and once when a
 * "ready" row's PDF is missing from Storage (that row is deleted, then a new job is created).
 */
export async function requestExport(
  bookId: string,
  userId: string,
  opts: RequestExportOptions,
): Promise<RequestExportResult> {
  if (!isUuid(bookId) || !isUuid(userId)) return { ok: false, error: "not_found" };
  let staleRetried = false;
  let missingRetried = false;

  for (;;) {
    const book = await getMyBook(bookId);
    if (!book) return { ok: false, error: "not_found" };
    const check = canExport({ isPaid: book.is_paid === true, doc: book.doc, maxPages: book.max_pages });
    if (!check.ok) return { ok: false, error: check.reason };
    if (book.doc_rev === null) return { ok: false, error: "unavailable" }; // migration 0900 missing
    if (!exportAvailable(opts.env)) return { ok: false, error: "unavailable" };

    const res = await createExportJob({
      bookId,
      userId,
      docRev: book.doc_rev,
      doc: book.doc as Json,
      captionLang: captionLangOf(book.caption_lang),
      dailyCap: EXPORT_DAILY_CAP,
      staleSeconds: EXPORT_STALE_SECONDS,
    });

    switch (res.status) {
      case "not_found":
      case "not_paid":
      case "daily_cap":
        return { ok: false, error: res.status };
      case "stale_rev":
        if (staleRetried) return { ok: false, error: "conflict" };
        staleRetried = true;
        continue;
      case "created":
        opts.schedule(res.exportId);
        return { ok: true, httpStatus: 202, body: { status: "queued", exportId: res.exportId } };
      case "running": {
        // create_export_job reaps rendering rows with an expired lease, so a "rendering" row here
        // is live. A queued row may have lost its after() callback — claim is atomic, so kicking
        // it again is harmless.
        const own = await getExportForOwner(res.exportId, userId);
        const status = own?.status === "queued" ? "queued" : "rendering";
        if (status === "queued") opts.schedule(res.exportId);
        return { ok: true, httpStatus: 202, body: { status, exportId: res.exportId } };
      }
      case "ready": {
        const own = await getExportForOwner(res.exportId, userId);
        const filename = filenameFor(book.title, check.doc);
        const url =
          own && own.status === "ready"
            ? await signExportUrl(exportObjectPath(userId, bookId, res.exportId), SIGNED_URL_TTL_SECONDS, filename)
            : null;
        if (own && url) {
          return {
            ok: true,
            httpStatus: 200,
            body: {
              status: "ready",
              exportId: own.id,
              url,
              filename,
              bytes: own.bytes ?? 0,
              pageCount: own.pageCount ?? 0,
            },
          };
        }
        // The row says ready but the PDF is gone (manual cleanup / partial failure): drop the
        // row so create_export_job can make a new job, then try once more.
        if (missingRetried) return { ok: false, error: "unavailable" };
        missingRetried = true;
        console.info(`[pdf-export] missing_file ${res.exportId}`);
        await deleteExportRows(bookId, [res.exportId]);
        continue;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// GET

export type ExportStateResult =
  | { found: false }
  | { found: true; body: ReadyExport | { status: "queued" | "rendering" } | { status: "failed"; error: string } };

export async function getExportState(
  bookId: string,
  userId: string,
  exportId: string,
  opts: { schedule?: (exportId: string) => void; now?: Date } = {},
): Promise<ExportStateResult> {
  if (!isUuid(bookId) || !isUuid(userId) || !isUuid(exportId)) return { found: false };
  const own = await getExportForOwner(exportId, userId);
  if (!own || own.bookId.toLowerCase() !== bookId.toLowerCase()) return { found: false };

  switch (own.status) {
    case "queued": {
      const age = (opts.now ?? new Date()).getTime() - Date.parse(own.createdAt);
      if (opts.schedule && Number.isFinite(age) && age >= QUEUED_KICK_AFTER_MS) opts.schedule(own.id);
      return { found: true, body: { status: "queued" } };
    }
    case "rendering":
      return { found: true, body: { status: "rendering" } };
    case "failed":
      return { found: true, body: { status: "failed", error: own.errorCode ?? "error" } };
    case "ready": {
      const book = await getMyBook(bookId); // RLS read: title for the filename, ownership again
      if (!book) return { found: false };
      const parsed = parseBookDoc(book.doc);
      const filename = filenameFor(book.title, parsed.ok ? parsed.doc : null);
      const url = await signExportUrl(exportObjectPath(userId, own.bookId, own.id), SIGNED_URL_TTL_SECONDS, filename);
      if (!url) return { found: true, body: { status: "failed", error: "missing_file" } };
      return {
        found: true,
        body: { status: "ready", exportId: own.id, url, filename, bytes: own.bytes ?? 0, pageCount: own.pageCount ?? 0 },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Worker

/** Job-level failure codes (besides PdfRenderError / PrintImageError codes). */
export type ExportJobErrorCode =
  | "not_found"
  | "invalid_doc"
  | "empty"
  | "too_large"
  | "upload_failed"
  | "render_timeout"
  | "unavailable"
  | "server_error";

export class ExportJobError extends Error {
  readonly code: ExportJobErrorCode;
  constructor(code: ExportJobErrorCode) {
    super(`PDF export failed (${code})`);
    this.name = "ExportJobError";
    this.code = code;
  }
}

/** fail_export code for any error thrown by the job. */
export function failureCode(err: unknown): string {
  if (err instanceof ExportJobError) return err.code;
  if (isPdfRenderError(err)) return err.code;
  if (err instanceof PrintImageError) return err.code;
  return "server_error";
}

export interface RunExportOptions {
  /** Overall budget (default EXPORT_DEADLINE_MS) → 'render_timeout'. */
  deadlineMs?: number;
  /** Test hook: renderer (default renderBook). */
  render?: typeof renderBook;
}

function allSheets(doc: BookDoc): PrintSheetTarget[] {
  return ["cover", ...doc.pages.map((_p, i) => i)];
}

async function renderAndStore(
  exportId: string,
  token: string,
  state: { aborted: boolean },
  render: typeof renderBook,
): Promise<"ready" | "lease_lost"> {
  const exp = await getExportForRender(exportId);
  if (!exp || exp.status !== "rendering") throw new ExportJobError("not_found");
  const parsed = parseBookDoc(exp.doc);
  if (!parsed.ok) throw new ExportJobError("invalid_doc");
  const doc = parsed.doc;
  if (doc.pages.length < 1) throw new ExportJobError("empty");

  const origin = renderOrigin();
  if (!origin) throw new ExportJobError("unavailable");

  // Ownership: the row was inserted by create_export_job for the verified owner; photos are
  // loaded for that book AND that user only (admin client bypasses RLS).
  const photos = await listPrintPhotoSources(exp.bookId, exp.userId, printPhotoIds(doc, allSheets(doc)));
  const plan = planPrintImages(doc, photos);
  const loader = createPrintImageLoader(plan, photos);

  const chunks = await render({
    origin,
    bookId: exp.bookId,
    exportId: exp.id,
    docRev: exp.docRev,
    sheetCount: doc.pages.length + 1,
    loader,
  });
  if (state.aborted) throw new ExportJobError("render_timeout");
  const merged = await mergePdfs(chunks, { title: doc.cover.title });
  if (merged.bytes.byteLength > EXPORT_MAX_BYTES) throw new ExportJobError("too_large");
  if (state.aborted) throw new ExportJobError("render_timeout");

  const path = exportObjectPath(exp.userId, exp.bookId, exp.id);
  try {
    await uploadExportPdf(path, merged.bytes);
  } catch {
    throw new ExportJobError("upload_failed");
  }

  let finished: boolean;
  try {
    finished = await finishExport({
      exportId: exp.id,
      token,
      path,
      bytes: merged.bytes.byteLength,
      pageCount: merged.pageCount,
    });
  } catch (err) {
    await removeQuietly(exportId, path);
    throw err;
  }
  if (!finished) {
    // Lease gone (reaped / re-claimed): this object is not referenced by a ready row.
    await removeQuietly(exportId, path);
    return "lease_lost";
  }

  // D-051: keep only the latest PDF of the book. Best effort — a leftover is harmless.
  try {
    const older = await listOlderReadyExports(exp.bookId, exp.id);
    if (older.length > 0) {
      await removeExportObjects(older.map((o) => o.path));
      await deleteExportRows(
        exp.bookId,
        older.map((o) => o.id),
      );
    }
  } catch (err) {
    console.error(`[pdf-export] cleanup_failed ${exportId} (${codeOf(err)})`);
  }
  return "ready";
}

async function removeQuietly(exportId: string, path: string): Promise<void> {
  try {
    await removeExportObjects([path]);
  } catch (err) {
    console.error(`[pdf-export] orphan_remove_failed ${exportId} (${codeOf(err)})`);
  }
}

function codeOf(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
  }
  return "unknown";
}

/**
 * Renders one export job end to end. Never throws: failures are recorded with fail_export and
 * logged as codes. Returns the outcome (for tests / logs).
 */
export async function runExport(
  exportId: string,
  opts: RunExportOptions = {},
): Promise<"ready" | "failed" | "not_claimed" | "lease_lost"> {
  if (!isUuid(exportId)) return "not_claimed";
  let token: string | null;
  try {
    token = await claimExport(exportId, EXPORT_LEASE_SECONDS);
  } catch (err) {
    console.error(`[pdf-export] claim_failed ${exportId} (${codeOf(err)})`);
    return "not_claimed";
  }
  if (!token) return "not_claimed";

  const started = Date.now();
  const state = { aborted: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      state.aborted = true;
      reject(new ExportJobError("render_timeout"));
    }, opts.deadlineMs ?? EXPORT_DEADLINE_MS);
  });
  const work = renderAndStore(exportId, token, state, opts.render ?? renderBook);
  work.catch(() => undefined); // after a timeout the abandoned work may still reject

  try {
    const outcome = await Promise.race([work, deadline]);
    console.info(`[pdf-export] ${outcome} ${exportId} (${Date.now() - started} ms)`);
    return outcome;
  } catch (err) {
    const code = failureCode(err);
    console.error(`[pdf-export] failed ${exportId} (${code})`);
    try {
      await failExport(exportId, token, code);
    } catch (e) {
      console.error(`[pdf-export] fail_record_failed ${exportId} (${codeOf(e)})`);
    }
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
