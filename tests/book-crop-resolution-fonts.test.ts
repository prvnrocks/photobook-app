import { describe, expect, it } from "vitest";
import { clampCrop, cropToStyle } from "@/lib/book/crop";
import {
  captionFontFamily,
  CAPTION_FONTS,
  CAPTION_FONT_VARS,
  defaultCaptionFont,
  isCaptionFont,
} from "@/lib/book/fonts";
import { effectiveDpi, isLowRes, isSlotLowRes, layoutSlotMm, LOW_RES_DPI, slotSizeMm } from "@/lib/book/resolution";

const PORTRAIT = [3000, 4000] as const;
const LANDSCAPE = [4000, 3000] as const;
const P_SLOT = [60, 120] as const; // portrait slot (mm)
const L_SLOT = [120, 60] as const; // landscape slot (mm)

function expectCovers(s: { width: number; height: number; left: number; top: number }) {
  const eps = 1e-9;
  expect(s.width).toBeGreaterThanOrEqual(100 - eps);
  expect(s.height).toBeGreaterThanOrEqual(100 - eps);
  expect(s.left).toBeLessThanOrEqual(eps);
  expect(s.top).toBeLessThanOrEqual(eps);
  expect(s.left + s.width).toBeGreaterThanOrEqual(100 - eps);
  expect(s.top + s.height).toBeGreaterThanOrEqual(100 - eps);
}

describe("cropToStyle", () => {
  it("exact aspect match at zoom 1 fills the slot", () => {
    expect(cropToStyle(3000, 6000, 60, 120, { x: 0.5, y: 0.5, zoom: 1 })).toEqual({ width: 100, height: 100, left: 0, top: 0 });
  });

  it("landscape photo in portrait slot: height 100, width overflows, centred", () => {
    const s = cropToStyle(...LANDSCAPE, ...P_SLOT, { x: 0.5, y: 0.5, zoom: 1 });
    expect(s.height).toBeCloseTo(100);
    expect(s.width).toBeCloseTo(((4000 * (120 / 3000)) / 60) * 100); // 266.67
    expect(s.left).toBeCloseTo(50 - s.width / 2);
    expect(s.top).toBe(0);
    expectCovers(s);
  });

  it("portrait photo in landscape slot: width 100, height overflows", () => {
    const s = cropToStyle(...PORTRAIT, ...L_SLOT, { x: 0.5, y: 0.5, zoom: 1 });
    expect(s.width).toBeCloseTo(100);
    expect(s.height).toBeCloseTo(((4000 * (120 / 3000)) / 60) * 100);
    expect(s.left).toBe(0);
    expectCovers(s);
  });

  it("portrait into portrait and landscape into landscape slots cover", () => {
    expectCovers(cropToStyle(...PORTRAIT, ...P_SLOT, { x: 0.3, y: 0.8, zoom: 1.7 }));
    expectCovers(cropToStyle(...LANDSCAPE, ...L_SLOT, { x: 0.9, y: 0.1, zoom: 2.5 }));
  });

  it("focal point at the edges clamps without exposing a gap", () => {
    const left = cropToStyle(...LANDSCAPE, ...P_SLOT, { x: 0, y: 0.5, zoom: 1 });
    expect(left.left).toBe(0);
    const right = cropToStyle(...LANDSCAPE, ...P_SLOT, { x: 1, y: 0.5, zoom: 1 });
    expect(right.left).toBeCloseTo(100 - right.width);
    const top = cropToStyle(...PORTRAIT, ...L_SLOT, { x: 0.5, y: 0, zoom: 1 });
    expect(top.top).toBe(0);
    const bottom = cropToStyle(...PORTRAIT, ...L_SLOT, { x: 0.5, y: 1, zoom: 1 });
    expect(bottom.top).toBeCloseTo(100 - bottom.height);
    [left, right, top, bottom].forEach(expectCovers);
  });

  it("focal point on the non-overflowing axis has no effect at zoom 1", () => {
    const a = cropToStyle(...LANDSCAPE, ...P_SLOT, { x: 0.5, y: 0, zoom: 1 });
    const b = cropToStyle(...LANDSCAPE, ...P_SLOT, { x: 0.5, y: 1, zoom: 1 });
    expect(a.top).toBe(0);
    expect(b.top).toBe(0);
  });

  it("zoom 1..4 scales both axes and keeps the focal point centred when possible", () => {
    for (const zoom of [1, 1.5, 2, 3, 4]) {
      const s = cropToStyle(3000, 6000, 60, 120, { x: 0.5, y: 0.5, zoom });
      expect(s.width).toBeCloseTo(100 * zoom);
      expect(s.height).toBeCloseTo(100 * zoom);
      expect(s.left).toBeCloseTo(50 - 50 * zoom);
      expectCovers(s);
    }
    const f = cropToStyle(3000, 6000, 60, 120, { x: 0.25, y: 0.75, zoom: 4 });
    // focal point lands on slot centre: left + x*width = 50
    expect(f.left + 0.25 * f.width).toBeCloseTo(50);
    expect(f.top + 0.75 * f.height).toBeCloseTo(50);
  });

  it("clamps zoom and focal point out of range", () => {
    expect(cropToStyle(3000, 6000, 60, 120, { x: 0.5, y: 0.5, zoom: 10 }).width).toBeCloseTo(400);
    expect(cropToStyle(3000, 6000, 60, 120, { x: 0.5, y: 0.5, zoom: 0.1 }).width).toBeCloseTo(100);
    expectCovers(cropToStyle(...LANDSCAPE, ...P_SLOT, { x: -3, y: 7, zoom: 2 }));
    expect(clampCrop({ x: Number.NaN, y: 2, zoom: Infinity })).toEqual({ x: 0.5, y: 1, zoom: 1 });
  });

  it("unknown sizes fall back to fill", () => {
    expect(cropToStyle(0, 100, 60, 120, null)).toEqual({ width: 100, height: 100, left: 0, top: 0 });
    expect(cropToStyle(100, 100, Number.NaN, 120, null)).toEqual({ width: 100, height: 100, left: 0, top: 0 });
  });
});

describe("resolution", () => {
  it("slot mm from layout %", () => {
    expect(slotSizeMm({ w: 100, h: 100 })).toEqual({ w: 148, h: 210 });
    const mm = layoutSlotMm("two-vertical", 0);
    expect(mm).not.toBeNull();
    expect(layoutSlotMm("nope", 0)).toBeNull();
    expect(layoutSlotMm("full-page", 3)).toBeNull();
  });

  it("dpi uses the limiting axis after cover-fit", () => {
    // full page 148×210: 3000 px wide → 514.9 dpi, 4000 px tall → 483.8 → limiting = height
    const dpi = effectiveDpi(3000, 4000, 148, 210) as number;
    expect(dpi).toBeCloseTo(4000 / (210 / 25.4));
    // landscape photo on a portrait page: height limits strongly
    expect(effectiveDpi(4000, 3000, 148, 210)).toBeCloseTo(3000 / (210 / 25.4));
  });

  it("zoom divides the dpi", () => {
    const d1 = effectiveDpi(3000, 4000, 148, 210, 1) as number;
    expect(effectiveDpi(3000, 4000, 148, 210, 2)).toBeCloseTo(d1 / 2);
    expect(effectiveDpi(3000, 4000, 148, 210, 4)).toBeCloseTo(d1 / 4);
    expect(effectiveDpi(3000, 4000, 148, 210, 99)).toBeCloseTo(d1 / 4);
  });

  it("150 dpi threshold", () => {
    expect(LOW_RES_DPI).toBe(150);
    expect(isLowRes(149.99)).toBe(true);
    expect(isLowRes(150)).toBe(false);
    expect(isLowRes(null)).toBe(false);
    // exactly 150 dpi on full page height: 210 mm → 1240.16 px
    const px = Math.ceil((210 / 25.4) * 150);
    expect(isLowRes(effectiveDpi(px, px, 148, 210))).toBe(false);
    expect(isLowRes(effectiveDpi(px - 2, px - 2, 148, 210))).toBe(true);
  });

  it("isSlotLowRes: 1600 px web-size photo full page is low-res, a 12 MP original is not", () => {
    expect(isSlotLowRes({ width: 1200, height: 1600 }, "full-page", 0)).toBe(false); // 193 dpi
    expect(isSlotLowRes({ width: 900, height: 1200 }, "full-page", 0)).toBe(true); // 145 dpi
    expect(isSlotLowRes({ width: 3000, height: 4000 }, "full-page", 0, 3)).toBe(false); // 161 dpi
    expect(isSlotLowRes({ width: 3000, height: 4000 }, "full-page", 0, 4)).toBe(true); // 121 dpi
    expect(isSlotLowRes({ width: null, height: 4000 }, "full-page", 0)).toBe(false);
    expect(isSlotLowRes({ width: 3000, height: 4000 }, "nope", 0)).toBe(false);
  });
});

describe("fonts", () => {
  it("catalogue and css vars", () => {
    expect(CAPTION_FONTS).toEqual(["Inter", "Playfair", "Cairo", "Tajawal"]);
    expect(CAPTION_FONT_VARS.Cairo).toBe("--font-cairo");
    expect(CAPTION_FONT_VARS.Playfair).toBe("--font-playfair");
    expect(isCaptionFont("Tajawal")).toBe(true);
    expect(isCaptionFont("Comic Sans")).toBe(false);
  });

  it("default font by script and book language", () => {
    expect(defaultCaptionFont("أجمل ليلة")).toBe("Cairo");
    expect(defaultCaptionFont("Best night")).toBe("Playfair");
    expect(defaultCaptionFont("", "ar")).toBe("Cairo");
    expect(defaultCaptionFont("2026 🎉", "ar")).toBe("Cairo");
    expect(defaultCaptionFont("Eid", "ar")).toBe("Playfair");
    expect(defaultCaptionFont("", "en")).toBe("Playfair");
  });

  it("font-family always has an Arabic fallback", () => {
    expect(captionFontFamily("Playfair")).toBe("var(--font-playfair), var(--font-cairo), var(--font-tajawal), serif");
    expect(captionFontFamily("Tajawal")).toBe("var(--font-tajawal), var(--font-cairo), sans-serif");
    expect(captionFontFamily("Unknown")).toContain("var(--font-playfair)");
  });
});
