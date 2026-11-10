import { describe, expect, it } from "vitest";
import { printSlotSizeMm } from "@/lib/book/bleed";
import { effectiveDpi } from "@/lib/book/resolution";
import { LAYOUTS } from "@/lib/layouts";
import type { BookDoc, BookPage } from "@/lib/book/types";
import { neededPx, planPrintImages, printBoxMm, type PlanPhoto } from "@/lib/pdf/image-plan";

const crop = (zoom = 1) => ({ x: 0.5, y: 0.5, zoom });

function page(id: string, layout: string, photoIds: (string | null)[], zoom = 1): BookPage {
  return { id, chapterId: null, layout, slots: photoIds.map((photoId) => ({ photoId, crop: crop(zoom) })), caption: null };
}

function doc(pages: BookPage[], coverPhotoId: string | null = null): BookDoc {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "other",
    cover: { layout: "cover", photoId: coverPhotoId, title: "T", subtitle: "" },
    chapters: [],
    pages,
    style: { background: { kind: "color", hex: "#ffffff" }, designStyle: "classic", font: "Inter" },
  } as BookDoc;
}

// Exactly the full-page print box aspect (154×216 mm incl. bleed), larger than needed.
const BIG: PlanPhoto = { id: "big", width: 3080, height: 4320 };

describe("printBoxMm", () => {
  it("extends edge slots by 3 mm per touching side, inner slots unchanged", () => {
    expect(printBoxMm({ x: 0, y: 0, w: 100, h: 100 })).toEqual({ w: 154, h: 216 });
    const inner = printBoxMm({ x: 10, y: 7, w: 80, h: 72 });
    expect(inner.w).toBeCloseTo(118.4, 6);
    expect(inner.h).toBeCloseTo(151.2, 6);
    const cover = printBoxMm({ x: 0, y: 0, w: 100, h: 74 });
    expect(cover.w).toBeCloseTo(154, 6);
    expect(cover.h).toBeCloseTo(155.4 + 3, 6);
    expect(printBoxMm({ x: 0, y: 0, w: 100, h: 100 }, 0)).toEqual({ w: 148, h: 210 });
  });
});

describe("parity with the renderer (book/bleed.ts)", () => {
  it("printBoxMm at the default bleed equals printSlotSizeMm for every layout slot", () => {
    for (const l of LAYOUTS) {
      l.slots.forEach((rect, i) => {
        const r = printSlotSizeMm(l, i)!;
        const b = printBoxMm(rect);
        expect(b.w).toBeCloseTo(r.w, 9);
        expect(b.h).toBeCloseTo(r.h, 9);
      });
    }
    expect(printSlotSizeMm("full-page", 0)).toEqual({ w: 154, h: 216 });
    const c = printSlotSizeMm("cover", 0)!;
    expect(c.w).toBeCloseTo(154, 6);
    expect(c.h).toBeCloseTo(158.4, 6);
  });
});

describe("planPrintImages", () => {
  it("full-page slot incl. bleed at 300 dpi ≈ 1819×2551 px", () => {
    const plan = planPrintImages(doc([page("p1", "full-page", ["big"])]), [BIG]);
    expect(plan.get("big")).toEqual({ width: 1819, height: 2551 });
  });

  it("a smaller slot needs fewer px", () => {
    const full = planPrintImages(doc([page("p1", "full-page", ["big"])]), [BIG]).get("big")!;
    const small = planPrintImages(doc([page("p1", "four-grid", ["big", null, null, null])]), [BIG]).get("big")!;
    expect(small.width).toBeLessThan(full.width);
    expect(small.height).toBeLessThan(full.height);
  });

  it("zoom 2 doubles the need", () => {
    const one = planPrintImages(doc([page("p1", "one-portrait", ["big"], 1)]), [BIG]).get("big")!;
    const two = planPrintImages(doc([page("p1", "one-portrait", ["big"], 2)]), [BIG], { maxLongEdge: 10_000 }).get("big")!;
    expect(two.width).toBeGreaterThanOrEqual(2 * one.width - 1);
    expect(two.width).toBeLessThanOrEqual(2 * one.width + 1);
    expect(two.height).toBeGreaterThanOrEqual(2 * one.height - 1);
    expect(two.height).toBeLessThanOrEqual(2 * one.height + 1);
  });

  it("never upscales beyond the original, keeping aspect", () => {
    const small: PlanPhoto = { id: "s", width: 1200, height: 1600 };
    const t = planPrintImages(doc([page("p1", "full-page", ["s"], 3)]), [small]).get("s")!;
    expect(t).toEqual({ width: 1200, height: 1600 });
  });

  it("caps the long edge at maxLongEdge (default 3000), keeping aspect", () => {
    const huge: PlanPhoto = { id: "h", width: 6000, height: 8000 };
    const t = planPrintImages(doc([page("p1", "full-page", ["h"], 2)]), [huge]).get("h")!;
    expect(t.height).toBe(3000);
    expect(t.width).toBe(2250);
    const t2 = planPrintImages(doc([page("p1", "full-page", ["h"], 2)]), [huge], { maxLongEdge: 2000 }).get("h")!;
    expect(Math.max(t2.width, t2.height)).toBe(2000);
    expect(t2.width / t2.height).toBeCloseTo(0.75, 2);
  });

  it("a photo used twice gets the max of both uses", () => {
    const d = doc([page("p1", "four-grid", ["big", null, null, null]), page("p2", "full-page", ["big"])]);
    expect(planPrintImages(d, [BIG]).get("big")).toEqual({ width: 1819, height: 2551 });
  });

  it("includes the cover photo (cover slot incl. bleed on 3 sides, default crop)", () => {
    const t = planPrintImages(doc([], "big"), [BIG]).get("big")!;
    // Cover box 154×158.4 mm; BIG is narrower than the box → width-limited: 154 mm → 1819 px.
    expect(t.width).toBe(1819);
    expect(t.height).toBe(Math.round((1819 * 4320) / 3080));
  });

  it("landscape photo in a portrait slot: cover-fit on the height", () => {
    const land: PlanPhoto = { id: "l", width: 4000, height: 3000 };
    // 154×216 box: height-limited → 216 mm = 2551 px tall, width = 2551 × 4/3 ≈ 3402.
    const t = planPrintImages(doc([page("p1", "full-page", ["l"])]), [land], { maxLongEdge: 5000 }).get("l")!;
    expect(t.height).toBe(2551);
    expect(t.width).toBe(3402);
    const n = neededPx(4000, 3000, 154, 216, 1, 300);
    expect(n.h).toBeCloseTo((216 / 25.4) * 300, 6);
    // Default long-edge cap 3000 → 3000×2250.
    expect(planPrintImages(doc([page("p1", "full-page", ["l"])]), [land]).get("l")).toEqual({ width: 3000, height: 2250 });
  });

  it("skips photos missing from the list; unknown size → long-edge box", () => {
    const d = doc([page("p1", "two-vertical", ["gone", "nodims"])]);
    const plan = planPrintImages(d, [{ id: "nodims", width: null, height: null }]);
    expect(plan.has("gone")).toBe(false);
    expect(plan.get("nodims")).toEqual({ width: 3000, height: 3000 });
  });

  it("ignores unknown layouts and empty slots", () => {
    const plan = planPrintImages(doc([page("p1", "nope", ["big"]), page("p2", "full-page", [null])]), [BIG]);
    expect(plan.size).toBe(0);
  });

  it("dpi option scales linearly", () => {
    const t = planPrintImages(doc([page("p1", "full-page", ["big"])]), [BIG], { dpi: 150 }).get("big")!;
    expect(t).toEqual({ width: Math.round(1818.9 / 2), height: Math.round(2551.18 / 2) });
  });

  it("a 4096 px original in a full-page slot (incl. bleed) prints at ≥ 300 dpi", () => {
    expect(effectiveDpi(3072, 4096, 154, 216, 1)!).toBeGreaterThanOrEqual(300);
    // And the planned copy itself still covers 300 dpi on the limiting axis.
    const t = planPrintImages(doc([page("p1", "full-page", ["x"])]), [{ id: "x", width: 3072, height: 4096 }]).get("x")!;
    expect(effectiveDpi(t.width, t.height, 154, 216, 1)!).toBeGreaterThan(299.5);
  });
});
