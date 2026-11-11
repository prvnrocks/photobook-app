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
//
// Image dedupe (M10b A14): Chromium embeds an image once per chunk PDF, but every chunk is copied
// separately, so an image shown in two chunks (a spread whose halves straddle a chunk boundary —
// sheets 20/21 —, a paper texture, a background photo) would be stored once PER CHUNK. After the
// copy, byte-identical image XObjects (same dict incl. SMask/colour space, same stream bytes) are
// folded into one object and every reference is re-pointed — lossless, nothing is re-encoded.
// Equality is confirmed on the real bytes of the image AND of every stream it references (SMask,
// ICC); the duplicates' now-unreferenced SMask / ICC objects are deleted as well (M10b A19 N1).

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
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
    dedupeImages(out.context);

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

// --- Image dedupe ---------------------------------------------------------------------------------

/** cyrb53 (53-bit) over bytes — a bucketing hash; equal buckets are confirmed byte-for-byte. */
function hash53(bytes: Uint8Array): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const SUBTYPE = PDFName.of("Subtype");
const IMAGE = PDFName.of("Image");

function isImageStream(o: PDFObject | undefined): o is PDFRawStream {
  return o instanceof PDFRawStream && o.dict.get(SUBTYPE) === IMAGE;
}

/**
 * Structural equality of two PDF objects, following references: dicts by keys + values, arrays
 * item by item, raw streams by dict AND byte-for-byte contents (so an image's SMask / ICC /
 * any referenced sub-stream is compared by its real bytes, never by hash alone — M10b A19 N1).
 * `pairs` guards cycles (a pair under comparison counts as equal).
 */
function deepSame(context: PDFContext, a: PDFObject | undefined, b: PDFObject | undefined, depth: number, pairs: Set<string>): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (depth > 16) return false;
  if (a instanceof PDFRef || b instanceof PDFRef) {
    if (!(a instanceof PDFRef && b instanceof PDFRef)) return false;
    const pair = `${a.toString()}|${b.toString()}`;
    if (pairs.has(pair)) return true;
    pairs.add(pair);
    return deepSame(context, context.lookup(a), context.lookup(b), depth + 1, pairs);
  }
  if (a instanceof PDFRawStream || b instanceof PDFRawStream) {
    if (!(a instanceof PDFRawStream && b instanceof PDFRawStream)) return false;
    return sameBytes(a.contents, b.contents) && deepSame(context, a.dict, b.dict, depth + 1, pairs);
  }
  if (a instanceof PDFStream || b instanceof PDFStream) return false; // generated streams: never folded
  if (a instanceof PDFDict || b instanceof PDFDict) {
    if (!(a instanceof PDFDict && b instanceof PDFDict)) return false;
    const ea = a.entries();
    if (ea.length !== b.entries().length) return false;
    return ea.every(([k, v]) => deepSame(context, v, b.get(k), depth + 1, pairs));
  }
  if (a instanceof PDFArray || b instanceof PDFArray) {
    if (!(a instanceof PDFArray && b instanceof PDFArray)) return false;
    if (a.size() !== b.size()) return false;
    return a.asArray().every((v, i) => deepSame(context, v, b.get(i), depth + 1, pairs));
  }
  return a.toString() === b.toString();
}

/** Every indirect ref reachable from `o` (following refs, dicts, arrays and stream dicts). */
function collectRefs(context: PDFContext, o: PDFObject | undefined, out: Set<string>, depth = 0): void {
  if (o === undefined || depth > 64) return;
  if (o instanceof PDFRef) {
    const k = o.toString();
    if (out.has(k)) return;
    out.add(k);
    collectRefs(context, context.lookup(o), out, depth + 1);
  } else if (o instanceof PDFDict) {
    for (const [, v] of o.entries()) collectRefs(context, v, out, depth + 1);
  } else if (o instanceof PDFArray) {
    for (const v of o.asArray()) collectRefs(context, v, out, depth + 1);
  } else if (o instanceof PDFStream) {
    collectRefs(context, o.dict, out, depth + 1);
  }
}

const refOf = (key: string): PDFRef => {
  const [num, gen] = key.split(" ");
  return PDFRef.of(Number(num), Number(gen));
};

/**
 * Folds byte-identical image XObjects into one object (see header). Keys are canonical: dict
 * entries sorted, references replaced by the referenced object's own key (SMask / ICC streams by
 * dict + length + hash), so two copies of the same image from different chunks — whose SMask refs
 * differ — get equal keys. The key only buckets: candidates with equal keys are confirmed by
 * deepSame (image bytes AND every referenced sub-stream's bytes). After re-pointing, objects that
 * only the removed duplicates referenced (their SMask / ICC streams) and that are no longer
 * reachable from the document are deleted too (M10b A19 N1). Exported for tests. Returns the
 * number of objects removed (duplicates + orphans).
 */
export function dedupeImages(context: PDFContext): number {
  const memo = new Map<string, string>();
  let unique = 0;
  const keyOf = (o: PDFObject | undefined, depth: number): string => {
    if (o === undefined) return "u";
    if (depth > 8) return `x${unique++}`; // never equal → never folded
    if (o instanceof PDFRef) {
      const k = o.toString();
      const hit = memo.get(k);
      if (hit !== undefined) return hit;
      memo.set(k, `x${unique++}`); // cycle guard while computing
      const v = keyOf(context.lookup(o), depth + 1);
      memo.set(k, v);
      return v;
    }
    if (o instanceof PDFRawStream) return `S(${keyOf(o.dict, depth + 1)}|${o.contents.length}|${hash53(o.contents)})`;
    if (o instanceof PDFStream) return `x${unique++}`; // decoded/generated streams: leave alone
    if (o instanceof PDFDict) {
      const entries = o
        .entries()
        .map(([k, v]) => `${k.toString()} ${keyOf(v, depth + 1)}`)
        .sort();
      return `<<${entries.join(" ")}>>`;
    }
    if (o instanceof PDFArray) return `[${o.asArray().map((v) => keyOf(v, depth + 1)).join(" ")}]`;
    return o.toString();
  };

  const canonical = new Map<string, { ref: PDFRef; stream: PDFRawStream }[]>();
  const remap = new Map<string, PDFRef>();
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!isImageStream(obj)) continue;
    const key = keyOf(ref, 0);
    const bucket = canonical.get(key) ?? [];
    const same = bucket.find((c) => deepSame(context, c.ref, ref, 0, new Set()));
    if (same) remap.set(ref.toString(), same.ref);
    else {
      bucket.push({ ref, stream: obj });
      canonical.set(key, bucket);
    }
  }
  if (remap.size === 0) return 0;

  const fix = (o: PDFObject, depth: number): void => {
    if (depth > 32) return;
    if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) {
        if (v instanceof PDFRef) {
          const to = remap.get(v.toString());
          if (to) o.set(k, to);
        } else fix(v, depth + 1);
      }
    } else if (o instanceof PDFArray) {
      const items = o.asArray();
      for (let i = 0; i < items.length; i++) {
        const v = items[i];
        if (v instanceof PDFRef) {
          const to = remap.get(v.toString());
          if (to) o.set(i, to);
        } else fix(v, depth + 1);
      }
    } else if (o instanceof PDFStream) {
      fix(o.dict, depth + 1);
    }
  };
  // Objects the duplicates reference (SMask, ICC, …): orphan candidates once they are gone.
  const candidates = new Set<string>();
  for (const key of remap.keys()) collectRefs(context, context.lookup(refOf(key)), candidates);
  for (const key of remap.keys()) candidates.delete(key);

  for (const [, obj] of context.enumerateIndirectObjects()) fix(obj, 0);
  for (const key of remap.keys()) context.delete(refOf(key));

  let orphans = 0;
  if (candidates.size > 0) {
    const reachable = new Set<string>();
    const t = context.trailerInfo;
    for (const root of [t.Root, t.Info, t.Encrypt, t.ID]) collectRefs(context, root as PDFObject | undefined, reachable);
    for (const key of candidates) {
      if (reachable.has(key) || remap.has(key)) continue;
      context.delete(refOf(key));
      orphans++;
    }
  }
  return remap.size + orphans;
}
