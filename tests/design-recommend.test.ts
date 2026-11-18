import { describe, expect, it } from "vitest";
import { OCCASIONS } from "@/lib/book/options";
import { DEFAULT_FORM_FORMAT, defaultStyleFor } from "@/lib/design/defaults";
import { recommendDesign } from "@/lib/design/recommend";

const L = { width: 1600, height: 1200 };
const P = { width: 1200, height: 1600 };
const S = { width: 1000, height: 1000 };
const many = <T,>(n: number, v: T): T[] => Array.from({ length: n }, () => v);
const format = (photos: { width: number | null; height: number | null }[]) => {
  const r = recommendDesign({ occasion: "travel", photos });
  return [r.format, r.formatReason];
};

describe("recommendDesign", () => {
  it("no photos → the default shape, reason no_photos", () => {
    expect(format([])).toEqual([DEFAULT_FORM_FORMAT, "no_photos"]);
    expect(DEFAULT_FORM_FORMAT).toBe("A5_PORTRAIT");
  });

  it("photos without a usable size are not counted", () => {
    const unknown = [
      { width: null, height: null },
      { width: 1600, height: null },
      { width: null, height: 1200 },
      { width: 0, height: 1200 },
      { width: 1600, height: 0 },
      { width: -5, height: 10 },
      { width: Number.NaN, height: 10 },
      { width: Number.POSITIVE_INFINITY, height: 10 },
    ];
    expect(format(unknown)).toEqual(["A5_PORTRAIT", "no_photos"]);
    // 1 measurable landscape photo among many unknown ones decides alone
    expect(format([...unknown, L])).toEqual(["A5_LANDSCAPE", "mostly_landscape"]);
    expect(format([...unknown, P])).toEqual(["A5_PORTRAIT", "mostly_portrait"]);
  });

  it("exactly 60 % is enough; just under is mixed", () => {
    expect(format([...many(6, L), ...many(4, P)])).toEqual(["A5_LANDSCAPE", "mostly_landscape"]);
    expect(format([...many(3, L), ...many(2, P)])).toEqual(["A5_LANDSCAPE", "mostly_landscape"]);
    expect(format([...many(6, P), ...many(4, L)])).toEqual(["A5_PORTRAIT", "mostly_portrait"]);
    expect(format([...many(59, L), ...many(41, P)])).toEqual(["A5_PORTRAIT", "mixed"]);
    expect(format([...many(59, P), ...many(41, L)])).toEqual(["A5_PORTRAIT", "mixed"]);
    expect(format([...many(5, L), ...many(5, P)])).toEqual(["A5_PORTRAIT", "mixed"]);
  });

  it("square and near-square photos count for neither side", () => {
    expect(format(many(10, S))).toEqual(["A5_PORTRAIT", "mixed"]);
    expect(format([{ width: 1050, height: 1000 }])).toEqual(["A5_PORTRAIT", "mixed"]); // ratio 1.05 is not > 1.05
    expect(format([{ width: 1051, height: 1000 }])).toEqual(["A5_LANDSCAPE", "mostly_landscape"]);
    expect(format([{ width: 1000, height: 1050 }])).toEqual(["A5_PORTRAIT", "mixed"]);
    expect(format([{ width: 1000, height: 1051 }])).toEqual(["A5_PORTRAIT", "mostly_portrait"]);
    // squares are in the denominator: 5 landscape of 10 known is not 60 %
    expect(format([...many(5, L), ...many(5, S)])).toEqual(["A5_PORTRAIT", "mixed"]);
    expect(format([...many(6, L), ...many(4, S)])).toEqual(["A5_LANDSCAPE", "mostly_landscape"]);
  });

  it("style is the occasion default, whatever the photos look like", () => {
    for (const occasion of [...OCCASIONS, null]) {
      for (const photos of [[], many(3, L), many(3, P)]) {
        const r = recommendDesign({ occasion, photos });
        expect(r.designStyle).toBe(defaultStyleFor(occasion));
        expect(r.styleReason).toBe("occasion_default");
      }
    }
    expect(recommendDesign({ occasion: "birthday", photos: [] }).designStyle).toBe("scrapbook");
    expect(recommendDesign({ occasion: null, photos: [] }).designStyle).toBe("modern");
  });

  it("is pure: the input is not changed and the result has exactly four fields", () => {
    const photos = [L, P, S];
    const copy = JSON.parse(JSON.stringify(photos));
    const r = recommendDesign({ occasion: "wedding", photos });
    expect(photos).toEqual(copy);
    expect(Object.keys(r).sort()).toEqual(["designStyle", "format", "formatReason", "styleReason"]);
  });
});
