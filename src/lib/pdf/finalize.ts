// Merge Chromium chunks into the final PDF (D-050, D-052). No I/O, no env — Node or edge-safe.
//
// copyPages copies the page objects (content streams, image XObjects, fonts) as they are: no
// re-encoding, no rasterising. Every page then gets print boxes (see printBoxes): MediaBox =
// BleedBox = CropBox = the exact sheet of the book's format (portrait 154×216 mm, landscape
// 216×154 mm), TrimBox = the trim page (148×210 / 210×148 mm) inset by 3 mm.
//
// Chromium quantises the CSS page size: a 154×216 mm @page comes out as 437.04 × 612 pt (exact:
// 436.535 × 612.283; measured with Chrome 153/156). Content is laid out from the page's TOP-LEFT
// and PDF y runs bottom-up, so all boxes are anchored at the real box's top-left corner and given
// the exact nominal size. Effect: a ≤ 0.6 pt sliver on the right is cut off and ≤ 0.3 pt of blank
// is added at the bottom — both inside the 3 mm (8.5 pt) bleed, so trim and safe area are exact.
// Landscape is the same page turned (expected ≈ 612 × 437.04 pt); a page of the other
// orientation is rejected — it means the @page size and the doc format disagree.
// Metadata: title,
// producer/creator = APP_NAME and dates only — no author/subject/keywords (no PII), and nothing
// from the chunks' own Info dictionaries (Chromium's <title>, "Skia/PDF") carries over.

import { PDFDocument } from "pdf-lib";
import { APP_NAME } from "@/lib/brand";
import { orientationOf, sheetPt, trimPt } from "@/lib/book/format";
import type { BookFormat } from "@/lib/book/types";
import { BLEED_MM } from "@/lib/layouts";
import { clipCodePoints } from "@/lib/text/clip";
import { PdfRenderError } from "./errors";

const PT_PER_MM = 72 / 25.4;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** PORTRAIT sheet incl. bleed, in PDF points: 154 × 216 mm → 436.535 × 612.283 pt. Per format: sheetPt(format). */
export const SHEET_PT = sheetPt("A5_PORTRAIT");
/** Bleed (TrimBox inset), in PDF points: 3 mm → 8.504 pt. */
export const BLEED_PT = round3(BLEED_MM * PT_PER_MM);
/** PORTRAIT trimmed page, in PDF points: 148 × 210 mm → 419.528 × 595.276 pt. Per format: trimPt(format). */
export const TRIM_PT = trimPt("A5_PORTRAIT");
/** A chunk page whose size differs from the format's sheet by more than this is a layout bug (e.g. no @page). */
export const SHEET_TOLERANCE_PT = 2;
export const PDF_TITLE_MAX_CHARS = 200;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PrintBoxes {
  /** MediaBox = BleedBox = CropBox. */
  sheet: Box;
  trim: Box;
}

/**
 * Print boxes for a chunk page whose real MediaBox is `real`, for a book of `format` (default
 * portrait): exact nominal sizes anchored at the real box's top-left (where Chromium starts
 * laying out). Null when `real` is further than SHEET_TOLERANCE_PT from the format's sheet (e.g.
 * Letter/A4 because @page is missing) or has the other orientation (@page vs doc format mismatch).
 */
export function printBoxes(real: Box, format?: BookFormat | null): PrintBoxes | null {
  const ok = [real.x, real.y, real.width, real.height].every(Number.isFinite);
  if (!ok) return null;
  const sheet = sheetPt(format);
  const trim = trimPt(format);
  const realOrientation = real.width > real.height ? "landscape" : "portrait";
  if (realOrientation !== orientationOf(format)) return null;
  if (Math.abs(real.width - sheet.w) > SHEET_TOLERANCE_PT || Math.abs(real.height - sheet.h) > SHEET_TOLERANCE_PT) {
    return null;
  }
  const left = round3(real.x);
  const bottom = round3(real.y + real.height - sheet.h);
  return {
    sheet: { x: left, y: bottom, width: sheet.w, height: sheet.h },
    trim: { x: round3(left + BLEED_PT), y: round3(bottom + BLEED_PT), width: trim.w, height: trim.h },
  };
}

export interface MergeOptions {
  /** Book title; empty / missing → APP_NAME. */
  title?: string | null;
  /** doc.format — every page must match its sheet (default portrait). */
  format?: BookFormat | null;
  now?: Date;
}

export interface MergedPdf {
  bytes: Uint8Array;
  pageCount: number;
}

/** Merges chunk PDFs in order and applies print boxes + metadata. Throws PdfRenderError('merge_failed'). */
export async function mergePdfs(chunks: readonly Uint8Array[], opts: MergeOptions = {}): Promise<MergedPdf> {
  if (chunks.length === 0) throw new PdfRenderError("merge_failed");
  const now = opts.now ?? new Date();
  try {
    const out = await PDFDocument.create({ updateMetadata: false });
    for (const chunk of chunks) {
      const src = await PDFDocument.load(chunk, { updateMetadata: false });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const page of pages) {
        if (page.getRotation().angle % 360 !== 0) throw new PdfRenderError("merge_failed");
        const boxes = printBoxes(page.getMediaBox(), opts.format);
        if (!boxes) throw new PdfRenderError("merge_failed");
        const { sheet, trim } = boxes;
        page.setMediaBox(sheet.x, sheet.y, sheet.width, sheet.height);
        page.setCropBox(sheet.x, sheet.y, sheet.width, sheet.height);
        page.setBleedBox(sheet.x, sheet.y, sheet.width, sheet.height);
        page.setTrimBox(trim.x, trim.y, trim.width, trim.height);
        out.addPage(page);
      }
    }
    const pageCount = out.getPageCount();
    if (pageCount === 0) throw new PdfRenderError("merge_failed");

    const title = typeof opts.title === "string" ? clipCodePoints(opts.title.trim(), PDF_TITLE_MAX_CHARS) : "";
    out.setTitle(title || APP_NAME, { showInWindowTitleBar: true });
    out.setProducer(APP_NAME);
    out.setCreator(APP_NAME);
    out.setCreationDate(now);
    out.setModificationDate(now);

    const bytes = await out.save({ useObjectStreams: true });
    return { bytes, pageCount };
  } catch (e) {
    if (e instanceof PdfRenderError) throw e;
    throw new PdfRenderError("merge_failed");
  }
}
