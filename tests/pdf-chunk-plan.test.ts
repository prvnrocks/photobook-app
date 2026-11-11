// M10b B1 — image-aware PDF chunking (print-doc.ts printChunkRanges, rules.ts isValidChunkPlan),
// the image-scaled print-ready cap (print-ready.ts printReadyTimeoutMs) and renderBook's chunk
// plan validation.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { BookDoc, BookFormat, BookPage } from "@/lib/book/types";
import { printChunkRanges, printPhotoIds, printSheetTargets } from "@/lib/pdf/print-doc";
import { chunkPhotoSchedule } from "@/lib/pdf/prefetch";
import { CHUNK_READY_TIMEOUT_MS, renderBook } from "@/lib/pdf/render-pdf";
import {
  distinctImageCount,
  PRINT_READY_MAX_TIMEOUT_MS,
  PRINT_READY_PER_IMAGE_MS,
  PRINT_READY_TIMEOUT_MS,
  printReadyTimeoutMs,
} from "@/lib/pdf/print-ready";
import { CHUNK_MAX_IMAGES, CHUNK_SHEETS, chunkRanges, isValidChunkPlan, isValidSheetRange, PDF_DEADLINE_MS } from "@/lib/pdf/rules";

const crop = { x: 0.5, y: 0.5, zoom: 1 };
const L = "A5_LANDSCAPE" as const;
let seq = 0;

function single(layout: string, photos: (string | null)[]): BookPage {
  return { id: `p${seq++}`, chapterId: null, layout, slots: photos.map((photoId) => ({ photoId, crop })), caption: null };
}

function spread(layout: string, photos: (string | null)[]): BookPage[] {
  const id = `s${seq++}`;
  return [
    { id: `${id}L`, chapterId: null, layout, side: "left", slots: photos.map((photoId) => ({ photoId, crop })), caption: null },
    { id: `${id}R`, chapterId: null, layout, side: "right", slots: [], caption: null },
  ];
}

function doc(pages: BookPage[], format: BookFormat = L, bgPhoto: string | null = null): BookDoc {
  return {
    version: 2,
    format,
    occasion: "other",
    cover: { layout: "m-l-cover-panel", photoId: "cover", title: "T", subtitle: "" },
    chapters: [],
    pages,
    style: {
      background: bgPhoto ? { kind: "photo", photoId: bgPhoto } : { kind: "color", hex: "#FFFFFF" },
      designStyle: "modern",
      font: "Cormorant",
    },
  } as BookDoc;
}

let pid = 0;
const ids = (n: number) => Array.from({ length: n }, () => `ph${pid++}`);
const grid = () => spread("m-l-spread-grid", ids(12));
const full = () => single("m-l-full-bleed", ids(1));

function imagesIn(d: BookDoc, from: number, to: number): number {
  return printPhotoIds(d, printSheetTargets(d.pages.length, from, to)!).length;
}

/** No range ends on a left half whose right half starts the next range. */
function splitsPair(d: BookDoc, ranges: { from: number; to: number }[]): boolean {
  return ranges.slice(0, -1).some((r) => {
    const last = d.pages[r.to - 1];
    const next = d.pages[r.to];
    return r.to >= 1 && last?.side === "left" && next?.side === "right" && next.layout === last.layout;
  });
}

describe("printChunkRanges (image-aware chunking)", () => {
  it("text/1-photo pages: same as the plain 20-sheet chunks", () => {
    const d = doc(Array.from({ length: 100 }, full));
    expect(printChunkRanges(d)).toEqual(chunkRanges(101, CHUNK_SHEETS));
  });

  it("the B1 chunk: 10 grid spreads (120 photos in 20 sheets) is split to ≤ CHUNK_MAX_IMAGES per chunk", () => {
    const d = doc([...Array.from({ length: 10 }, grid).flat(), ...Array.from({ length: 10 }, full)]);
    const ranges = printChunkRanges(d);
    expect(isValidChunkPlan(ranges, d.pages.length + 1)).toBe(true);
    for (const r of ranges) {
      expect(imagesIn(d, r.from, r.to)).toBeLessThanOrEqual(CHUNK_MAX_IMAGES);
      expect(r.to - r.from + 1).toBeLessThanOrEqual(CHUNK_SHEETS);
    }
    // cover + 4 spreads = 49 imgs; a 5th spread (61) would exceed 60
    expect(ranges[0]).toEqual({ from: 0, to: 8 });
    expect(ranges.length).toBeGreaterThan(chunkRanges(d.pages.length + 1).length);
    expect(splitsPair(d, ranges)).toBe(false);
  });

  it("never splits a spread pair at the 20-sheet cap (pair at sheets 20|21 moves to the next chunk)", () => {
    // pages[18] = left (sheet 19), pages[19] = right (sheet 20): plain chunks would cut between them.
    const d = doc([...Array.from({ length: 18 }, full), ...spread("m-l-spread-panorama", ["pano"]), full()]);
    const plain = chunkRanges(d.pages.length + 1);
    expect(plain[0]).toEqual({ from: 0, to: 19 });
    expect(splitsPair(d, plain)).toBe(true);
    const ranges = printChunkRanges(d);
    expect(ranges).toEqual([
      { from: 0, to: 18 },
      { from: 19, to: 21 },
    ]);
    expect(splitsPair(d, ranges)).toBe(false);
    // the panorama is scheduled in ONE chunk only (one print copy, no cross-chunk duplicate)
    const s = chunkPhotoSchedule(d, ranges);
    expect(s.uses.filter((u) => u.includes("pano"))).toHaveLength(1);
  });

  it("never splits a pair at the image cap either", () => {
    // cover (1) + 4 grids (48) + 10 singles (10) = 59, next grid would be 71 → whole grid moves.
    const d = doc([...Array.from({ length: 4 }, grid).flat(), ...Array.from({ length: 10 }, full), ...grid()]);
    const ranges = printChunkRanges(d, { maxSheets: 40 });
    expect(ranges).toEqual([
      { from: 0, to: 18 },
      { from: 19, to: 20 },
    ]);
    expect(splitsPair(d, ranges)).toBe(false);
  });

  it("an orphaned right half is a unit of its own and may start a chunk", () => {
    const orphan = spread("m-l-spread-panorama", ["pano"])[1];
    const d = doc([...Array.from({ length: 19 }, full), orphan, full()]);
    const ranges = printChunkRanges(d);
    expect(ranges).toEqual([
      { from: 0, to: 19 },
      { from: 20, to: 21 },
    ]);
  });

  it("a shared background photo counts once per chunk; unplanned photos don't count", () => {
    const d = doc(Array.from({ length: 30 }, () => single("m-l-full-bleed", ids(1))), L, "bg");
    // cover + bg + 1/page: 20 sheets → 21 distinct images
    expect(printChunkRanges(d, { maxImages: 21 })).toEqual(chunkRanges(31));
    expect(printChunkRanges(d, { maxImages: 11 })[0]).toEqual({ from: 0, to: 9 }); // cover, bg + 9 pages
    expect(printChunkRanges(d, { maxImages: 11, planned: (id) => id !== "bg" })[0]).toEqual({ from: 0, to: 10 });
  });

  it("a unit with more images than the cap still gets its own chunk", () => {
    const d = doc([full(), ...grid(), full()]);
    expect(printChunkRanges(d, { maxImages: 5 })).toEqual([
      { from: 0, to: 1 },
      { from: 2, to: 3 },
      { from: 4, to: 4 },
    ]);
  });

  it("maxSheets 1 falls back to single sheets (pair split only when it cannot fit)", () => {
    const d = doc([...spread("m-l-spread-panorama", ["pano"])]);
    expect(printChunkRanges(d, { maxSheets: 1 })).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 1 },
      { from: 2, to: 2 },
    ]);
  });

  it("every plan of a 100-page grid-heavy book is valid for print tokens and renderBook", () => {
    const pages: BookPage[] = [];
    while (pages.length < 98) pages.push(...grid());
    pages.push(full(), full());
    const d = doc(pages);
    const ranges = printChunkRanges(d);
    expect(isValidChunkPlan(ranges, 101)).toBe(true);
    expect(ranges.every((r) => isValidSheetRange(r.from, r.to))).toBe(true);
    expect(splitsPair(d, ranges)).toBe(false);
  });
});

describe("isValidChunkPlan", () => {
  it("accepts contiguous plans covering every sheet; rejects gaps, overlaps, short/long, oversize ranges", () => {
    expect(isValidChunkPlan(chunkRanges(101), 101)).toBe(true);
    expect(isValidChunkPlan([{ from: 0, to: 4 }], 5)).toBe(true);
    expect(isValidChunkPlan([], 5)).toBe(false);
    expect(isValidChunkPlan([{ from: 0, to: 3 }], 5)).toBe(false); // misses the last sheet
    expect(isValidChunkPlan([{ from: 0, to: 5 }], 5)).toBe(false); // past the last sheet
    expect(isValidChunkPlan([{ from: 1, to: 4 }], 5)).toBe(false); // no cover
    expect(isValidChunkPlan([{ from: 0, to: 1 }, { from: 3, to: 4 }], 5)).toBe(false); // gap
    expect(isValidChunkPlan([{ from: 0, to: 2 }, { from: 2, to: 4 }], 5)).toBe(false); // overlap
    expect(isValidChunkPlan([{ from: 0, to: 20 }], 21)).toBe(false); // 21 sheets > CHUNK_SHEETS
    expect(isValidChunkPlan([{ from: 0, to: 0 }], 0)).toBe(false);
  });
});

describe("printReadyTimeoutMs (image-scaled print-ready cap)", () => {
  it("base cap + per image, bounded", () => {
    expect(printReadyTimeoutMs(0)).toBe(PRINT_READY_TIMEOUT_MS);
    expect(printReadyTimeoutMs(-3)).toBe(PRINT_READY_TIMEOUT_MS);
    expect(printReadyTimeoutMs(Number.NaN)).toBe(PRINT_READY_TIMEOUT_MS);
    expect(printReadyTimeoutMs(10)).toBe(PRINT_READY_TIMEOUT_MS + 10 * PRINT_READY_PER_IMAGE_MS);
    expect(printReadyTimeoutMs(CHUNK_MAX_IMAGES)).toBe(38_000);
    expect(printReadyTimeoutMs(10_000)).toBe(PRINT_READY_MAX_TIMEOUT_MS);
  });

  it("stays inside the renderer's per-chunk budget and the export deadline", async () => {
    expect(PRINT_READY_MAX_TIMEOUT_MS).toBeLessThan(CHUNK_READY_TIMEOUT_MS - 10_000);
    expect(PRINT_READY_MAX_TIMEOUT_MS).toBeLessThan(PDF_DEADLINE_MS / 5);
  });

  it("distinctImageCount: one per URL (spread halves share one), empty srcs ignored", () => {
    expect(distinctImageCount([{ src: "a" }, { currentSrc: "a", src: "a" }, { src: "b" }, { src: "" }, {}])).toBe(2);
  });
});

describe("renderBook chunk plan", () => {
  const base = {
    origin: "https://app.example.ae",
    bookId: "00000000-0000-4000-8000-000000000001",
    exportId: "00000000-0000-4000-8000-000000000002",
    docRev: 1,
    sheetCount: 5,
    loader: {} as never,
  };

  it("rejects a plan that does not cover the sheets (navigation_failed) before launching Chromium", async () => {
    const launch = vi.fn();
    for (const ranges of [[{ from: 0, to: 3 }], [{ from: 0, to: 1 }, { from: 3, to: 4 }], []]) {
      await expect(renderBook({ ...base, ranges, launch })).rejects.toMatchObject({ code: "navigation_failed" });
    }
    expect(launch).not.toHaveBeenCalled();
  });
});
