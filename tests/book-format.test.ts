// M10a A2 — format geometry (portrait + landscape) threaded through bleed, resolution, render,
// print image plan and PDF print boxes. Portrait defaults are covered by the M9 goldens.
import { describe, expect, it } from "vitest";
import { bleedRect, printSlotSizeMm } from "@/lib/book/bleed";
import { cropToStyle, DEFAULT_CROP } from "@/lib/book/crop";
import {
  aspect,
  DEFAULT_FORMAT,
  FORMAT_GEOMETRY,
  formatGeometry,
  orientationOf,
  pageMm,
  sheetMm,
  sheetPt,
  trimPt,
} from "@/lib/book/format";
import { coverRenderModel, pageRenderModel, type RenderPhotos } from "@/lib/book/render";
import { effectiveDpi, isSlotLowRes, layoutSlotMm, slotSizeMm } from "@/lib/book/resolution";
import { BOOK_FORMATS } from "@/lib/book/schema";
import type { BookDoc, BookFormat, BookPage, Layout } from "@/lib/book/types";
import * as layouts from "@/lib/layouts";
import { BLEED_MM, PAGE_MM, SHEET_MM } from "@/lib/layouts";
import { planPrintImages, printBoxMm } from "@/lib/pdf/image-plan";
import { BLEED_PT, printBoxes, SHEET_PT, TRIM_PT } from "@/lib/pdf/finalize";

const close = (a: number, b: number, digits = 9) => expect(a).toBeCloseTo(b, digits);

/** Test-only landscape layout: slots as % of a 210×148 page (M10b ships the real ones). */
const LANDSCAPE_FIXTURE: Layout = {
  id: "test-landscape-two",
  name: "Test landscape two",
  role: "page",
  photoCount: 3,
  prefers: ["landscape", "portrait", "any"],
  slots: [
    { x: 0, y: 0, w: 100, h: 100 }, // full bleed
    { x: 0, y: 0, w: 50, h: 80 }, // left half, touches left + top
    { x: 55, y: 10, w: 40, h: 60 }, // inner
  ],
  caption: { x: 55, y: 80, w: 40, h: 10 },
};

function doc(format: BookFormat, pages: BookPage[], coverPhotoId: string | null = null): BookDoc {
  return {
    version: 2,
    format,
    occasion: "other",
    cover: { layout: "cover", photoId: coverPhotoId, title: "T", subtitle: "" },
    chapters: [],
    pages,
    style: { background: { kind: "color", hex: "#ffffff" }, designStyle: "classic", font: "Inter" },
  } as BookDoc;
}

function page(id: string, layout: string, photoIds: (string | null)[]): BookPage {
  return { id, chapterId: null, layout, slots: photoIds.map((photoId) => ({ photoId, crop: DEFAULT_CROP })), caption: null };
}

describe("format geometry", () => {
  it("has geometry for every BookFormat", () => {
    expect(Object.keys(FORMAT_GEOMETRY).sort()).toEqual([...BOOK_FORMATS].sort());
  });

  it("portrait 148×210 / 154×216, landscape 210×148 / 216×154", () => {
    expect(pageMm("A5_PORTRAIT")).toEqual({ w: 148, h: 210 });
    expect(sheetMm("A5_PORTRAIT")).toEqual({ w: 154, h: 216 });
    expect(pageMm("A5_LANDSCAPE")).toEqual({ w: 210, h: 148 });
    expect(sheetMm("A5_LANDSCAPE")).toEqual({ w: 216, h: 154 });
    expect(orientationOf("A5_PORTRAIT")).toBe("portrait");
    expect(orientationOf("A5_LANDSCAPE")).toBe("landscape");
    close(aspect("A5_PORTRAIT"), 148 / 210);
    close(aspect("A5_LANDSCAPE"), 210 / 148);
  });

  it("sheet = page + BLEED_MM on every side for every format", () => {
    for (const f of BOOK_FORMATS) {
      const g = formatGeometry(f);
      expect(g.sheetMm).toEqual({ w: g.pageMm.w + 2 * BLEED_MM, h: g.pageMm.h + 2 * BLEED_MM });
    }
  });

  it("defaults to portrait (missing / unknown) and keeps the compat aliases portrait", () => {
    expect(DEFAULT_FORMAT).toBe("A5_PORTRAIT");
    expect(pageMm()).toEqual(PAGE_MM);
    expect(sheetMm()).toEqual(SHEET_MM);
    expect(pageMm(null)).toEqual(PAGE_MM);
    expect(pageMm("A4_WHATEVER" as BookFormat)).toEqual(PAGE_MM);
    expect(pageMm("__proto__" as BookFormat)).toEqual(PAGE_MM);
  });

  it("sheetPt / trimPt in points (mm × 72 / 25.4, 3 decimals)", () => {
    expect(sheetPt("A5_PORTRAIT")).toEqual({ w: 436.535, h: 612.283 });
    expect(sheetPt("A5_LANDSCAPE")).toEqual({ w: 612.283, h: 436.535 });
    expect(trimPt("A5_PORTRAIT")).toEqual({ w: 419.528, h: 595.276 });
    expect(trimPt("A5_LANDSCAPE")).toEqual({ w: 595.276, h: 419.528 });
    expect(SHEET_PT).toEqual(sheetPt("A5_PORTRAIT"));
    expect(TRIM_PT).toEqual(trimPt("A5_PORTRAIT"));
  });

  it("layouts index re-exports the format helpers", () => {
    expect(layouts.pageMm).toBe(pageMm);
    expect(layouts.sheetMm).toBe(sheetMm);
    expect(layouts.sheetPt).toBe(sheetPt);
    expect(layouts.FORMAT_GEOMETRY).toBe(FORMAT_GEOMETRY);
  });
});

describe("landscape bleed", () => {
  const L = pageMm("A5_LANDSCAPE");

  it("full-bleed slot covers the whole 216×154 sheet", () => {
    const b = bleedRect(LANDSCAPE_FIXTURE.slots[0], L);
    expect(b.sheetMm).toEqual({ x: 0, y: 0, w: 216, h: 154 });
    close(b.pct.x, (-3 / 210) * 100);
    close(b.pct.y, (-3 / 148) * 100);
    close(b.pct.w, (216 / 210) * 100);
    close(b.pct.h, (154 / 148) * 100);
  });

  it("edge slot extends only on touching sides; inner slot unchanged", () => {
    const edge = bleedRect(LANDSCAPE_FIXTURE.slots[1], L);
    expect(edge.edges).toEqual({ left: true, top: true, right: false, bottom: false });
    close(edge.sheetMm.w, 105 + 3);
    close(edge.sheetMm.h, 0.8 * 148 + 3);
    const inner = bleedRect(LANDSCAPE_FIXTURE.slots[2], L);
    expect(inner.pct).toEqual(LANDSCAPE_FIXTURE.slots[2]);
    close(inner.sheetMm.x, 0.55 * 210 + 3);
    close(inner.sheetMm.y, 0.1 * 148 + 3);
  });

  it("printSlotSizeMm on landscape: full page = 216×154; portrait default unchanged", () => {
    expect(printSlotSizeMm(LANDSCAPE_FIXTURE, 0, "A5_LANDSCAPE")).toEqual({ w: 216, h: 154 });
    expect(printSlotSizeMm("full-page", 0, "A5_LANDSCAPE")).toEqual({ w: 216, h: 154 });
    expect(printSlotSizeMm("full-page", 0)).toEqual({ w: 154, h: 216 });
    expect(printSlotSizeMm("full-page", 0, "A5_PORTRAIT")).toEqual({ w: 154, h: 216 });
    expect(printSlotSizeMm(LANDSCAPE_FIXTURE, 9, "A5_LANDSCAPE")).toBeNull();
    expect(printBoxMm({ x: 0, y: 0, w: 100, h: 100 }, 0, "A5_LANDSCAPE")).toEqual({ w: 210, h: 148 });
    expect(printBoxMm({ x: 0, y: 0, w: 100, h: 100 }, BLEED_MM, "A5_LANDSCAPE")).toEqual({ w: 216, h: 154 });
  });
});

describe("landscape resolution", () => {
  it("slotSizeMm / layoutSlotMm use the landscape page", () => {
    expect(slotSizeMm({ w: 100, h: 100 }, "A5_LANDSCAPE")).toEqual({ w: 210, h: 148 });
    expect(slotSizeMm({ w: 100, h: 100 })).toEqual({ w: 148, h: 210 });
    expect(layoutSlotMm("full-page", 0, "A5_LANDSCAPE")).toEqual({ w: 210, h: 148 });
    expect(layoutSlotMm("nope", 0, "A5_LANDSCAPE")).toBeNull();
  });

  it("effectiveDpi on a landscape full page: a 4000×3000 photo limits on height", () => {
    const mm = slotSizeMm(LANDSCAPE_FIXTURE.slots[0], "A5_LANDSCAPE");
    const dpi = effectiveDpi(4000, 3000, mm.w, mm.h)!;
    close(dpi, Math.min(4000 / (210 / 25.4), 3000 / (148 / 25.4)));
    close(dpi, 4000 / (210 / 25.4)); // width is the limiting axis here (483.8 dpi)
  });

  it("isSlotLowRes depends on the format", () => {
    // 1300×1000 landscape photo on a full page: portrait → 1300/(148/25.4)=223, 1000/(210/25.4)=121 → low;
    // landscape → 1300/(210/25.4)=157, 1000/(148/25.4)=172 → fine.
    const photo = { width: 1300, height: 1000 };
    expect(isSlotLowRes(photo, "full-page", 0)).toBe(true);
    expect(isSlotLowRes(photo, "full-page", 0, 1, "A5_PORTRAIT")).toBe(true);
    expect(isSlotLowRes(photo, "full-page", 0, 1, "A5_LANDSCAPE")).toBe(false);
  });
});

describe("landscape render model", () => {
  const photos: RenderPhotos = { p: { url: "https://x.test/p.jpg", width: 4000, height: 3000 } };

  it("crop maths uses the landscape slot mm", () => {
    const d = doc("A5_LANDSCAPE", [page("pg", "full-page", ["p"])]);
    const m = pageRenderModel(d, 0, photos)!;
    expect(m.slots[0].photo!.style).toEqual(cropToStyle(4000, 3000, 210, 148, DEFAULT_CROP));
    const portrait = pageRenderModel(doc("A5_PORTRAIT", [page("pg", "full-page", ["p"])]), 0, photos)!;
    expect(portrait.slots[0].photo!.style).toEqual(cropToStyle(4000, 3000, 148, 210, DEFAULT_CROP));
  });

  it("print bleed uses the landscape page", () => {
    const d = doc("A5_LANDSCAPE", [page("pg", "full-page", ["p"])], "p");
    const m = pageRenderModel(d, 0, photos, "en", { bleed: true })!;
    expect(m.slots[0].rect).toEqual(bleedRect({ x: 0, y: 0, w: 100, h: 100 }, pageMm("A5_LANDSCAPE")).pct);
    // Same maths as cropToStyle on the 216×154 mm extended box (float noise from the % round trip).
    const want = cropToStyle(4000, 3000, 216, 154, DEFAULT_CROP);
    const got = m.slots[0].photo!.style;
    for (const k of ["left", "top", "width", "height"] as const) close(got[k], want[k]);
    const c = coverRenderModel(d, photos, "en", { bleed: true });
    const coverRect = layouts.getLayout("cover")!.slots[0];
    expect(c.slot!.rect).toEqual(bleedRect(coverRect, pageMm("A5_LANDSCAPE")).pct);
  });
});

describe("planPrintImages per format", () => {
  it("landscape full page needs px for 216×154 mm at 300 dpi", () => {
    // Exactly the 216×154 aspect, big enough not to be capped by the original.
    const photo = { id: "l", width: 4320, height: 3080 };
    const t = planPrintImages(doc("A5_LANDSCAPE", [page("pg", "full-page", ["l"])]), [photo], { maxLongEdge: 10_000 }).get("l")!;
    expect(t).toEqual({ width: Math.round((216 / 25.4) * 300), height: Math.round((154 / 25.4) * 300) });
    expect(effectiveDpi(t.width, t.height, 216, 154)!).toBeGreaterThan(299.5);
  });

  it("the same photo on a portrait doc is sized for 154×216 (cover-fit on height)", () => {
    const photo = { id: "l", width: 4320, height: 3080 };
    const t = planPrintImages(doc("A5_PORTRAIT", [page("pg", "full-page", ["l"])]), [photo], { maxLongEdge: 10_000 }).get("l")!;
    close(t.height, Math.round((216 / 25.4) * 300), 0);
    expect(t.width).toBe(Math.round(((216 / 25.4) * 300 * 4320) / 3080));
  });
});

describe("printBoxes per format", () => {
  // Chromium-like quantised landscape sheet (portrait measured 437.04 × 612; landscape turned).
  const CHROMIUM_LANDSCAPE = { x: 0, y: 0, width: 612, height: 437.04 };

  it("landscape: exact nominal sheet + trim anchored at the real top-left, trim inset 8.504", () => {
    const b = printBoxes(CHROMIUM_LANDSCAPE, "A5_LANDSCAPE")!;
    expect(b).not.toBeNull();
    expect(BLEED_PT).toBe(8.504);
    expect(b.sheet).toEqual({ x: 0, y: 0.505, width: 612.283, height: 436.535 });
    // Top edge stays where Chromium laid out from.
    close(b.sheet.y + b.sheet.height, CHROMIUM_LANDSCAPE.height, 3);
    expect(b.trim).toEqual({ x: 8.504, y: 9.009, width: 595.276, height: 419.528 });
    close(b.trim.x - b.sheet.x, 8.504, 3);
    close(b.sheet.y + b.sheet.height - (b.trim.y + b.trim.height), 8.504, 2);
  });

  it("offset real box keeps the top-left anchor", () => {
    const b = printBoxes({ x: 10, y: 20, width: 611.5, height: 437 }, "A5_LANDSCAPE")!;
    expect(b.sheet.x).toBe(10);
    close(b.sheet.y + b.sheet.height, 457, 3);
  });

  it("rejects a page whose orientation does not match the format", () => {
    expect(printBoxes(CHROMIUM_LANDSCAPE)).toBeNull();
    expect(printBoxes(CHROMIUM_LANDSCAPE, "A5_PORTRAIT")).toBeNull();
    expect(printBoxes({ x: 0, y: 0, width: 437.04, height: 612 }, "A5_LANDSCAPE")).toBeNull();
    expect(printBoxes({ x: 0, y: 0, width: 437.04, height: 612 }, "A5_PORTRAIT")).not.toBeNull();
    // Letter landscape is outside tolerance.
    expect(printBoxes({ x: 0, y: 0, width: 792, height: 612 }, "A5_LANDSCAPE")).toBeNull();
  });
});
