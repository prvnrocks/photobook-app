import "server-only";
// Print package (Task 10, requirement 4): the front cover and the interior pages of a finished export
// as two separate PDFs — the shape print-on-demand partners usually ask for (cover file + interior
// file). Made on request from the stored digital PDF, so all three files come from ONE render: same
// typography, photos, layout and chapter order as the combined PDF, the editor and the viewer.
//
// Each page keeps its MediaBox / BleedBox / TrimBox (copyPages copies the page dictionaries), fonts
// and images are copied as they are (no re-encoding). What this is NOT: a provider cover wrap (back
// + spine + front) — no partner spec exists yet (src/lib/print/specs), so the cover file is the
// front cover sheet at A5 trim + 3 mm bleed, exactly as in the combined PDF.
//
// Gate: the caller must own the book (getMyBook under RLS) and the book must be paid (canExportPdf
// = is_paid; a grant never unlocks it). Only a READY export of the book's CURRENT doc_rev is used.
// Logs: codes only.

import { PDFDocument } from "pdf-lib";
import { APP_NAME } from "@/lib/brand";
import { getMyBook } from "@/lib/db/books";
import {
  downloadExportPdf,
  exportObjectPath,
  exportPackagePath,
  latestReadyExport,
  signExportUrl,
  uploadExportPdf,
  type PrintPackagePart,
} from "@/lib/db/exports";
import { resolveEntitlement } from "@/lib/entitlements/resolve";
import { GENERIC_A5_DIGITAL } from "@/lib/print/specs";
import { clipCodePoints } from "@/lib/text/clip";
import { isUuid } from "@/lib/uuid";
import { PDF_TITLE_MAX_CHARS } from "./finalize";
import { pdfFilename, SIGNED_URL_TTL_SECONDS } from "./rules";
import { captionLangOf } from "./status";

export type SplitPackage = { cover: Uint8Array; interior: Uint8Array; interiorPages: number };

export class PrintPackageError extends Error {
  constructor(readonly code: "invalid_pdf" | "too_few_pages") {
    super(`print package failed (${code})`);
    this.name = "PrintPackageError";
  }
}

/** Splits a merged book PDF (sheet 1 = cover, sheets 2..n = pages) into a cover PDF and an interior PDF. */
export async function splitPrintPackage(pdf: Uint8Array, opts: { title?: string | null; now?: Date } = {}): Promise<SplitPackage> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(pdf, { updateMetadata: false });
  } catch {
    throw new PrintPackageError("invalid_pdf");
  }
  const count = src.getPageCount();
  if (count < 2) throw new PrintPackageError("too_few_pages");
  const now = opts.now ?? new Date();
  const title = typeof opts.title === "string" ? clipCodePoints(opts.title.trim(), PDF_TITLE_MAX_CHARS - 12) : "";
  const make = async (indices: number[], suffix: string) => {
    const out = await PDFDocument.create({ updateMetadata: false });
    for (const p of await out.copyPages(src, indices)) out.addPage(p);
    out.setTitle(`${title || APP_NAME} — ${suffix}`, { showInWindowTitleBar: true });
    out.setProducer(APP_NAME);
    out.setCreator(APP_NAME);
    out.setCreationDate(now);
    out.setModificationDate(now);
    return out.save({ useObjectStreams: true });
  };
  const cover = await make([0], "cover");
  const interior = await make(
    Array.from({ length: count - 1 }, (_, i) => i + 1),
    "interior",
  );
  return { cover, interior, interiorPages: count - 1 };
}

export type PrintPackageFile = { url: string; filename: string; pages: number };
export type PrintPackageResult =
  | {
      ok: true;
      body: {
        cover: PrintPackageFile;
        interior: PrintPackageFile;
        /** The spec the files follow (digital A5 + 3 mm bleed) — not a print partner's spec. */
        spec: string;
        expiresInSeconds: number;
      };
    }
  | { ok: false; error: "not_found" | "not_paid" | "pdf_first" | "unavailable" };

function partFilename(title: string | null | undefined, part: PrintPackagePart): string {
  return pdfFilename(title).replace(/\.pdf$/, `-${part}.pdf`);
}

/**
 * Signed URLs (10 min) for the cover + interior PDFs of the book's ready export of its current
 * doc_rev; makes (and stores) them the first time. `pdf_first` = no ready PDF of the saved book yet.
 */
export async function requestPrintPackage(bookId: string, userId: string): Promise<PrintPackageResult> {
  if (!isUuid(bookId) || !isUuid(userId)) return { ok: false, error: "not_found" };
  const book = await getMyBook(bookId);
  if (!book) return { ok: false, error: "not_found" };
  const ent = resolveEntitlement({ bookId, isPaid: book.is_paid === true, maxPages: book.max_pages, orderStatus: null, hasActiveGrant: false });
  if (!ent.canExportPdf) return { ok: false, error: "not_paid" };
  if (book.doc_rev === null) return { ok: false, error: "unavailable" };
  const exp = await latestReadyExport(bookId, book.doc_rev, captionLangOf(book.caption_lang));
  if (!exp || !exp.pageCount || exp.pageCount < 2) return { ok: false, error: "pdf_first" };

  const paths = {
    cover: exportPackagePath(userId, bookId, exp.id, "cover"),
    interior: exportPackagePath(userId, bookId, exp.id, "interior"),
  };
  const names = { cover: partFilename(book.title, "cover"), interior: partFilename(book.title, "interior") };
  const sign = async () => {
    const [cover, interior] = await Promise.all([
      signExportUrl(paths.cover, SIGNED_URL_TTL_SECONDS, names.cover),
      signExportUrl(paths.interior, SIGNED_URL_TTL_SECONDS, names.interior),
    ]);
    return cover && interior ? { cover, interior } : null;
  };

  let urls = await sign();
  if (!urls) {
    const pdf = await downloadExportPdf(exportObjectPath(userId, bookId, exp.id));
    if (!pdf) return { ok: false, error: "pdf_first" };
    const split = await splitPrintPackage(pdf, { title: book.title });
    await uploadExportPdf(paths.cover, split.cover);
    await uploadExportPdf(paths.interior, split.interior);
    urls = await sign();
    if (!urls) return { ok: false, error: "unavailable" };
    console.info(`[pdf-package] made pages=${split.interiorPages}`);
  }
  return {
    ok: true,
    body: {
      cover: { url: urls.cover, filename: names.cover, pages: 1 },
      interior: { url: urls.interior, filename: names.interior, pages: exp.pageCount - 1 },
      spec: GENERIC_A5_DIGITAL.id,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    },
  };
}
