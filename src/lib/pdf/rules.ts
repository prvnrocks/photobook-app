// PDF export rules (D-047, D-050, D-051, D-052). Pure + isomorphic: no secrets, no node: imports.
//
// Sheets: a PDF is cover + pages. Sheet indexes are 0-based, sheet 0 = cover, sheet i (i ≥ 1)
// = doc.pages[i - 1]. A book with N pages has N + 1 sheets. Chunks are inclusive sheet ranges
// { from, to } of at most CHUNK_SHEETS sheets, rendered separately and merged with pdf-lib.

import { LIMITS } from "@/lib/ai/limits";
import { parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";

/** D-051: export jobs a user may start per rolling 24 h (all books). */
export const EXPORT_DAILY_CAP = 20;
/** D-051: a queued/running export whose lease is older than this is considered dead. */
export const EXPORT_STALE_SECONDS = 360;
/** D-051: lifetime of the signed download URL for a finished PDF. */
export const SIGNED_URL_TTL_SECONDS = 600;
/** D-048: lifetime of a print-route token (verify rejects anything > 10 min out). */
export const PRINT_TOKEN_TTL_SECONDS = 300;
/**
 * N1 (M8 review): version of the PDF renderer output. Bump whenever a change makes earlier PDFs
 * look different (fonts, encoder, layout maths): create_export_job reuses a ready PDF only when
 * its renderer_version matches. 1 = pre-review rows (migration 1500 default); 2 = static print
 * fonts (no Type3) + baseline JPEG encoder.
 */
export const PDF_RENDERER_VERSION = 2;
/** Size fallback (M8 T12): when the merged PDF exceeds the 50 MB bucket limit, re-render once
 * with every print image planned at this dpi and encoded at this JPEG quality. */
export const SIZE_FALLBACK_DPI = 250;
export const SIZE_FALLBACK_JPEG_QUALITY = 70;
/**
 * Function budget of /api/books/[id]/pdf in seconds — the ONE constant the render deadline and
 * lease derive from. Must equal `maxDuration` in that route file and in vercel.json (tests assert
 * it; Next needs the route's value as a literal).
 *
 * Plan: Vercel HOBBY with Fluid compute (vercel.json "fluid": true). Vercel docs, "Configuring
 * Maximum Duration for Vercel Functions" (as of 2026): with Fluid compute Hobby defaults to and
 * caps at 300 s (Pro: default 300 s, max 800 s); without Fluid, Hobby caps at 60 s. Hobby memory is
 * fixed at 2 GB / 1 vCPU and cannot be configured.
 * If Fluid compute is ever off on Hobby: set 60 here, in the route and in vercel.json (deadline
 * then 30 s — only small books fit).
 * Pro later: keep 300 (or up to 800), and set Function CPU "Performance" (4 GB / 2 vCPU) in the
 * dashboard (with Fluid, memory is a project setting, not vercel.json).
 */
export const PDF_MAX_DURATION_SECONDS = 300;
/** Render deadline inside one invocation: maxDuration minus 30 s for the response, fail record and browser close. */
export const PDF_DEADLINE_MS = (PDF_MAX_DURATION_SECONDS - 30) * 1000;
/** D-052: sheets per Chromium render chunk. */
export const CHUNK_SHEETS = 20;
/** Highest valid sheet index: cover + the paid page cap. */
export const MAX_SHEET_INDEX = LIMITS.paid.maxPages;

export type ExportBlockReason = "not_paid" | "invalid_doc" | "empty" | "page_limit";
export type CanExportResult =
  | { ok: true; doc: BookDoc; sheetCount: number }
  | { ok: false; reason: ExportBlockReason };

/**
 * Whether the saved doc may be exported to PDF. Checked in this order: not_paid (PDF is a paid
 * feature; isPaid must come from books.is_paid, set only by the Stripe webhook), invalid_doc
 * (fails parseBookDoc), empty (0 pages), page_limit (> maxPages from books.max_pages /
 * limitsFor(isPaid)). Same structural checks as canPublish; semantic checks (photo ownership,
 * layouts) stay with validateBookDoc in the route.
 */
export function canExport(args: { isPaid: boolean; doc: unknown; maxPages: number }): CanExportResult {
  if (args.isPaid !== true) return { ok: false, reason: "not_paid" };
  const parsed = parseBookDoc(args.doc);
  if (!parsed.ok) return { ok: false, reason: "invalid_doc" };
  const pages = parsed.doc.pages.length;
  if (pages < 1) return { ok: false, reason: "empty" };
  if (!Number.isFinite(args.maxPages) || pages > args.maxPages || pages > MAX_SHEET_INDEX) {
    return { ok: false, reason: "page_limit" };
  }
  return { ok: true, doc: parsed.doc, sheetCount: pages + 1 };
}

export interface SheetRange {
  /** First sheet index (inclusive, 0 = cover). */
  from: number;
  /** Last sheet index (inclusive). */
  to: number;
}

/**
 * Split `sheetCount` sheets (cover + pages) into inclusive ranges of at most `size` sheets.
 * 0 / negative / non-integer counts → []. Example: 21 sheets → [{0,19},{20,20}].
 */
export function chunkRanges(sheetCount: number, size: number = CHUNK_SHEETS): SheetRange[] {
  if (!Number.isSafeInteger(sheetCount) || sheetCount < 1) return [];
  const step = Number.isSafeInteger(size) && size >= 1 ? size : CHUNK_SHEETS;
  const out: SheetRange[] = [];
  for (let from = 0; from < sheetCount; from += step) {
    out.push({ from, to: Math.min(from + step, sheetCount) - 1 });
  }
  return out;
}

/** True when a range is a valid chunk: ints, 0 ≤ from ≤ to ≤ MAX_SHEET_INDEX, ≤ CHUNK_SHEETS sheets. */
export function isValidSheetRange(from: unknown, to: unknown): boolean {
  return (
    typeof from === "number" &&
    typeof to === "number" &&
    Number.isSafeInteger(from) &&
    Number.isSafeInteger(to) &&
    from >= 0 &&
    from <= to &&
    to <= MAX_SHEET_INDEX &&
    to - from < CHUNK_SHEETS
  );
}

type DateInput = Date | string | null | undefined;

function toMs(d: DateInput): number {
  if (d === null || d === undefined || d === "") return NaN;
  const ms = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(ms) ? ms : NaN;
}

/** True when the lease has run out (≤ now) or is missing / unparsable (fail towards reclaiming). */
export function isLeaseStale(leaseUntil: DateInput, now: Date): boolean {
  const ms = toMs(leaseUntil);
  return Number.isNaN(ms) || ms <= now.getTime();
}

export type ExportStatus = "queued" | "running" | "ready" | "failed";

/** Minimal export-row shape for reuseDecision; the API maps DB rows into this. */
export interface ExportRowLike {
  id: string;
  status: ExportStatus;
  docRev: number;
  /** Worker lease; null while queued (then createdAt + staleSeconds is used). */
  leaseUntil: DateInput;
  createdAt: DateInput;
}

export type ReuseDecision =
  /** A finished PDF of this exact doc_rev exists → hand out a fresh signed URL. */
  | { action: "reuse_ready"; id: string }
  /** A live job for this doc_rev is in flight → poll it instead of starting another. */
  | { action: "join"; id: string }
  /** A live job for an older/newer doc_rev holds the book's single slot → 409, retry later. */
  | { action: "busy"; id: string }
  /** Start a new job; `staleIds` are dead queued/running rows the caller should mark failed. */
  | { action: "create"; staleIds: string[] };

/**
 * D-051: what POST /export should do given the book's existing export rows. Order: ready row for
 * the same docRev (newest wins) → live (non-stale) row for the same docRev → any other live row
 * (1 running per book) → create. Failed rows and rows for other revs never block a new job.
 */
export function reuseDecision(
  rows: readonly ExportRowLike[],
  docRev: number,
  now: Date,
  staleSeconds: number = EXPORT_STALE_SECONDS,
): ReuseDecision {
  const newestFirst = [...rows].sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0));

  const ready = newestFirst.find((r) => r.status === "ready" && r.docRev === docRev);
  if (ready) return { action: "reuse_ready", id: ready.id };

  const live: ExportRowLike[] = [];
  const staleIds: string[] = [];
  for (const r of newestFirst) {
    if (r.status !== "queued" && r.status !== "running") continue;
    const lease =
      r.leaseUntil !== null && r.leaseUntil !== undefined && r.leaseUntil !== ""
        ? r.leaseUntil
        : new Date(toMs(r.createdAt) + staleSeconds * 1000);
    if (isLeaseStale(lease, now)) staleIds.push(r.id);
    else live.push(r);
  }

  const same = live.find((r) => r.docRev === docRev);
  if (same) return { action: "join", id: same.id };
  if (live.length > 0) return { action: "busy", id: live[0].id };
  return { action: "create", staleIds };
}

const FILENAME_MAX = 60;

function slugAscii(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip Latin diacritics left by NFKD (é → e)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FILENAME_MAX)
    .replace(/-+$/g, "");
}

/**
 * Download filename for Content-Disposition: ASCII-only slug (a-z, 0-9, "-") of at most 60 chars
 * + ".pdf". Titles with no ASCII letters/digits (Arabic, emoji) use `fallback`. Never contains
 * path separators, quotes, dots or control characters.
 */
export function pdfFilename(title: unknown, fallback: string = "photobook"): string {
  const slug = (typeof title === "string" ? slugAscii(title) : "") || slugAscii(fallback) || "photobook";
  return `${slug}.pdf`;
}
