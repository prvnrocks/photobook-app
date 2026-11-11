import "server-only";
// Print route → PDF chunks with headless Chromium (D-049, D-052).
//
// One page (tab) per chunk (≤ CHUNK_SHEETS sheets), RENDER_PARALLEL_CHUNKS at a time to bound memory. Network:
// classifyRequest() decides every request — print images are answered in-process from the
// PrintImageLoader (404 on failure so the print page flags __PRINT_ERROR__), the app's own origin
// is continued (plus the Vercel protection-bypass header when configured, for Preview
// deployments), data:/blob: pass, everything else is aborted.
//
// Print token (N6): the URL carries no token. Each chunk's signed token is sent as the
// PRINT_TOKEN_HEADER request header, added by request interception to NAVIGATION requests on the
// app origin only (never to assets, never off-origin), so it doesn't end up in URLs, logs or
// history.
//
// Deadline (S2): an AbortSignal stops the render — checked before every chunk; on abort the
// current tab is closed and an owned browser is closed (process killed if close hangs), so a
// timed-out job stops burning CPU/memory instead of rendering on in the background.
//
// The print page (T5) sets window.__PRINT_READY__ = true once fonts and images are decoded, or
// __PRINT_ERROR__ ('image') / __PRINT_TIMEOUT__ = true. Errors are PdfRenderError codes only:
// URLs (they carry print tokens) and photo ids are never put into messages.

import type { Browser, HTTPRequest, Page } from "puppeteer-core";
import { closeBrowser, launchBrowser } from "./browser";
import { PdfRenderError } from "./errors";
import type { PrintImageLoader } from "./images";
import { printTokenExpiry, signPrintToken } from "./print-token";
import { PRINT_TOKEN_HEADER } from "./print-token-source";
import { assetPhotoId, classifyRequest } from "./request-routing";
import { CHUNK_SHEETS, chunkRanges, isValidChunkPlan, type SheetRange } from "./rules";

/** Budget for one chunk from navigation until the page reports ready. */
export const CHUNK_READY_TIMEOUT_MS = 60_000;
/** Budget for page.pdf() of one chunk. */
export const CHUNK_PDF_TIMEOUT_MS = 60_000;
export const PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";
/** Request header carrying the chunk's print token (read by src/app/print/[bookId]/page.tsx). */
export { PRINT_TOKEN_HEADER };

export interface RenderChunkOptions {
  /** Full print URL incl. token; must be on `origin`. */
  url: string;
  loader: PrintImageLoader;
  /** The app origin serving the print route (e.g. https://app.example.com). */
  origin: string;
  /** Vercel deployment-protection bypass secret; sent only to `origin`. */
  bypassSecret?: string | null;
  /** Navigation + ready budget in ms (page.pdf has its own CHUNK_PDF_TIMEOUT_MS). */
  timeoutMs: number;
  /** Print token, sent as PRINT_TOKEN_HEADER on same-origin navigations only. */
  printToken?: string | null;
  /** Deadline: on abort the tab is closed and the chunk fails with render_timeout. */
  signal?: AbortSignal;
}

interface PrintFlags {
  ready: boolean;
  error: boolean;
  timeout: boolean;
}

function normalizeOrigin(origin: string): string {
  try {
    const o = new URL(origin).origin;
    if (o === "null") throw new Error("opaque");
    return o;
  } catch {
    throw new PdfRenderError("navigation_failed");
  }
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Interception handler (exported for tests); never throws (a page closing mid-request rejects respond/continue). */
export function routePrintRequest(
  req: HTTPRequest,
  opts: { origin: string; loader: PrintImageLoader; bypassSecret: string | null; printToken?: string | null },
): void {
  if (req.isInterceptResolutionHandled()) return;
  const url = req.url();
  const swallow = () => undefined;
  switch (classifyRequest(url, opts.origin)) {
    case "asset": {
      const photoId = assetPhotoId(url);
      const notFound = () => req.respond({ status: 404, contentType: "text/plain", body: "" }).catch(swallow);
      if (!photoId || req.method() !== "GET") {
        void notFound();
        return;
      }
      opts.loader.get(photoId).then(
        (body) =>
          req
            .respond({
              status: 200,
              contentType: "image/jpeg",
              headers: { "cache-control": "no-store", "access-control-allow-origin": opts.origin },
              body,
            })
            .catch(swallow),
        () => notFound(),
      );
      return;
    }
    case "same_origin": {
      const extra: Record<string, string> = {};
      if (opts.bypassSecret) extra[PROTECTION_BYPASS_HEADER] = opts.bypassSecret;
      if (opts.printToken && isNavigation(req)) extra[PRINT_TOKEN_HEADER] = opts.printToken;
      const headers = Object.keys(extra).length > 0 ? { ...req.headers(), ...extra } : undefined;
      req.continue(headers ? { headers } : undefined).catch(swallow);
      return;
    }
    case "passthrough":
      req.continue().catch(swallow);
      return;
    default:
      req.abort("blockedbyclient").catch(swallow);
  }
}

function isNavigation(req: HTTPRequest): boolean {
  try {
    return typeof req.isNavigationRequest === "function" && req.isNavigationRequest();
  } catch {
    return false;
  }
}

function abortedError(): PdfRenderError {
  return new PdfRenderError("render_timeout");
}

async function readFlags(page: Page): Promise<PrintFlags> {
  return page.evaluate(() => {
    const w = window as unknown as { __PRINT_READY__?: unknown; __PRINT_ERROR__?: unknown; __PRINT_TIMEOUT__?: unknown };
    return {
      ready: w.__PRINT_READY__ === true,
      error: w.__PRINT_ERROR__ !== undefined && w.__PRINT_ERROR__ !== null && w.__PRINT_ERROR__ !== false,
      timeout: w.__PRINT_TIMEOUT__ === true,
    };
  });
}

/** Renders one print-route URL to a PDF buffer. Throws PdfRenderError. */
export async function renderChunk(browser: Browser, opts: RenderChunkOptions): Promise<Buffer> {
  const origin = normalizeOrigin(opts.origin);
  if (!sameOrigin(opts.url, origin)) throw new PdfRenderError("navigation_failed");
  const timeoutMs = Math.max(1_000, Math.floor(opts.timeoutMs));
  const deadline = Date.now() + timeoutMs;
  const signal = opts.signal;
  if (signal?.aborted) throw abortedError();

  let page: Page;
  try {
    page = await browser.newPage();
  } catch {
    throw signal?.aborted ? abortedError() : new PdfRenderError("chrome_unavailable");
  }
  // Abort → close the tab: whatever CDP call is pending rejects and we report render_timeout.
  const onAbort = () => void page.close().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw abortedError();
    return await renderOnPage(page, opts, origin, timeoutMs, deadline);
  } catch (e) {
    if (signal?.aborted) throw abortedError();
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await page.close().catch(() => undefined);
  }
}

async function renderOnPage(
  page: Page,
  opts: RenderChunkOptions,
  origin: string,
  timeoutMs: number,
  deadline: number,
): Promise<Buffer> {
  try {
    await page.setRequestInterception(true);
    page.on("request", (req) =>
      routePrintRequest(req, {
        origin,
        loader: opts.loader,
        bypassSecret: opts.bypassSecret || null,
        printToken: opts.printToken || null,
      }),
    );
    // Lay out under print media from the start, so what the page measures/decodes is what prints.
    await page.emulateMediaType("print");
  } catch {
    throw new PdfRenderError("chrome_unavailable");
  }

  let res;
  try {
    res = await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  } catch (e) {
    throw new PdfRenderError(isTimeout(e) ? "render_timeout" : "navigation_failed");
  }
  if (!res || !res.ok() || !sameOrigin(res.url(), origin)) throw new PdfRenderError("navigation_failed");

  try {
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __PRINT_READY__?: unknown; __PRINT_ERROR__?: unknown; __PRINT_TIMEOUT__?: unknown };
        return (
          w.__PRINT_READY__ === true ||
          (w.__PRINT_ERROR__ !== undefined && w.__PRINT_ERROR__ !== null && w.__PRINT_ERROR__ !== false) ||
          w.__PRINT_TIMEOUT__ === true
        );
      },
      { timeout: Math.max(1, deadline - Date.now()), polling: 100 },
    );
  } catch (e) {
    throw new PdfRenderError(isTimeout(e) ? "render_timeout" : "navigation_failed");
  }

  let flags: PrintFlags;
  try {
    flags = await readFlags(page);
  } catch {
    throw new PdfRenderError("navigation_failed");
  }
  if (flags.error) throw new PdfRenderError("image_failed");
  if (flags.timeout || !flags.ready) throw new PdfRenderError("render_timeout");

  try {
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      timeout: CHUNK_PDF_TIMEOUT_MS,
    });
    return Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  } catch {
    throw new PdfRenderError("print_failed");
  }
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && e.name === "TimeoutError";
}

export interface RenderBookOptions {
  /** App origin serving /print/[bookId] (for Preview: the deployment URL). */
  origin: string;
  bookId: string;
  exportId: string;
  /** books.doc_rev snapshotted by the export row. */
  docRev: number;
  /** Exactly cover + pages = doc.pages.length + 1 (canExport().sheetCount); the print route 404s past the last sheet. */
  sheetCount: number;
  loader: PrintImageLoader;
  /** Default: process.env.VERCEL_AUTOMATION_BYPASS_SECRET. */
  bypassSecret?: string | null;
  /** Per-chunk navigation + ready budget. Default CHUNK_READY_TIMEOUT_MS. */
  chunkTimeoutMs?: number;
  /** Sheets per chunk. Default CHUNK_SHEETS (tests use smaller chunks). Ignored when `ranges` is given. */
  chunkSheets?: number;
  /**
   * Chunk plan (M10b B1: print-doc.ts printChunkRanges — sheet AND image caps, spread pairs kept
   * together). Must cover sheets 0..sheetCount-1 contiguously (isValidChunkPlan), else
   * navigation_failed. Default: chunkRanges(sheetCount, chunkSheets).
   */
  ranges?: readonly SheetRange[];
  /** Reuse a caller's browser (not closed here; on abort only its tabs close). Default: launch one and close it in finally. */
  browser?: Browser;
  /** Test hooks: browser launch / close (default launchBrowser / closeBrowser). */
  launch?: () => Promise<Browser>;
  close?: (browser: Browser) => Promise<void>;
  /** Clock for token expiry (epoch ms). */
  now?: () => number;
  /** Called after chunk k (index into the chunk plan) has rendered — prefetch release hook. */
  onChunkDone?: (k: number) => void;
  /** Filled with phase timings (ms) when given. */
  timings?: RenderTimings;
  /** Chunks rendered at once (tabs). Default RENDER_PARALLEL_CHUNKS. */
  parallelChunks?: number;
  /**
   * Deadline (S2): checked before every chunk; on abort the current tabs close and an owned
   * browser is closed (killed if close hangs). Rejects with render_timeout.
   */
  signal?: AbortSignal;
}

export interface RenderTimings {
  /** Browser launch (0 when the caller passed a browser). */
  launchMs: number;
  /** Per finished chunk, navigation → PDF bytes (filled as chunks finish). */
  chunkMs: number[];
}

/**
 * One chunk at a time. Measured on a 40-page book (3 chunks, images prefetched, local 8-core):
 * two tabs at once gave 8.7 / 9.4 s server time vs 9.8 / 8.9 s sequential — no gain — with the
 * highest Chromium RSS peak of all variants (1.1–1.2 GB vs ~1.0 GB). On a 1–2 vCPU function
 * the CPU-bound print/raster work would serialise anyway.
 */
export const RENDER_PARALLEL_CHUNKS = 1;

/**
 * Renders the whole book as PDF chunks (in sheet order) — merge them with finalize.mergePdfs.
 * Each chunk gets a freshly signed print token. Throws PdfRenderError (token_unavailable when
 * BOOK_ACCESS_SECRET is missing).
 */
export async function renderBook(opts: RenderBookOptions): Promise<Buffer[]> {
  const origin = normalizeOrigin(opts.origin);
  const ranges = opts.ranges ?? chunkRanges(opts.sheetCount, opts.chunkSheets ?? CHUNK_SHEETS);
  if (ranges.length === 0 || !isValidChunkPlan(ranges, opts.sheetCount)) throw new PdfRenderError("navigation_failed");
  const now = opts.now ?? Date.now;
  const bypassSecret =
    opts.bypassSecret !== undefined ? opts.bypassSecret : process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || null;

  const signal = opts.signal;
  if (signal?.aborted) throw abortedError();
  const printUrl = `${origin}/print/${encodeURIComponent(opts.bookId)}`;
  const signChunk = (from: number, to: number): string => {
    let token: string | null;
    try {
      token = signPrintToken({
        exportId: opts.exportId,
        bookId: opts.bookId,
        docRev: opts.docRev,
        from,
        to,
        exp: printTokenExpiry(now() / 1000),
      });
    } catch {
      token = null; // invalid grant (bad ids / range) — a caller bug, reported as a typed code
    }
    if (!token) throw new PdfRenderError("token_unavailable");
    return token;
  };
  const timings = opts.timings;
  const parallel = Math.max(1, Math.min(ranges.length, Math.floor(opts.parallelChunks ?? RENDER_PARALLEL_CHUNKS) || 1));

  const run = async (browser: Browser) => {
    const chunks: Buffer[] = new Array(ranges.length);
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < ranges.length) {
        if (signal?.aborted) {
          failed = true;
          throw abortedError();
        }
        const k = next++;
        const { from, to } = ranges[k];
        const t0 = Date.now();
        try {
          chunks[k] = await renderChunk(browser, {
            url: printUrl,
            printToken: signChunk(from, to),
            origin,
            loader: opts.loader,
            bypassSecret,
            timeoutMs: opts.chunkTimeoutMs ?? CHUNK_READY_TIMEOUT_MS,
            signal,
          });
        } catch (e) {
          failed = true;
          throw e;
        }
        if (timings) timings.chunkMs[k] = Date.now() - t0;
        opts.onChunkDone?.(k);
      }
    };
    const workers = Array.from({ length: parallel }, worker);
    // allSettled first so no tab is still rendering when the browser closes; then surface the first error.
    const settled = await Promise.allSettled(workers);
    if (signal?.aborted) throw abortedError();
    const bad = settled.find((r) => r.status === "rejected");
    if (bad) throw (bad as PromiseRejectedResult).reason;
    return chunks;
  };

  if (timings) {
    // Filled in place (the caller may read them after a failure, too).
    timings.launchMs = 0;
    timings.chunkMs.length = 0;
  }
  if (opts.browser) return run(opts.browser);
  const t0 = Date.now();
  const browser = await (opts.launch ?? launchBrowser)();
  if (timings) timings.launchMs = Date.now() - t0;
  // Abort → close the whole browser now (kills the process if close hangs); `run` then rejects.
  let closing: Promise<void> | null = null;
  const close = () => (closing ??= (opts.close ?? closeBrowser)(browser));
  const onAbort = () => void close();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw abortedError();
    return await run(browser);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await close();
  }
}
