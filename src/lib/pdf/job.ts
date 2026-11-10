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
// Logs: `[pdf-export] <event> <exportId> (<code>)` and one `timing` line (ms / counts / KB) only —
// never paths, titles, captions, photo or user ids.
//
// Render headroom: right after the image plan is built, print copies for the first
// PREFETCH_WINDOW_CHUNKS chunks start downloading/encoding while Chromium launches; each rendered
// chunk releases the copies it was the last user of and queues the next chunk's (prefetch.ts).

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
import { chunkPhotoSchedule, PREFETCH_WINDOW_CHUNKS, startPrefetch } from "./prefetch";
import { printPhotoIds, type PrintSheetTarget } from "./print-doc";
import { renderBook, type RenderTimings } from "./render-pdf";
import {
  canExport,
  chunkRanges,
  CHUNK_SHEETS,
  EXPORT_DAILY_CAP,
  EXPORT_STALE_SECONDS,
  pdfFilename,
  SIGNED_URL_TTL_SECONDS,
} from "./rules";

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
  /** Prefetch print images ahead of Chromium (default true; false = lazy, on request). */
  prefetch?: boolean;
  /** Print images in flight (default PRINT_IMAGE_IN_FLIGHT). */
  imageConcurrency?: number;
  /** Parallel sharp encodes (default printEncodeConcurrency()). */
  encodeConcurrency?: number;
  /** Chunks rendered at once (default RENDER_PARALLEL_CHUNKS). */
  parallelChunks?: number;
}

/** Phase timings for the `timing` log line (ms unless noted). */
interface ExportTimings {
  load: number;
  plan: number;
  /** Plan built → first prefetch window settled (-1: not prefetched / not reached). */
  images: number;
  launch: number;
  render: number;
  chunks: number[];
  merge: number;
  upload: number;
  finish: number;
}

export function formatTimingLog(
  exportId: string,
  t: ExportTimings,
  extra: {
    images: number;
    produced: number;
    failed: number;
    peakKb: number;
    downloadMs: number;
    encodeMs: number;
    concurrency: number | null;
    encodeConcurrency?: number | null;
  },
): string {
  const n = (v: number) => (Number.isFinite(v) ? Math.round(v) : -1);
  return (
    `[pdf-export] timing ${exportId} load=${n(t.load)} plan=${n(t.plan)} images_ready=${n(t.images)} launch=${n(t.launch)} ` +
    `render=${n(t.render)} chunks=${t.chunks.map(n).join("/") || "-"} merge=${n(t.merge)} upload=${n(t.upload)} finish=${n(t.finish)} ` +
    `imgs=${n(extra.images)} produced=${n(extra.produced)} failed=${n(extra.failed)} peak_kb=${n(extra.peakKb)} ` +
    `dl_sum=${n(extra.downloadMs)} enc_sum=${n(extra.encodeMs)} conc=${extra.concurrency ?? "auto"} enc_conc=${extra.encodeConcurrency ?? "auto"}`
  );
}

function allSheets(doc: BookDoc): PrintSheetTarget[] {
  return ["cover", ...doc.pages.map((_p, i) => i)];
}

interface ImageLogStats {
  images: number;
  produced: number;
  failed: number;
  peakKb: number;
  downloadMs: number;
  encodeMs: number;
}

async function renderAndStore(
  exportId: string,
  token: string,
  state: { aborted: boolean },
  opts: RunExportOptions,
  timings: ExportTimings,
  imageStats: ImageLogStats,
): Promise<"ready" | "lease_lost"> {
  const render = opts.render ?? renderBook;
  const tStart = Date.now();
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
  const tLoaded = Date.now();
  timings.load = tLoaded - tStart;
  const plan = planPrintImages(doc, photos);
  const loader = createPrintImageLoader(plan, photos, {
    ...(opts.imageConcurrency ? { concurrency: opts.imageConcurrency } : {}),
    ...(opts.encodeConcurrency ? { encodeConcurrency: opts.encodeConcurrency } : {}),
  });
  const sheetCount = doc.pages.length + 1;
  const tPlanned = Date.now();
  timings.plan = tPlanned - tLoaded;

  // Prefetch: start producing the first window's print copies now, in parallel with the browser
  // launch inside render(); later chunks are queued as earlier ones finish.
  let onChunkDone: ((k: number) => void) | undefined;
  if (opts.prefetch !== false) {
    const schedule = chunkPhotoSchedule(doc, chunkRanges(sheetCount, CHUNK_SHEETS), (id) => plan.has(id));
    const controller = startPrefetch(loader, schedule, PREFETCH_WINDOW_CHUNKS);
    // Promises taken now (cache hits on what prefetch queued) — never get() after a release.
    const firstWindow = schedule.uses.slice(0, PREFETCH_WINDOW_CHUNKS).flat();
    void Promise.allSettled(firstWindow.map((id) => loader.get(id))).then(() => {
      timings.images = Date.now() - tPlanned;
    });
    onChunkDone = (k) => controller.chunkDone(k);
  }

  const renderTimings: RenderTimings = { launchMs: 0, chunkMs: [] };
  const tRender = Date.now();
  const chunks = await render({
    origin,
    bookId: exp.bookId,
    exportId: exp.id,
    docRev: exp.docRev,
    sheetCount,
    loader,
    onChunkDone,
    timings: renderTimings,
    ...(opts.parallelChunks ? { parallelChunks: opts.parallelChunks } : {}),
  });
  timings.render = Date.now() - tRender;
  timings.launch = renderTimings.launchMs;
  timings.chunks = renderTimings.chunkMs;
  const stats = loader.stats?.();
  if (stats) {
    imageStats.images = plan.size;
    imageStats.produced = stats.produced;
    imageStats.failed = stats.failed;
    imageStats.peakKb = stats.peakHeldBytes / 1024;
    imageStats.downloadMs = stats.downloadMs;
    imageStats.encodeMs = stats.encodeMs;
  }
  if (state.aborted) throw new ExportJobError("render_timeout");
  const tMerge = Date.now();
  const merged = await mergePdfs(chunks, { title: doc.cover.title });
  timings.merge = Date.now() - tMerge;
  if (merged.bytes.byteLength > EXPORT_MAX_BYTES) throw new ExportJobError("too_large");
  if (state.aborted) throw new ExportJobError("render_timeout");

  const path = exportObjectPath(exp.userId, exp.bookId, exp.id);
  const tUpload = Date.now();
  try {
    await uploadExportPdf(path, merged.bytes);
  } catch {
    throw new ExportJobError("upload_failed");
  }
  timings.upload = Date.now() - tUpload;
  const tFinish = Date.now();

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
  timings.finish = Date.now() - tFinish;
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
  const timings: ExportTimings = { load: -1, plan: -1, images: -1, launch: -1, render: -1, chunks: [], merge: -1, upload: -1, finish: -1 };
  const imageStats: ImageLogStats = { images: -1, produced: -1, failed: -1, peakKb: -1, downloadMs: -1, encodeMs: -1 };
  const logTimings = () =>
    console.info(
      formatTimingLog(exportId, timings, {
        ...imageStats,
        concurrency: opts.imageConcurrency ?? null,
        encodeConcurrency: opts.encodeConcurrency ?? null,
      }),
    );
  const work = renderAndStore(exportId, token, state, opts, timings, imageStats);
  work.catch(() => undefined); // after a timeout the abandoned work may still reject

  try {
    const outcome = await Promise.race([work, deadline]);
    console.info(`[pdf-export] ${outcome} ${exportId} (${Date.now() - started} ms)`);
    logTimings();
    return outcome;
  } catch (err) {
    const code = failureCode(err);
    console.error(`[pdf-export] failed ${exportId} (${code})`);
    logTimings();
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
