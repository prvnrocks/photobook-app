import "server-only";
// Print route → PDF chunks with headless Chromium (D-049, D-052).
//
// One page per chunk (≤ CHUNK_SHEETS sheets), rendered sequentially to bound memory. Network:
// classifyRequest() decides every request — print images are answered in-process from the
// PrintImageLoader (404 on failure so the print page flags __PRINT_ERROR__), the app's own origin
// is continued (plus the Vercel protection-bypass header when configured, for Preview
// deployments), data:/blob: pass, everything else is aborted.
//
// The print page (T5) sets window.__PRINT_READY__ = true once fonts and images are decoded, or
// __PRINT_ERROR__ ('image') / __PRINT_TIMEOUT__ = true. Errors are PdfRenderError codes only:
// URLs (they carry print tokens) and photo ids are never put into messages.

import type { Browser, HTTPRequest, Page } from "puppeteer-core";
import { withBrowser } from "./browser";
import { PdfRenderError } from "./errors";
import type { PrintImageLoader } from "./images";
import { printTokenExpiry, signPrintToken } from "./print-token";
import { assetPhotoId, classifyRequest } from "./request-routing";
import { CHUNK_SHEETS, chunkRanges } from "./rules";

/** Budget for one chunk from navigation until the page reports ready. */
export const CHUNK_READY_TIMEOUT_MS = 60_000;
/** Budget for page.pdf() of one chunk. */
export const CHUNK_PDF_TIMEOUT_MS = 60_000;
export const PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";

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
export function routePrintRequest(req: HTTPRequest, opts: { origin: string; loader: PrintImageLoader; bypassSecret: string | null }): void {
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
      const headers = opts.bypassSecret
        ? { ...req.headers(), [PROTECTION_BYPASS_HEADER]: opts.bypassSecret }
        : undefined;
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

  let page: Page;
  try {
    page = await browser.newPage();
  } catch {
    throw new PdfRenderError("chrome_unavailable");
  }
  try {
    try {
      await page.setRequestInterception(true);
      page.on("request", (req) => routePrintRequest(req, { origin, loader: opts.loader, bypassSecret: opts.bypassSecret || null }));
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
  } finally {
    await page.close().catch(() => undefined);
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
  /** Sheets per chunk. Default CHUNK_SHEETS (tests use smaller chunks). */
  chunkSheets?: number;
  /** Reuse a caller's browser (not closed here). Default: launch one and close it in finally. */
  browser?: Browser;
  /** Clock for token expiry (epoch ms). */
  now?: () => number;
}

/**
 * Renders the whole book as PDF chunks (in sheet order) — merge them with finalize.mergePdfs.
 * Each chunk gets a freshly signed print token. Throws PdfRenderError (token_unavailable when
 * BOOK_ACCESS_SECRET is missing).
 */
export async function renderBook(opts: RenderBookOptions): Promise<Buffer[]> {
  const origin = normalizeOrigin(opts.origin);
  const ranges = chunkRanges(opts.sheetCount, opts.chunkSheets ?? CHUNK_SHEETS);
  if (ranges.length === 0) throw new PdfRenderError("navigation_failed");
  const now = opts.now ?? Date.now;
  const bypassSecret =
    opts.bypassSecret !== undefined ? opts.bypassSecret : process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || null;

  const run = async (browser: Browser) => {
    const chunks: Buffer[] = [];
    for (const { from, to } of ranges) {
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
      const url = `${origin}/print/${encodeURIComponent(opts.bookId)}?token=${encodeURIComponent(token)}`;
      chunks.push(
        await renderChunk(browser, {
          url,
          origin,
          loader: opts.loader,
          bypassSecret,
          timeoutMs: opts.chunkTimeoutMs ?? CHUNK_READY_TIMEOUT_MS,
        }),
      );
    }
    return chunks;
  };

  return opts.browser ? run(opts.browser) : withBrowser(run);
}
