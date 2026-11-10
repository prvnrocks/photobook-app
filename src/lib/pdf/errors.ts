// Typed PDF render errors (D-052). Pure: safe to import anywhere. Messages carry the code only —
// never URLs (they hold print tokens), photo ids or Chromium stack traces.

export type PdfRenderErrorCode =
  /** No Chromium: PDF_CHROME_PATH unset locally, or the serverless binary failed to start. */
  | "chrome_unavailable"
  /** The print route did not load (network error, non-2xx, redirect off-origin). */
  | "navigation_failed"
  /** The page never reported ready (or reported __PRINT_TIMEOUT__) within the time budget. */
  | "render_timeout"
  /** The page reported __PRINT_ERROR__ — a print image failed to load or decode. */
  | "image_failed"
  /** page.pdf() failed. */
  | "print_failed"
  /** pdf-lib could not load/merge a chunk, or a chunk has the wrong page size. */
  | "merge_failed"
  /** No print token: BOOK_ACCESS_SECRET missing/short, or an invalid grant (caller bug). */
  | "token_unavailable";

export class PdfRenderError extends Error {
  readonly code: PdfRenderErrorCode;

  constructor(code: PdfRenderErrorCode) {
    super(`PDF render failed (${code})`);
    this.name = "PdfRenderError";
    this.code = code;
  }
}

export function isPdfRenderError(e: unknown): e is PdfRenderError {
  return e instanceof PdfRenderError;
}
