// M10b A14 — PDF export of spreads: bleed at the fold, print image plan from the whole spread box,
// resolution warnings for spread slots, spread-aware print photo ids (chunk boundaries) and the
// cross-chunk image dedupe in mergePdfs.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { printSlotSizeMm, spreadBleedRect } from "@/lib/book/bleed";
import { pageMm } from "@/lib/book/format";
import { pageRenderModel } from "@/lib/book/render";
import { effectiveDpi, isSlotLowRes, layoutSlotMm } from "@/lib/book/resolution";
import type { BookDoc, BookFormat, BookPage } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";
import { dedupeImages, mergePdfs } from "@/lib/pdf/finalize";
import { neededPx, planPrintImages, PRINT_MAX_LONG_EDGE, SPREAD_LONG_EDGE_FACTOR } from "@/lib/pdf/image-plan";
import { printPhotoIds, printSheetTargets } from "@/lib/pdf/print-doc";
import { chunkPhotoSchedule } from "@/lib/pdf/prefetch";
import { CHUNK_SHEETS, chunkRanges } from "@/lib/pdf/rules";

const crop = { x: 0.5, y: 0.5, zoom: 1 };
const P = "A5_PORTRAIT" as const;
const L = "A5_LANDSCAPE" as const;

function single(id: string, layout: string, photos: (string | null)[]): BookPage {
  return { id, chapterId: null, layout, slots: photos.map((photoId) => ({ photoId, crop })), caption: null };
}

/** A spread as stored: left half owns the slots, right half slots []. */
function spread(id: string, layout: string, photos: (string | null)[]): BookPage[] {
  return [
    { id: `${id}L`, chapterId: null, layout, side: "left", slots: photos.map((photoId) => ({ photoId, crop })), caption: null },
    { id: `${id}R`, chapterId: null, layout, side: "right", slots: [], caption: null },
  ];
}

function doc(format: BookFormat, pages: BookPage[]): BookDoc {
  return {
    version: 2,
    format,
    occasion: "other",
    cover: { layout: format === L ? "m-l-cover-panel" : "m-p-cover-window", photoId: null, title: "T", subtitle: "" },
    chapters: [],
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "modern", font: "Cormorant" },
  } as BookDoc;
}

describe("spread bleed at the fold", () => {
  for (const format of [P, L]) {
    const page = pageMm(format);
    it(`${format}: panorama = one box, 3 mm bleed on the outer edges only; halves abut at the trim fold`, () => {
      const b = spreadBleedRect({ x: 0, y: 0, w: 200, h: 100 }, page);
      expect(b.edges).toEqual({ left: true, top: true, right: true, bottom: true });
      expect(b.sheetMm.w).toBeCloseTo(2 * page.w + 6, 9); // never doubled at the fold
      expect(b.sheetMm.h).toBeCloseTo(page.h + 6, 9);
      expect(printSlotSizeMm(format === L ? "m-l-spread-panorama" : "m-p-spread-panorama", 0, format)).toEqual({
        w: b.sheetMm.w,
        h: b.sheetMm.h,
      });
    });

    it(`${format}: the two print halves show the same box shifted by exactly one page width`, () => {
      const id = format === L ? "m-l-spread-panorama" : "m-p-spread-panorama";
      const d = doc(format, spread("s", id, ["pano"]));
      const photos = { pano: { url: "x", width: 6000, height: 2000 } };
      const left = pageRenderModel(d, 0, photos, "en", { bleed: true })!;
      const right = pageRenderModel(d, 1, photos, "en", { bleed: true })!;
      const l = left.slots[0];
      const r = right.slots[0];
      expect(l.photoId).toBe("pano");
      expect(r.photoId).toBe("pano");
      expect(r.rect.x).toBeCloseTo(l.rect.x - 100, 9);
      expect(r.rect.w).toBe(l.rect.w);
      expect(r.rect.y).toBe(l.rect.y);
      expect(r.photo!.style).toEqual(l.photo!.style); // same crop → continuous image across the fold
      // The left sheet's image runs past the fold into the left sheet's bleed (no white at the fold).
      const bleedPct = (3 / page.w) * 100;
      expect(l.rect.x).toBeCloseTo(-bleedPct, 6);
      expect(l.rect.x + l.rect.w).toBeGreaterThan(100 + bleedPct);
      expect(r.rect.x).toBeLessThan(-bleedPct);
    });
  }

  it("slots that stop short of the fold get no bleed there (grid / mosaic)", () => {
    for (const id of ["m-p-spread-grid", "m-p-spread-mosaic", "m-l-spread-grid", "m-l-spread-mosaic"]) {
      const l = getLayout(id)!;
      const format = l.format as BookFormat;
      for (const rect of l.slots) {
        const b = spreadBleedRect(rect, pageMm(format));
        const touchesFoldFromLeft = rect.x + rect.w > 99.99 && rect.x + rect.w <= 100;
        const touchesFoldFromRight = rect.x >= 100 && rect.x < 100.01;
        expect(touchesFoldFromLeft || touchesFoldFromRight).toBe(false);
        // Inner (fold-side) edges unchanged → pct x/w stay the layout's numbers on that axis.
        if (!b.edges.left && !b.edges.right) {
          expect(b.pct.x).toBe(rect.x);
          expect(b.pct.w).toBe(rect.w);
        }
      }
    }
  });
});

describe("print image plan for spreads", () => {
  it("plans spread photos (previously skipped → unknown_photo) from the whole spread box at 300 dpi", () => {
    const d = doc(P, [...spread("s", "m-p-spread-panorama", ["pano"])]);
    const plan = planPrintImages(d, [{ id: "pano", width: 8000, height: 4000 }]);
    const box = printSlotSizeMm("m-p-spread-panorama", 0, P)!; // 302 × 216 mm
    const need = neededPx(8000, 4000, box.w, box.h, 1, 300); // height-limited: 216 mm → 2551 px
    expect(plan.get("pano")).toEqual({ width: Math.round(need.w), height: Math.round(need.h) });
    // ≥ 300 dpi on both axes of the box
    const t = plan.get("pano")!;
    expect(effectiveDpi(t.width, t.height, box.w, box.h)).toBeGreaterThanOrEqual(299.9);
  });

  it("a 2:1 panorama gets the 2× long-edge cap (single pages keep PRINT_MAX_LONG_EDGE)", () => {
    const d = doc(L, spread("s", "m-l-spread-panorama", ["pano"]));
    const plan = planPrintImages(d, [{ id: "pano", width: 12000, height: 4000 }]);
    const box = printSlotSizeMm("m-l-spread-panorama", 0, L)!; // 426 × 154 mm
    const need = neededPx(12000, 4000, box.w, box.h, 1, 300);
    expect(need.w).toBeGreaterThan(PRINT_MAX_LONG_EDGE);
    const t = plan.get("pano")!;
    expect(Math.max(t.width, t.height)).toBeLessThanOrEqual(PRINT_MAX_LONG_EDGE * SPREAD_LONG_EDGE_FACTOR);
    expect(t.width).toBe(Math.round(need.w)); // 5031 px fits under 6000 → full 300 dpi
    expect(effectiveDpi(t.width, t.height, box.w, box.h)).toBeGreaterThanOrEqual(299.9);

    const single1 = doc(L, [single("p", "m-l-full-bleed", ["pano"])]);
    const s = planPrintImages(single1, [{ id: "pano", width: 12000, height: 4000 }]).get("pano")!;
    expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(PRINT_MAX_LONG_EDGE);
  });

  it("capped at the original (never upscaled)", () => {
    const d = doc(P, spread("s", "m-p-spread-panorama", ["pano"]));
    expect(planPrintImages(d, [{ id: "pano", width: 2400, height: 1200 }]).get("pano")).toEqual({ width: 2400, height: 1200 });
  });

  it("each spread photo planned once at its spread slot; right halves add nothing", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `g${i}`);
    const d = doc(P, spread("s", "m-p-spread-grid", ids));
    const plan = planPrintImages(
      d,
      ids.map((id) => ({ id, width: 4000, height: 3000 })),
    );
    expect([...plan.keys()].sort()).toEqual([...ids].sort());
    const box = printSlotSizeMm("m-p-spread-grid", 6, P)!; // right-half slot: inner edge no bleed
    const need = neededPx(4000, 3000, box.w, box.h, 1, 300);
    expect(plan.get("g6")).toEqual({ width: Math.round(need.w), height: Math.round(need.h) });
  });

  it("a photo used on a spread and on a single page gets the larger need and the spread cap", () => {
    const d = doc(P, [...spread("s", "m-p-spread-panorama", ["x"]), single("p", "m-p-two-stack", ["x", null])]);
    const plan = planPrintImages(d, [{ id: "x", width: 8000, height: 4000 }]);
    const box = printSlotSizeMm("m-p-spread-panorama", 0, P)!;
    const need = neededPx(8000, 4000, box.w, box.h, 1, 300);
    expect(need.w).toBeGreaterThan(PRINT_MAX_LONG_EDGE); // only the spread cap allows this
    expect(plan.get("x")).toEqual({ width: Math.round(need.w), height: Math.round(need.h) });
  });

  it("unknown-size spread photo gets a 2× max box", () => {
    const d = doc(P, spread("s", "m-p-spread-panorama", ["u"]));
    const m = PRINT_MAX_LONG_EDGE * SPREAD_LONG_EDGE_FACTOR;
    expect(planPrintImages(d, [{ id: "u", width: null, height: null }]).get("u")).toEqual({ width: m, height: m });
  });
});

describe("resolution warnings for spread slots", () => {
  it("panorama slot is 2 page widths: a photo needs 2× the width of a full page for the same dpi", () => {
    for (const [format, pano, full] of [
      [P, "m-p-spread-panorama", "m-p-full"],
      [L, "m-l-spread-panorama", "m-l-full-bleed"],
    ] as const) {
      const page = pageMm(format);
      const p = layoutSlotMm(pano, 0, format)!;
      expect(p.w).toBeCloseTo(2 * page.w, 9);
      expect(p.h).toBeCloseTo(page.h, 9);
      const f = layoutSlotMm(full, 0, format)!;
      // A wide photo exactly fine on a full page (≥ 150 dpi) is low-res across the panorama.
      const wPx = Math.ceil((f.w / 25.4) * 150) + 1;
      const photo = { width: wPx, height: Math.ceil((f.h / 25.4) * 150) + 1 };
      expect(isSlotLowRes(photo, full, 0, 1, format)).toBe(false);
      expect(isSlotLowRes(photo, pano, 0, 1, format)).toBe(true);
      // Twice the width (same height) clears the warning again.
      expect(isSlotLowRes({ width: 2 * wPx, height: photo.height }, pano, 0, 1, format)).toBe(false);
    }
  });

  it("a right-half grid slot is measured on its own size (not doubled)", () => {
    const a = layoutSlotMm("m-p-spread-grid", 6, P)!;
    const b = layoutSlotMm("m-p-spread-grid", 0, P)!;
    expect(a.w).toBeCloseTo(b.w, 6);
    expect(a.h).toBeCloseTo(b.h, 6);
  });
});

describe("print photo ids per sheet (spread halves)", () => {
  const grid = Array.from({ length: 12 }, (_, i) => `g${i}`);
  const d = doc(P, [single("a", "m-p-full", ["a0"]), ...spread("s", "m-p-spread-grid", grid), ...spread("t", "m-p-spread-panorama", ["pano"])]);

  it("each half lists only the owner's photos visible on it; a panorama on both halves", () => {
    expect(printPhotoIds(d, [1])).toEqual(grid.slice(0, 6)); // left half
    expect(printPhotoIds(d, [2])).toEqual(grid.slice(6)); // right half → owner's right slots
    expect(printPhotoIds(d, [3])).toEqual(["pano"]);
    expect(printPhotoIds(d, [4])).toEqual(["pano"]);
  });

  it("an orphaned right half (layout mismatch) shows no content photos", () => {
    const o = doc(P, [single("a", "m-p-full", ["a0"]), { ...spread("t", "m-p-spread-panorama", ["pano"])[1] }]);
    expect(printPhotoIds(o, [1])).toEqual([]);
  });

  it("a spread straddling the chunk boundary (sheets 20 | 21) is scheduled on both chunks", () => {
    // pages[18] (sheet 19, last of chunk 0) = left half, pages[19] (sheet 20, first of chunk 1) = right half.
    const fill = Array.from({ length: 18 }, (_, i) => single(`p${i}`, "m-p-full", [`f${i}`]));
    const big = doc(P, [...fill, ...spread("t", "m-p-spread-panorama", ["pano"]), single("z", "m-p-full", ["z0"])]);
    const ranges = chunkRanges(big.pages.length + 1, CHUNK_SHEETS);
    expect(ranges.map((r) => [r.from, r.to])).toEqual([
      [0, 19],
      [20, 21],
    ]);
    expect(printSheetTargets(big.pages.length, 20, 21)).toEqual([19, 20]);
    const s = chunkPhotoSchedule(big, ranges);
    expect(s.uses[0]).toContain("pano");
    expect(s.uses[1]).toEqual(["pano", "z0"]); // the right half's print route lists the panorama too
    expect(s.releaseAfter[0]).not.toContain("pano");
    expect(s.releaseAfter[1]).toContain("pano"); // held until the right half has rendered
  });
});

describe("mergePdfs image dedupe across chunks", () => {
  async function jpeg(seed: number): Promise<Buffer> {
    const raw = Buffer.alloc(64 * 48 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + seed * 97) & 255;
    return sharp(raw, { raw: { width: 64, height: 48, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
  }
  async function chunk(images: Buffer[]): Promise<Uint8Array> {
    const d = await PDFDocument.create();
    for (const img of images) {
      const page = d.addPage([437.04, 612]);
      const e = await d.embedJpg(img);
      page.drawImage(e, { x: 0, y: 0, width: 437.04, height: 612 });
    }
    return d.save();
  }
  const imageStreams = (d: PDFDocument) =>
    d.context
      .enumerateIndirectObjects()
      .filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));

  it("the same image in two chunks is stored once and both pages point at it; different images stay", async () => {
    const pano = await jpeg(1);
    const other = await jpeg(2);
    const merged = await mergePdfs([await chunk([other, pano]), await chunk([pano])]);
    const out = await PDFDocument.load(merged.bytes);
    const imgs = imageStreams(out);
    expect(imgs).toHaveLength(2);
    expect(imgs.reduce((n, [, o]) => n + (o as PDFRawStream).contents.length, 0)).toBe(pano.length + other.length);
    const xobjRef = (pageIdx: number) => {
      const res = out.getPage(pageIdx).node.Resources()!;
      const xo = res.lookup(PDFName.of("XObject")) as unknown as { values(): unknown[] };
      return String(xo.values()[0]);
    };
    expect(xobjRef(1)).toBe(xobjRef(2)); // pano on chunk 0 sheet 2 and chunk 1 sheet 1
    expect(xobjRef(0)).not.toBe(xobjRef(1));
  });

  // M10b A19 (review N1): sub-streams (SMask / ICC) are compared by their real bytes, and the
  // duplicates' orphaned SMask / ICC objects are deleted.
  async function png(seed: number): Promise<Buffer> {
    const raw = Buffer.alloc(32 * 24 * 4);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 13 + seed * 71) & 255;
    return sharp(raw, { raw: { width: 32, height: 24, channels: 4 } }).png().toBuffer();
  }
  async function pngChunk(images: Buffer[]): Promise<Uint8Array> {
    const d = await PDFDocument.create();
    for (const img of images) {
      const page = d.addPage([437.04, 612]);
      const e = await d.embedPng(img);
      page.drawImage(e, { x: 0, y: 0, width: 437.04, height: 612 });
    }
    return d.save();
  }
  const allObjects = (d: PDFDocument) => d.context.enumerateIndirectObjects();

  it("an image with an SMask in two chunks → ONE image + ONE SMask; no orphaned SMask left", async () => {
    const a = await png(1);
    const merged = await mergePdfs([await pngChunk([a]), await pngChunk([a])]);
    const out = await PDFDocument.load(merged.bytes);
    const imgs = imageStreams(out);
    expect(imgs).toHaveLength(2); // the image + its SMask (both Subtype Image)
    const withMask = imgs.filter(([, o]) => (o as PDFRawStream).dict.get(PDFName.of("SMask")) !== undefined);
    expect(withMask).toHaveLength(1);
  });

  /**
   * One page per entry: an image whose ColorSpace is [/ICCBased <icc>] — same image bytes; a string
   * entry = a new ICC object with those bytes, a number = reuse the ICC object of that entry.
   */
  async function iccDoc(iccs: (string | number)[]): Promise<PDFDocument> {
    const d = await PDFDocument.create();
    const pixels = new Uint8Array(4 * 4 * 3).fill(200);
    const made: PDFRef[] = [];
    for (const spec of iccs) {
      const icc =
        typeof spec === "number" ? made[spec] : d.context.register(d.context.stream(new TextEncoder().encode(spec), { N: 3 }));
      made.push(icc);
      const img = d.context.register(
        d.context.stream(pixels, {
          Type: "XObject",
          Subtype: "Image",
          Width: 4,
          Height: 4,
          BitsPerComponent: 8,
          ColorSpace: d.context.obj([PDFName.of("ICCBased"), icc]),
        }),
      );
      const page = d.addPage([437.04, 612]);
      page.node.setXObject(PDFName.of("Im0"), img);
    }
    return d;
  }
  const iccStreams = (d: PDFDocument) =>
    allObjects(d).filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("N")) !== undefined);

  it("identical ICC bytes: images fold AND the duplicate's ICC object is deleted (orphan)", async () => {
    const d = await iccDoc(["ICC-PROFILE-AAAA", "ICC-PROFILE-AAAA"]);
    expect(imageStreams(d)).toHaveLength(2);
    expect(iccStreams(d)).toHaveLength(2);
    expect(dedupeImages(d.context)).toBe(2); // 1 duplicate image + 1 orphaned ICC
    expect(imageStreams(d)).toHaveLength(1);
    expect(iccStreams(d)).toHaveLength(1);
    const ref = (i: number) => String(d.getPage(i).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict).get(PDFName.of("Im0")));
    expect(ref(0)).toBe(ref(1));
  });

  it("same image bytes but a different ICC (same length) → NOT folded", async () => {
    const d = await iccDoc(["ICC-PROFILE-AAAA", "ICC-PROFILE-BBBB"]);
    expect(dedupeImages(d.context)).toBe(0);
    expect(imageStreams(d)).toHaveLength(2);
    expect(iccStreams(d)).toHaveLength(2);
  });

  it("a shared ICC still used by a kept image is never deleted", async () => {
    // Images 0 and 1 share ONE ICC object; image 2 has its own copy with the same bytes.
    const d = await iccDoc(["ICC-PROFILE-AAAA", 0, "ICC-PROFILE-AAAA"]);
    expect(iccStreams(d)).toHaveLength(2);
    // Images 1 and 2 fold into image 0; the shared ICC is still referenced → kept; image 2's copy goes.
    expect(dedupeImages(d.context)).toBe(3); // 2 duplicate images + 1 orphaned ICC
    expect(iccStreams(d)).toHaveLength(1);
    const img = d.context.lookup(
      d.getPage(0).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict).get(PDFName.of("Im0")) as PDFRef,
    ) as PDFRawStream;
    const cs = img.dict.lookup(PDFName.of("ColorSpace"), PDFArray);
    expect(d.context.lookup(cs.get(1))).toBeInstanceOf(PDFRawStream);
    expect(await d.save()).toBeInstanceOf(Uint8Array);
  });

  it("dedupeImages is a no-op without duplicates", async () => {
    const d = await PDFDocument.load(await chunk([await jpeg(3), await jpeg(4)]));
    expect(dedupeImages(d.context)).toBe(0);
  });
});
