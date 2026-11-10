import "server-only";
// PDF export job (M8 T7, D-047 / D-051 / D-052): the server flow behind /api/books/[id]/pdf.
//
//   requestExport  — POST: owner + live is_paid + canExport → create_export_job (atomic: reuse a
//                    ready PDF of this doc_rev + caption_lang, join the book's in-flight job, daily
//                    cap, insert). New/queued jobs are handed to `schedule` (the route uses after()).
//   getExportState — GET: the owner's job status; ready → fresh signed URL (status.ts — no
//                    renderer imports, shared with the lightweight /pdf/status route).
//   runExport      — one render per process (else 'busy_instance', job stays queued) → claim
//                    lease → render (Chromium, print route) → merge (→ one size-fallback
//                    re-render when > 50 MB and < 45 % of the deadline used) → upload → finish → supersede older ready PDFs of
//                    the book (objects removed, rows KEPT as 'superseded' — the daily cap counts
//                    rows, M8 review S1). Any failure → fail_export with a code.
//
// Deadline (S2): runExport owns an AbortController fired at EXPORT_DEADLINE_MS. The signal goes
// into the image loader (downloads abort, nothing new starts), the prefetch controller (stops
// queueing) and renderBook (checked between chunks; tabs + browser closed on abort).
//
// Re-kick (N3): a job whose after() callback died stays queued, and a job whose invocation was
// killed stays 'rendering' with an expired lease. create_export_job reports both as running +
// claimable, and POST schedules runExport again (claim_export allows ≤ 3 claims in total).
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
  EXPORT_MAX_BYTES,
  exportObjectPath,
  failExport,
  finishExport,
  getExportForOwner,
  getExportForRender,
  listOlderReadyExports,
  removeExportObjects,
  signExportUrl,
  supersedeExports,
  uploadExportPdf,
} from "@/lib/db/exports";
import { listPrintPhotoSources } from "@/lib/db/print";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import type { PrintPhotoSourceRow } from "@/lib/db/print";
import { getAccessSecret } from "@/lib/publish/access-cookie";
import type { Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/uuid";
import { chromeConfigured } from "./browser";
import { isPdfRenderError } from "./errors";
import { mergePdfs } from "./finalize";
import { planPrintImages, type PlanOptions } from "./image-plan";
import { createPrintImageLoader, PRINT_JPEG_QUALITY, PrintImageError } from "./images";
import { chunkPhotoSchedule, PREFETCH_WINDOW_CHUNKS, startPrefetch } from "./prefetch";
import { printPhotoIds, type PrintSheetTarget } from "./print-doc";
import { renderBook, type RenderTimings } from "./render-pdf";
import {
  canExport,
  chunkRanges,
  CHUNK_SHEETS,
  EXPORT_DAILY_CAP,
  EXPORT_STALE_SECONDS,
  PDF_DEADLINE_MS,
  PDF_MAX_DURATION_SECONDS,
  PDF_RENDERER_VERSION,
  SIGNED_URL_TTL_SECONDS,
  SIZE_FALLBACK_DPI,
  SIZE_FALLBACK_JPEG_QUALITY,
} from "./rules";
import {
  captionLangOf,
  filenameFor,
  getExportState,
  markMissingFile,
  QUEUED_KICK_AFTER_MS,
  type ExportStateResult,
  type PendingExport,
  type ReadyExport,
} from "./status";

export { getExportState, QUEUED_KICK_AFTER_MS };
export type { ExportStateResult, PendingExport, ReadyExport };

/** claim_export lease = the function budget, so a killed invocation frees it right after. */
export const EXPORT_LEASE_SECONDS = PDF_MAX_DURATION_SECONDS;
/** Overall render budget inside one invocation (rules.PDF_DEADLINE_MS = maxDuration − 30 s). */
export const EXPORT_DEADLINE_MS = PDF_DEADLINE_MS;

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

/**
 * POST flow. Retries once on stale_rev (doc saved between read and create) and once when a
 * "ready" row's PDF is missing from Storage (that row is marked superseded/missing_file — never
 * deleted, so it still counts towards the daily cap — then a new job is created).
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
      rendererVersion: PDF_RENDERER_VERSION,
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
        // claimable = queued (its after() callback may have died) or rendering with an expired
        // lease and claims left (the invocation was killed) — N3: kick it again. claim_export is
        // atomic, so a duplicate kick of a job that is in fact running is a no-op.
        if (res.claimable) opts.schedule(res.exportId);
        return { ok: true, httpStatus: 202, body: { status: res.state, exportId: res.exportId } };
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
        // The row says ready but the PDF is gone (manual cleanup / partial failure): mark the row
        // (it stays — the daily cap counts it) so create_export_job can make a new job, then try
        // once more.
        if (missingRetried) return { ok: false, error: "unavailable" };
        missingRetried = true;
        await markMissingFile(bookId, userId, res.exportId);
        continue;
      }
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
  /** After the deadline fired: max wait for the aborted work to unwind (default ABORT_SETTLE_MS). */
  abortSettleMs?: number;
}

/** Phase timings for the `timing` log line (ms unless noted). */
interface ExportTimings {
  load: number;
  plan: number;
  /** Plan built → first prefetch window settled (-1: not prefetched / not reached). */
  images: number;
  /** Live renderer timings: launch + finished chunks, readable after a failure too. */
  renderer: RenderTimings;
  render: number;
  merge: number;
  upload: number;
  finish: number;
  /** 1 when the size fallback re-render ran (the phase timings above are then of that pass). */
  sizeFallback?: number;
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
    `[pdf-export] timing ${exportId} load=${n(t.load)} plan=${n(t.plan)} images_ready=${n(t.images)} launch=${n(t.renderer.launchMs)} ` +
    `render=${n(t.render)} chunks=${t.renderer.chunkMs.map(n).join("/") || "-"} merge=${n(t.merge)} upload=${n(t.upload)} finish=${n(t.finish)} ` +
    `imgs=${n(extra.images)} produced=${n(extra.produced)} failed=${n(extra.failed)} peak_kb=${n(extra.peakKb)} ` +
    `dl_sum=${n(extra.downloadMs)} enc_sum=${n(extra.encodeMs)} conc=${extra.concurrency ?? "auto"} enc_conc=${extra.encodeConcurrency ?? "auto"} ` +
    `size_fallback=${t.sizeFallback ? 1 : 0}`
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

/** Image settings of one render pass: the default, then (once) the size fallback. */
interface RenderPass {
  plan: PlanOptions;
  quality: number;
}

const DEFAULT_PASS: RenderPass = { plan: {}, quality: PRINT_JPEG_QUALITY };
/** M8 T12 follow-up: a 100-page noisy book exceeded the 50 MB bucket limit at 300 dpi / q80. */
export const SIZE_FALLBACK_PASS: RenderPass = {
  plan: { dpi: SIZE_FALLBACK_DPI },
  quality: SIZE_FALLBACK_JPEG_QUALITY,
};

interface RenderContext {
  exportId: string;
  bookId: string;
  userId: string;
  docRev: number;
  doc: BookDoc;
  photos: PrintPhotoSourceRow[];
  origin: string;
  signal: AbortSignal;
  opts: RunExportOptions;
  timings: ExportTimings;
  imageStats: ImageLogStats;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportJobError("render_timeout");
}

/** One pass: plan → loader (+ prefetch) → Chromium chunks → merged PDF. */
async function renderPass(ctx: RenderContext, pass: RenderPass): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const { doc, opts, timings, imageStats, signal } = ctx;
  const render = opts.render ?? renderBook;
  const tPlan = Date.now();
  const plan = planPrintImages(doc, ctx.photos, pass.plan);
  // Originals are downloaded again for a second pass: the loader only keeps encoded copies,
  // and keeping every original of a 100-page book in memory would cost up to ~2 GB.
  const loader = createPrintImageLoader(plan, ctx.photos, {
    ...(opts.imageConcurrency ? { concurrency: opts.imageConcurrency } : {}),
    ...(opts.encodeConcurrency ? { encodeConcurrency: opts.encodeConcurrency } : {}),
    ...(pass.quality !== PRINT_JPEG_QUALITY ? { quality: pass.quality } : {}),
    signal,
  });
  const sheetCount = doc.pages.length + 1;
  const tPlanned = Date.now();
  timings.plan = tPlanned - tPlan;
  timings.images = -1;

  // Prefetch: start producing the first window's print copies now, in parallel with the browser
  // launch inside render(); later chunks are queued as earlier ones finish.
  let onChunkDone: ((k: number) => void) | undefined;
  let stopPrefetch: (() => void) | undefined;
  if (opts.prefetch !== false) {
    const schedule = chunkPhotoSchedule(doc, chunkRanges(sheetCount, CHUNK_SHEETS), (id) => plan.has(id));
    const controller = startPrefetch(loader, schedule, PREFETCH_WINDOW_CHUNKS);
    // Promises taken now (cache hits on what prefetch queued) — never get() after a release.
    const firstWindow = schedule.uses.slice(0, PREFETCH_WINDOW_CHUNKS).flat();
    void Promise.allSettled(firstWindow.map((id) => loader.get(id))).then(() => {
      timings.images = Date.now() - tPlanned;
    });
    onChunkDone = (k) => controller.chunkDone(k);
    stopPrefetch = () => controller.stop();
  }
  // Deadline: queue nothing more (the loader itself rejects new work once the signal fired).
  if (stopPrefetch) signal.addEventListener("abort", stopPrefetch, { once: true });

  try {
    const tRender = Date.now();
    const chunks = await render({
      origin: ctx.origin,
      bookId: ctx.bookId,
      exportId: ctx.exportId,
      docRev: ctx.docRev,
      sheetCount,
      loader,
      onChunkDone,
      timings: timings.renderer,
      signal,
      ...(opts.parallelChunks ? { parallelChunks: opts.parallelChunks } : {}),
    });
    timings.render = Date.now() - tRender;
    const stats = loader.stats?.();
    if (stats) {
      imageStats.images = plan.size;
      imageStats.produced = stats.produced;
      imageStats.failed = stats.failed;
      imageStats.peakKb = stats.peakHeldBytes / 1024;
      imageStats.downloadMs = stats.downloadMs;
      imageStats.encodeMs = stats.encodeMs;
    }
    throwIfAborted(signal);
    const tMerge = Date.now();
    const merged = await mergePdfs(chunks, { title: doc.cover.title });
    timings.merge = Date.now() - tMerge;
    return merged;
  } finally {
    if (stopPrefetch) {
      signal.removeEventListener("abort", stopPrefetch);
      stopPrefetch();
    }
  }
}

/**
 * The size fallback runs only while less than this fraction of the deadline has elapsed (the
 * second pass takes about as long as the first; past ~45 % it would hit render_timeout anyway).
 */
export const SIZE_FALLBACK_MAX_ELAPSED = 0.45;

async function renderAndStore(
  exportId: string,
  token: string,
  signal: AbortSignal,
  opts: RunExportOptions,
  timings: ExportTimings,
  imageStats: ImageLogStats,
  startedAt: number,
): Promise<"ready" | "lease_lost"> {
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
  timings.load = Date.now() - tStart;
  throwIfAborted(signal);

  const ctx: RenderContext = {
    exportId: exp.id,
    bookId: exp.bookId,
    userId: exp.userId,
    docRev: exp.docRev,
    doc,
    photos,
    origin,
    signal,
    opts,
    timings,
    imageStats,
  };
  let merged: { bytes: Uint8Array; pageCount: number } | null = await renderPass(ctx, DEFAULT_PASS);
  throwIfAborted(signal);
  if (merged.bytes.byteLength > EXPORT_MAX_BYTES) {
    // Size fallback: every image at SIZE_FALLBACK_DPI / quality SIZE_FALLBACK_JPEG_QUALITY, once.
    const firstKb = Math.round(merged.bytes.byteLength / 1024);
    // Drop the too-large PDF (> 50 MB) before the second pass, so it can be collected while the
    // re-render holds its own chunks — two merged PDFs at once is a 2 GB-instance OOM risk.
    merged = null;
    // A second pass costs about as long as the first: when the first already used more than
    // SIZE_FALLBACK_MAX_ELAPSED of the budget, it would only end in render_timeout — fail fast.
    const budget = opts.deadlineMs ?? EXPORT_DEADLINE_MS;
    if (Date.now() - startedAt > budget * SIZE_FALLBACK_MAX_ELAPSED) {
      console.info(`[pdf-export] size_fallback_skipped ${exportId} (${firstKb} KB)`);
      throw new ExportJobError("too_large");
    }
    console.info(`[pdf-export] size_fallback ${exportId} (${firstKb} KB)`);
    timings.sizeFallback = 1;
    timings.renderer.launchMs = -1;
    timings.renderer.chunkMs.length = 0;
    timings.render = -1;
    timings.merge = -1;
    merged = await renderPass(ctx, SIZE_FALLBACK_PASS);
    throwIfAborted(signal);
    if (merged.bytes.byteLength > EXPORT_MAX_BYTES) throw new ExportJobError("too_large");
  }

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

  // D-051: keep only the latest PDF of the book. Objects are removed, rows are KEPT (status
  // 'superseded') so the daily cap still counts them (M8 review S1). Best effort: a leftover ready
  // row whose object is gone is marked missing_file by the next request that finds it.
  try {
    const older = await listOlderReadyExports(exp.bookId, exp.id);
    if (older.length > 0) {
      await removeExportObjects(older.map((o) => o.path));
      await supersedeExports(
        exp.bookId,
        exp.userId,
        older.map((o) => o.id),
        "superseded",
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

export type RunExportOutcome = "ready" | "failed" | "not_claimed" | "lease_lost" | "busy_instance";

/**
 * One render per process (M8 re-review): with Vercel Fluid compute one 2 GB / 1 vCPU instance can
 * serve concurrent requests, and two Chromium renders in one process risk an OOM. A second
 * runExport on a busy instance returns 'busy_instance' BEFORE claim_export, so its job stays
 * queued; the client re-POSTs a job queued ≥ PDF_REKICK_QUEUED_MS (or the next POST) and
 * another instance — or this one, once free — picks it up.
 */
let activeRender: string | null = null;

/** Test hook: the export id currently rendering in this process (null = idle). */
export function activeRenderId(): string | null {
  return activeRender;
}

/**
 * Renders one export job end to end. Never throws: failures are recorded with fail_export and
 * logged as codes. Returns the outcome (for tests / logs).
 *
 * The deadline aborts the work for real (S2): the AbortSignal stops downloads, prefetch and the
 * renderer (browser closed). runExport still answers as soon as the deadline fires, and waits
 * briefly (ABORT_SETTLE_MS) for the aborted work to unwind before recording the failure, so the
 * browser is gone before the invocation ends.
 */
export async function runExport(exportId: string, opts: RunExportOptions = {}): Promise<RunExportOutcome> {
  if (!isUuid(exportId)) return "not_claimed";
  if (activeRender !== null) {
    console.info(`[pdf-export] busy_instance ${exportId}`);
    return "busy_instance";
  }
  // Taken synchronously (no await between check and set) and released in finally on every path.
  activeRender = exportId;
  try {
    return await runClaimedExport(exportId, opts);
  } finally {
    activeRender = null;
  }
}

async function runClaimedExport(exportId: string, opts: RunExportOptions): Promise<RunExportOutcome> {
  let token: string | null;
  try {
    token = await claimExport(exportId, EXPORT_LEASE_SECONDS);
  } catch (err) {
    console.error(`[pdf-export] claim_failed ${exportId} (${codeOf(err)})`);
    return "not_claimed";
  }
  if (!token) return "not_claimed";

  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ExportJobError("render_timeout"));
    }, opts.deadlineMs ?? EXPORT_DEADLINE_MS);
  });
  const timings: ExportTimings = {
    load: -1,
    plan: -1,
    images: -1,
    renderer: { launchMs: -1, chunkMs: [] },
    render: -1,
    merge: -1,
    upload: -1,
    finish: -1,
  };
  const imageStats: ImageLogStats = { images: -1, produced: -1, failed: -1, peakKb: -1, downloadMs: -1, encodeMs: -1 };
  const logTimings = () =>
    console.info(
      formatTimingLog(exportId, timings, {
        ...imageStats,
        concurrency: opts.imageConcurrency ?? null,
        encodeConcurrency: opts.encodeConcurrency ?? null,
      }),
    );
  const work = renderAndStore(exportId, token, controller.signal, opts, timings, imageStats, started);
  work.catch(() => undefined); // after a timeout the aborted work rejects too

  try {
    const outcome = await Promise.race([work, deadline]);
    console.info(`[pdf-export] ${outcome} ${exportId} (${Date.now() - started} ms)`);
    logTimings();
    return outcome;
  } catch (err) {
    const code = failureCode(err);
    console.error(`[pdf-export] failed ${exportId} (${code})`);
    if (controller.signal.aborted) await settle(work, opts.abortSettleMs ?? ABORT_SETTLE_MS);
    logTimings();
    try {
      await failExport(exportId, token, code);
    } catch (e) {
      console.error(`[pdf-export] fail_record_failed ${exportId} (${codeOf(e)})`);
    }
    return "failed";
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(); // stop any stray loads after a failure
  }
}

/** After an abort, how long runExport waits for the work (browser close) to unwind. */
export const ABORT_SETTLE_MS = 10_000;

async function settle(work: Promise<unknown>, ms: number): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((r) => {
      t = setTimeout(r, ms);
    }),
  ]);
  clearTimeout(t);
}
