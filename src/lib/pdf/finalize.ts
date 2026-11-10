// Merge Chromium chunks into the final PDF (D-050, D-052). No I/O, no env — Node or edge-safe.
//
// copyPages copies the page objects (content streams, image XObjects, fonts) as they are: no
// re-encoding, no rasterising. Every page then gets print boxes (see printBoxes): MediaBox =
// BleedBox = CropBox = the exact 154×216 mm sheet, TrimBox = the 148×210 mm page inset by 3 mm.
//
// Chromium quantises the CSS page size: a 154×216 mm @page comes out as 437.04 × 612 pt (exact:
// 436.535 × 612.283; measured with Chrome 153/156). Content is laid out from the page's TOP-LEFT
// and PDF y runs bottom-up, so all boxes are anchored at the real box's top-left corner and given
// the exact nominal size. Effect: a ≤ 0.6 pt sliver on the right is cut off and ≤ 0.3 pt of blank
// is added at the bottom — both inside the 3 mm (8.5 pt) bleed, so trim and safe area are exact.
// Metadata: title,
// producer/creator = APP_NAME and dates only — no author/subject/keywords (no PII), and nothing
// from the chunks' own Info dictionaries (Chromium's <title>, "Skia/PDF") carries over.

import { PDFDocument } from "pdf-lib";
import { APP_NAME } from "@/lib/brand";
import { BLEED_MM, PAGE_MM, SHEET_MM } from "@/lib/layouts";
import { clipCodePoints } from "@/lib/text/clip";
import { PdfRenderError } from "./errors";

const PT_PER_MM = 72 / 25.4;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Sheet incl. bleed, in PDF points: 154 × 216 mm → 436.535 × 612.283 pt. */
export const SHEET_PT = { w: round3(SHEET_MM.w * PT_PER_MM), h: round3(SHEET_MM.h * PT_PER_MM) } as const;
/** Bleed (TrimBox inset), in PDF points: 3 mm → 8.504 pt. */
export const BLEED_PT = round3(BLEED_MM * PT_PER_MM);
/** Trimmed page, in PDF points: 148 × 210 mm → 419.528 × 595.276 pt. */
export const TRIM_PT = { w: round3(PAGE_MM.w * PT_PER_MM), h: round3(PAGE_MM.h * PT_PER_MM) } as const;
/** A chunk page whose size differs from SHEET_PT by more than this is a layout bug (e.g. no @page). */
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
 * Print boxes for a chunk page whose real MediaBox is `real`: exact nominal sizes anchored at the
 * real box's top-left (where Chromium starts laying out). Null when `real` is further than
 * SHEET_TOLERANCE_PT from 154×216 mm (e.g. Letter/A4 because @page is missing).
 */
export function printBoxes(real: Box): PrintBoxes | null {
  const ok = [real.x, real.y, real.width, real.height].every(Number.isFinite);
  if (!ok || Math.abs(real.width - SHEET_PT.w) > SHEET_TOLERANCE_PT || Math.abs(real.height - SHEET_PT.h) > SHEET_TOLERANCE_PT) {
    return null;
  }
  const left = round3(real.x);
  const bottom = round3(real.y + real.height - SHEET_PT.h);
  return {
    sheet: { x: left, y: bottom, width: SHEET_PT.w, height: SHEET_PT.h },
    trim: { x: round3(left + BLEED_PT), y: round3(bottom + BLEED_PT), width: TRIM_PT.w, height: TRIM_PT.h },
  };
}

export interface MergeOptions {
  /** Book title; empty / missing → APP_NAME. */
  title?: string | null;
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
        const boxes = printBoxes(page.getMediaBox());
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
