import { describe, expect, it } from "vitest";
import { fitBook } from "@/lib/viewer/fit";
import { inPhotoWindow, photoWindow, spreadStart, visiblePages } from "@/lib/viewer/window";

const ids = (w: ReturnType<typeof photoWindow>, count: number) =>
  Array.from({ length: count }, (_, i) => i).filter((i) => inPhotoWindow(w, i));

describe("visiblePages", () => {
  it("single page mode shows exactly the current page", () => {
    expect(visiblePages(0, 13, false)).toEqual([0]);
    expect(visiblePages(5, 13, false)).toEqual([5]);
  });
  it("spread mode: cover alone, then [odd, even] pairs", () => {
    expect(visiblePages(0, 13, true)).toEqual([0]);
    expect(visiblePages(1, 13, true)).toEqual([1, 2]);
    expect(visiblePages(2, 13, true)).toEqual([1, 2]);
    expect(visiblePages(12, 13, true)).toEqual([11, 12]);
  });
  it("spread mode: unpaired last page shows alone", () => {
    expect(visiblePages(13, 14, true)).toEqual([13]);
  });
  it("clamps out-of-range and non-finite indexes; empty book has nothing", () => {
    expect(visiblePages(99, 5, false)).toEqual([4]);
    expect(visiblePages(-3, 5, true)).toEqual([0]);
    expect(visiblePages(Number.NaN, 5, false)).toEqual([0]);
    expect(visiblePages(0, 0, true)).toEqual([]);
  });
});

describe("photoWindow", () => {
  it("phone: current ±2 = at most 5 pages, current has priority", () => {
    const w = photoWindow({ current: 5, count: 13, spread: false });
    expect(ids(w, 13)).toEqual([3, 4, 5, 6, 7]);
    expect(w.priority).toEqual([5]);
  });
  it("phone: clipped at the cover and at the end", () => {
    expect(ids(photoWindow({ current: 0, count: 13, spread: false }), 13)).toEqual([0, 1, 2]);
    expect(ids(photoWindow({ current: 12, count: 13, spread: false }), 13)).toEqual([10, 11, 12]);
  });
  it("spread: ±2 around the whole spread, both pages have priority", () => {
    const w = photoWindow({ current: 3, count: 13, spread: true });
    expect(ids(w, 13)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(w.priority).toEqual([3, 4]);
    // page-flip may report the right page; same window
    expect(photoWindow({ current: 4, count: 13, spread: true })).toEqual(w);
  });
  it("spread: cover window", () => {
    const w = photoWindow({ current: 0, count: 13, spread: true });
    expect(ids(w, 13)).toEqual([0, 1, 2]);
    expect(w.priority).toEqual([0]);
  });
  it("custom radius and empty book", () => {
    expect(ids(photoWindow({ current: 5, count: 13, spread: false, radius: 0 }), 13)).toEqual([5]);
    const empty = photoWindow({ current: 0, count: 0, spread: false });
    expect(empty.priority).toEqual([]);
    expect(inPhotoWindow(empty, 0)).toBe(false);
  });
  it("never more than 5 (phone) / 6 (spread) pages, anywhere in a 100-page book", () => {
    for (let c = 0; c < 101; c++) {
      expect(ids(photoWindow({ current: c, count: 101, spread: false }), 101).length).toBeLessThanOrEqual(5);
      expect(ids(photoWindow({ current: c, count: 101, spread: true }), 101).length).toBeLessThanOrEqual(6);
    }
  });
});

describe("spreadStart", () => {
  it("maps any page to the index page-flip reports", () => {
    expect(spreadStart(2, 13, true)).toBe(1);
    expect(spreadStart(1, 13, true)).toBe(1);
    expect(spreadStart(0, 13, true)).toBe(0);
    expect(spreadStart(2, 13, false)).toBe(2);
  });
});

describe("fitBook", () => {
  it("phone 375 wide: width-limited single page, A5 ratio", () => {
    expect(fitBook({ width: 351, height: 660 }, false)).toEqual({ width: 351, height: 498, pageWidth: 351 });
  });
  it("desktop: height-limited spread", () => {
    const b = fitBook({ width: 1256, height: 720 }, true)!;
    expect(b.pageWidth).toBe(507);
    expect(b.width).toBe(1014);
    expect(b.height).toBeLessThanOrEqual(720);
  });
  it("never exceeds the available box", () => {
    for (const [w, h, s] of [[320, 200, false], [844, 300, true], [1920, 1000, true]] as const) {
      const b = fitBook({ width: w, height: h }, s)!;
      expect(b.width).toBeLessThanOrEqual(w);
      expect(b.height).toBeLessThanOrEqual(h + 0.5);
    }
  });
  it("too small / unmeasured → null", () => {
    expect(fitBook({ width: 0, height: 0 }, false)).toBeNull();
  });
});
