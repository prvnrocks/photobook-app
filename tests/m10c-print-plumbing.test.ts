// M10c T8c — print plumbing for shaped / tilted / framed slots + the geometric / scrapbook dev
// samples. photoRectOf (slot-geometry.ts) is the single photo box: the print box (bleed.ts
// printSlotSizeMm), the low-res check (resolution.ts layoutSlotMm), the print image plan and the
// render model must all agree on it. Framed and tilted slots never bleed; polygons bleed like rects.
// Classic / modern numbers are frozen by tests/golden (m9 + m10b, not regenerated).

import { describe, expect, it } from "vitest";
import { bleedRect, printSlotSizeMm, slotBleeds, spreadBleedRect } from "@/lib/book/bleed";
import { DEV_SAMPLES, devSampleDoc, devSamplePhotos, M10C_SAMPLES, parseDevSample } from "@/lib/book/dev-sample";
import { pageMm } from "@/lib/book/format";
import { coverRenderModel, pageRenderModel } from "@/lib/book/render";
import { effectiveDpi, layoutSlotMm, slotSizeMm } from "@/lib/book/resolution";
import { validateBookDoc } from "@/lib/book/schema";
import { photoRectOf } from "@/lib/book/slot-geometry";
import type { BookDoc, Layout } from "@/lib/book/types";
import { getLayout, LAYOUTS } from "@/lib/layouts";
import { neededPx, planPrintImages, PRINT_DPI } from "@/lib/pdf/image-plan";

const NEW = LAYOUTS.filter((l) => /^[gs]-[pl]-/.test(l.id));
const OLD = LAYOUTS.filter((l) => !/^[gs]-[pl]-/.test(l.id));
const framed = (l: Layout, i: number) => !!l.slots[i].frame && l.slots[i].frame!.kind !== "none";
const mmOf = (l: Layout, i: number) => {
  const r = photoRectOf(l, i, l.format)!;
  const p = pageMm(l.format);
  return { w: (r.w / 100) * p.w, h: (r.h / 100) * p.h };
};

describe("slotBleeds", () => {
  it("every classic / modern slot bleeds as before; framed and tilted slots never do", () => {
    for (const l of OLD) for (const s of l.slots) expect(slotBleeds(s)).toBe(true);
    let framedOrTilted = 0;
    for (const l of NEW) {
      l.slots.forEach((s, i) => {
        const expected = !framed(l, i) && !s.rotate;
        expect(slotBleeds(s), `${l.id}#${i}`).toBe(expected);
        if (!expected) framedOrTilted++;
      });
    }
    expect(framedOrTilted).toBeGreaterThan(30);
  });
});

describe("printSlotSizeMm on M10c layouts", () => {
  it("framed / tilted slots: the photo rect (photoRectOf) at trim size, no bleed", () => {
    for (const l of NEW) {
      l.slots.forEach((s, i) => {
        if (slotBleeds(s)) return;
        const box = printSlotSizeMm(l, i, l.format)!;
        expect(box, `${l.id}#${i}`).toEqual(mmOf(l, i));
        // A frame makes the photo strictly smaller than its slot.
        if (framed(l, i)) {
          const slot = slotSizeMm(s, l.format);
          expect(box.w).toBeLessThan(slot.w);
          expect(box.h).toBeLessThan(slot.h);
        }
        // By id, and with the layout's own format as the default for the frame maths.
        expect(printSlotSizeMm(l.id, i, l.format)).toEqual(box);
      });
    }
  });

  it("polygon slots on a trim edge bleed like rects (spreads: outer edges only, never the fold)", () => {
    let bled = 0;
    for (const l of NEW) {
      l.slots.forEach((s, i) => {
        if (!slotBleeds(s)) return;
        const page = pageMm(l.format);
        const b = l.role === "spread" ? spreadBleedRect(s, page) : bleedRect(s, page);
        expect(printSlotSizeMm(l, i, l.format), `${l.id}#${i}`).toEqual({ w: b.sheetMm.w, h: b.sheetMm.h });
        if (b.edges.left || b.edges.top || b.edges.right || b.edges.bottom) bled++;
      });
    }
    expect(bled).toBeGreaterThan(5);
    // g-p-one-band: full-width band from the top → +3 mm left, right and top.
    const band = printSlotSizeMm("g-p-one-band", 0, "A5_PORTRAIT")!;
    expect(band.w).toBe(154);
    expect(band.h).toBeCloseTo(3 + (getLayout("g-p-one-band")!.slots[0].h / 100) * 210, 9);
    // The same photo as g-p-spread-band's right half stops 1.5 mm short of the fold (3 mm fold
    // gutter, G1): +3 mm right and top only → 148 − 1.5 + 3.
    const spreadBand = printSlotSizeMm("g-p-spread-band", 2, "A5_PORTRAIT")!;
    expect(spreadBand.w).toBeCloseTo(149.5, 3);
    expect(spreadBand.h).toBeCloseTo(band.h, 3);
    // …and the left half's top photo bleeds left + top only (never into the fold).
    expect(printSlotSizeMm("g-p-spread-band", 0, "A5_PORTRAIT")!.w).toBeCloseTo(149.5, 3);
  });

  it("a non-default bleed only changes bleeding slots", () => {
    const l = getLayout("s-p-one-polaroid")!;
    expect(printSlotSizeMm(l, 0, l.format, 0)).toEqual(printSlotSizeMm(l, 0, l.format, 5));
    const g = getLayout("g-p-one-band")!;
    expect(printSlotSizeMm(g, 0, g.format, 5)!.w).toBe(158);
    // Spread fold side never takes bleed: only the outer edge grows with it.
    expect(printSlotSizeMm("g-p-spread-band", 2, "A5_PORTRAIT", 5)!.w).toBeCloseTo(148 - 1.5 + 5, 3);
  });
});

describe("layoutSlotMm (low-res warning) uses the photo rect", () => {
  it("framed slots measure photoRectOf; unframed slots their own rect (unchanged)", () => {
    for (const l of NEW) {
      l.slots.forEach((s, i) => {
        const mm = layoutSlotMm(l.id, i, l.format)!;
        expect(mm, `${l.id}#${i}`).toEqual(framed(l, i) ? mmOf(l, i) : slotSizeMm(s, l.format));
      });
    }
  });

  it("a polaroid lowers the dpi less than the whole slot would suggest", () => {
    const mm = layoutSlotMm("s-p-one-polaroid", 0, "A5_PORTRAIT")!;
    const slot = slotSizeMm(getLayout("s-p-one-polaroid")!.slots[0], "A5_PORTRAIT");
    expect(effectiveDpi(1200, 900, mm.w, mm.h)!).toBeGreaterThan(effectiveDpi(1200, 900, slot.w, slot.h)!);
  });
});

describe("print image plan on M10c samples", () => {
  const BIG = 6000;
  for (const sample of ["geometric-portrait", "geometric-landscape", "scrapbook-portrait", "scrapbook-landscape"] as const) {
    it(`${sample}: every slot photo prints at ≥ 300 dpi on its own (rotated) axes`, () => {
      const doc = devSampleDoc(sample);
      // Unique photo per use, so each target is sized by exactly one slot.
      const ids = new Set<string>();
      const uses: Array<{ id: string; layout: Layout; i: number }> = [];
      for (const p of doc.pages) {
        const l = getLayout(p.layout)!;
        p.slots.forEach((s, i) => {
          if (s.photoId) {
            ids.add(s.photoId);
            uses.push({ id: s.photoId, layout: l, i });
          }
        });
      }
      // sp0… alias d1…d15 in devSamplePhotos — plan with distinct big originals instead.
      const photos = [...ids].map((id) => ({ id, width: BIG, height: (BIG * 2) / 3 }));
      const plan = planPrintImages(doc, photos, { maxLongEdge: 100_000 });
      for (const u of uses) {
        const box = printSlotSizeMm(u.layout, u.i, doc.format)!;
        const t = plan.get(u.id)!;
        expect(effectiveDpi(t.width, t.height, box.w, box.h)!, `${u.layout.id}#${u.i}`).toBeGreaterThanOrEqual(PRINT_DPI - 0.5);
        // Tilted slots: sized from the UNROTATED photo rect (same need as with rotate 0).
        if (u.layout.slots[u.i].rotate) {
          const n = neededPx(BIG, (BIG * 2) / 3, box.w, box.h, 1, PRINT_DPI);
          expect(t.width).toBe(Math.round(n.w));
        }
      }
    });
  }

  it("a framed slot's print copy is smaller than its slot box would need (frame excluded)", () => {
    const doc = devSampleDoc("scrapbook-portrait");
    const id = doc.pages[0].slots[0].photoId!;
    const t = planPrintImages(doc, [{ id, width: BIG, height: 4000 }], { maxLongEdge: 100_000 }).get(id)!;
    const l = getLayout(doc.pages[0].layout)!;
    const slot = slotSizeMm(l.slots[0], doc.format);
    const whole = neededPx(BIG, 4000, slot.w, slot.h, 1, PRINT_DPI);
    expect(t.width).toBeLessThan(Math.round(whole.w));
  });
});

describe("render model in print: frames don't bleed, polygons do", () => {
  const photos = devSamplePhotos();
  it("framed / tilted slots keep their layout rect and the same crop as on screen", () => {
    for (const sample of ["scrapbook-portrait", "scrapbook-landscape"] as const) {
      const doc = devSampleDoc(sample);
      doc.pages.forEach((_p, pi) => {
        const view = pageRenderModel(doc, pi, photos, "en")!;
        const print = pageRenderModel(doc, pi, photos, "en", { bleed: true })!;
        expect(print.slots).toEqual(view.slots);
      });
      expect(coverRenderModel(doc, photos, "en", { bleed: true }).slot).toEqual(coverRenderModel(doc, photos, "en").slot);
    }
  });

  it("geometric polygons on a trim edge are bleed-extended and clipped relative to the extended box", () => {
    const doc = devSampleDoc("geometric-portrait");
    const i = doc.pages.findIndex((p) => p.layout === "g-p-one-band");
    const print = pageRenderModel(doc, i, photos, "en", { bleed: true })!;
    const view = pageRenderModel(doc, i, photos, "en")!;
    const s = getLayout("g-p-one-band")!.slots[0];
    expect(print.slots[0].rect).toEqual(bleedRect(s, pageMm("A5_PORTRAIT")).pct);
    expect(print.slots[0].look?.clipPath).toMatch(/^polygon\(/);
    expect(print.slots[0].look?.clipPath).not.toEqual(view.slots[0].look?.clipPath);
  });
});

describe("M10c dev samples", () => {
  const photoIds = new Set(Object.keys(devSamplePhotos()));
  it("parse: every sample name, nothing else", () => {
    for (const s of DEV_SAMPLES) expect(parseDevSample(s)).toBe(s);
    expect(parseDevSample("scrapbook")).toBeNull();
    expect(parseDevSample(["geometric-portrait"])).toBeNull();
  });

  it("valid docs; spreads on even indices; together they use every geometric + scrapbook layout", () => {
    const used = new Set<string>();
    for (const s of M10C_SAMPLES) {
      const d = devSampleDoc(s);
      expect(validateBookDoc(d, { photoIds, maxPages: 100 }), s).toEqual([]);
      used.add(d.cover.layout);
      d.pages.forEach((p, i) => {
        used.add(p.layout);
        if (getLayout(p.layout)!.role === "spread") expect(p.side).toBe(i % 2 === 0 ? "left" : "right");
      });
    }
    expect(NEW.filter((l) => !used.has(l.id)).map((l) => l.id)).toEqual([]);
    // Each single sample covers its whole style + orientation.
    for (const s of ["geometric-portrait", "geometric-landscape", "scrapbook-portrait", "scrapbook-landscape"] as const) {
      const d = devSampleDoc(s);
      const own = new Set([d.cover.layout, ...d.pages.map((p) => p.layout)]);
      const want = NEW.filter((l) => l.style === d.style.designStyle && l.format === d.format).map((l) => l.id);
      expect(want.filter((id) => !own.has(id)), s).toEqual([]);
    }
  });

  it("AR variants: Arabic chapter titles, date labels, captions and cover; same layouts as EN", () => {
    const arabic = /[؀-ۿ]/;
    for (const s of ["geometric-portrait", "geometric-landscape", "scrapbook-portrait", "scrapbook-landscape"] as const) {
      const en: BookDoc = devSampleDoc(s);
      const ar: BookDoc = devSampleDoc(`${s}-ar`);
      expect(ar.pages.map((p) => p.layout)).toEqual(en.pages.map((p) => p.layout));
      expect(arabic.test(ar.cover.title)).toBe(true);
      for (const c of ar.chapters) {
        expect(arabic.test(c.title)).toBe(true);
        expect(arabic.test(c.dateLabel ?? "")).toBe(true);
      }
      expect(ar.pages.filter((p) => p.caption).every((p) => arabic.test(p.caption!.text))).toBe(true);
      expect(en.chapters.some((c) => arabic.test(c.title))).toBe(false);
    }
  });

  it("occasion picks the accent sticker; a family book never gets seasonal (Eid) motifs", () => {
    const photos = devSamplePhotos();
    const stickersOf = (d: BookDoc) =>
      [coverRenderModel(d, photos).decorations ?? [], ...d.pages.map((_p, i) => pageRenderModel(d, i, photos)?.decorations ?? [])]
        .flat()
        .map((x) => x.art.stickerId);
    const fam = devSampleDoc("scrapbook-portrait");
    expect(fam.occasion).toBe("family");
    const famIds = stickersOf(fam);
    expect(famIds).toContain("accent-house");
    expect(famIds).not.toContain("crescent-star");
    expect(famIds).not.toContain("lantern");
    expect(stickersOf(devSampleDoc("scrapbook-landscape"))).toContain("accent-moon");
  });
});
