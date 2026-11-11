// Pure helpers for the internal print route (M8 T5): which sheets a token range covers and the
// render photo map with every src on the print-asset origin. Isomorphic, no React, no DOM.

import type { RenderPhotos } from "@/lib/book/render";
import { getLayout } from "@/lib/layouts";
import { printAssetUrl } from "./print-assets";
import { CHUNK_MAX_IMAGES, CHUNK_SHEETS, type SheetRange } from "./rules";

/** One print sheet: the cover or an index into doc.pages. */
export type PrintSheetTarget = "cover" | number;

/**
 * Sheets from..to inclusive (0 = cover, sheet i = doc.pages[i - 1]) for a doc with `pageCount`
 * pages, or null when the range is malformed or runs past the last sheet (token / doc mismatch).
 */
export function printSheetTargets(pageCount: number, from: number, to: number): PrintSheetTarget[] | null {
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) return null;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return null;
  if (to > pageCount) return null;
  const out: PrintSheetTarget[] = [];
  for (let s = from; s <= to; s++) out.push(s === 0 ? "cover" : s - 1);
  return out;
}

export interface PrintPhotoDims {
  id: string;
  width: number | null;
  height: number | null;
}

function positiveInt(n: unknown): number | null {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** RenderPhotos for print: stored pixel size (for the crop maths) + src = printAssetUrl(id). */
export function printRenderPhotos(rows: Iterable<PrintPhotoDims>): RenderPhotos {
  const out: Record<string, { url: string; width: number | null; height: number | null }> = {};
  for (const r of rows) {
    out[r.id] = { url: printAssetUrl(r.id), width: positiveInt(r.width), height: positiveInt(r.height) };
  }
  return out;
}

/** A background as print-doc needs it (v2 union, or a v1 hex string = colour). */
type BackgroundRef = { kind: string; photoId?: string } | string | null | undefined;

function backgroundPhotoId(bg: BackgroundRef): string | null {
  return bg && typeof bg === "object" && bg.kind === "photo" && typeof bg.photoId === "string" ? bg.photoId : null;
}

/** A page as printPhotoIds needs it (structural, so tests and the prefetch schedule can pass slim docs). */
interface PhotoIdsPage {
  slots: { photoId: string | null }[];
  background?: BackgroundRef;
  /** Layout id (M10b): spread layouts put both halves' photos on the left page. */
  layout?: string;
  side?: string;
}

/** True when a spread rect (x 0..200) seen from a half (offset 0 / 100) overlaps that page — render.ts onPage. */
function onHalf(rect: { x: number; w: number }, offset: number): boolean {
  const x = rect.x - offset;
  return x < 100 - 1e-9 && x + rect.w > 1e-9;
}

/**
 * Content photo ids one page sheet shows. Single pages: its slots. Spread halves (M10b): the slots
 * of the OWNER (left half = itself, right half = the matching left page before it, as render.ts
 * spreadHalfOf) whose rect is visible on this half — a panorama is listed on both halves, a
 * photo of the grid's right half only on the right sheet. So a spread straddling a chunk
 * boundary (left = last sheet of chunk k, right = first sheet of chunk k + 1) gets its photos on
 * both chunks' print routes and in both chunks' prefetch schedules.
 */
function pagePhotoIds(pages: readonly PhotoIdsPage[], index: number): (string | null)[] {
  const page = pages[index];
  const layout = page.layout ? getLayout(page.layout) : undefined;
  if (layout?.role !== "spread") return page.slots.map((s) => s.photoId);
  let owner: PhotoIdsPage | null = page;
  let offset = 0;
  if (page.side === "right") {
    const prev = pages[index - 1];
    owner = prev && prev.side === "left" && prev.layout === page.layout ? prev : null;
    offset = 100;
  }
  if (!owner) return []; // orphaned right half renders background only
  return layout.slots.map((rect, i) => (onHalf(rect, offset) ? (owner.slots[i]?.photoId ?? null) : null));
}

/**
 * Photo ids the given sheets show, deduplicated, in order: per sheet its content photos (cover
 * photo / page slots — spread halves: the owner's slots visible on that half) then its background
 * photo (M10a A6: the cover shows the book default background; a page its own override, else the
 * book default).
 */
export function printPhotoIds(
  doc: {
    cover: { photoId: string | null };
    pages: readonly PhotoIdsPage[];
    style?: { background?: BackgroundRef };
  },
  targets: readonly PrintSheetTarget[],
): string[] {
  const ids = new Set<string>();
  const bookBg = backgroundPhotoId(doc.style?.background);
  for (const t of targets) {
    if (t === "cover") {
      if (doc.cover.photoId) ids.add(doc.cover.photoId);
      if (bookBg) ids.add(bookBg);
    } else {
      const page = doc.pages[t];
      if (!page) {
        if (bookBg) ids.add(bookBg); // a missing page renders blank on the book default
        continue;
      }
      for (const id of pagePhotoIds(doc.pages, t)) if (id) ids.add(id);
      const bg = page.background ? backgroundPhotoId(page.background) : bookBg;
      if (bg) ids.add(bg);
    }
  }
  return [...ids];
}

/**
 * Sheet units that must share a chunk: the cover, single pages, orphaned halves = one sheet
 * each; a spread pair (left half followed by its matching right half — same pairing rule as
 * pagePhotoIds) = two sheets. Inclusive sheet ranges in order.
 */
function sheetUnits(pages: readonly PhotoIdsPage[]): SheetRange[] {
  const units: SheetRange[] = [{ from: 0, to: 0 }];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const next = pages[i + 1];
    const isPair =
      page.side === "left" &&
      !!page.layout &&
      getLayout(page.layout)?.role === "spread" &&
      next?.side === "right" &&
      next.layout === page.layout;
    if (isPair) {
      units.push({ from: i + 1, to: i + 2 });
      i++;
    } else {
      units.push({ from: i + 1, to: i + 1 });
    }
  }
  return units;
}

export interface ChunkPlanOptions {
  /** Max sheets per chunk (default CHUNK_SHEETS). */
  maxSheets?: number;
  /** Max distinct print images per chunk (default CHUNK_MAX_IMAGES). */
  maxImages?: number;
  /** Only these photo ids are downloaded (e.g. plan.has) — others don't count. Default: all. */
  planned?: (photoId: string) => boolean;
}

/**
 * Render chunks for a doc (M10b B1): consecutive sheet ranges holding at most `maxSheets` sheets
 * AND at most `maxImages` distinct print images (content + background photos the sheets show,
 * printPhotoIds), filled greedily in sheet order. A spread pair is never split across chunks
 * (unless maxSheets < 2), so its halves render in one tab from one print copy; a right half can
 * still start a chunk only when it is orphaned (renders background only) — pagePhotoIds keeps
 * handling straddling halves anyway. A single unit with more than `maxImages` images still gets
 * its own chunk (cannot be split further). Same result for the prefetch schedule and renderBook:
 * compute once per pass and pass it to both.
 */
export function printChunkRanges(
  doc: { cover: { photoId: string | null }; pages: readonly PhotoIdsPage[]; style?: { background?: BackgroundRef } },
  opts: ChunkPlanOptions = {},
): SheetRange[] {
  const maxSheets = Number.isSafeInteger(opts.maxSheets) && (opts.maxSheets as number) >= 1 ? (opts.maxSheets as number) : CHUNK_SHEETS;
  const maxImages = Number.isSafeInteger(opts.maxImages) && (opts.maxImages as number) >= 1 ? (opts.maxImages as number) : CHUNK_MAX_IMAGES;
  const planned = opts.planned ?? (() => true);

  // Units wider than the sheet cap (a pair with maxSheets 1) fall back to single sheets.
  const units = sheetUnits(doc.pages).flatMap((u) =>
    u.to - u.from + 1 <= maxSheets ? [u] : Array.from({ length: u.to - u.from + 1 }, (_, k) => ({ from: u.from + k, to: u.from + k })),
  );

  const out: SheetRange[] = [];
  let cur: SheetRange | null = null;
  let ids = new Set<string>();
  for (const u of units) {
    const targets = printSheetTargets(doc.pages.length, u.from, u.to) ?? [];
    const unitIds = printPhotoIds(doc, targets).filter(planned);
    if (cur) {
      const added = unitIds.filter((id) => !ids.has(id)).length;
      if (u.to - cur.from + 1 > maxSheets || ids.size + added > maxImages) {
        out.push(cur);
        cur = null;
      }
    }
    if (!cur) {
      cur = { from: u.from, to: u.to };
      ids = new Set(unitIds);
    } else {
      cur.to = u.to;
      for (const id of unitIds) ids.add(id);
    }
  }
  if (cur) out.push(cur);
  return out;
}
