import { describe, expect, it } from "vitest";
import { LayoutSchema } from "@/lib/book/schema";
import type { Rect } from "@/lib/book/types";
import { COVER_LAYOUT_ID, getLayout, LAYOUT_IDS, LAYOUTS, layoutsByRole, PAGE_MM } from "@/lib/layouts";

const inside = (r: Rect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 100 && r.y + r.h <= 100;
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layout catalogue", () => {
  it("has unique ids and getLayout finds each", () => {
    expect(new Set(LAYOUT_IDS).size).toBe(LAYOUTS.length);
    for (const l of LAYOUTS) expect(getLayout(l.id)).toBe(l);
    expect(getLayout("nope")).toBeUndefined();
  });

  it("has a cover layout and at least one page layout per photo count 1..4", () => {
    expect(getLayout(COVER_LAYOUT_ID)?.role).toBe("cover");
    const counts = new Set(layoutsByRole("page").map((l) => l.photoCount));
    for (const n of [1, 2, 3, 4]) expect(counts.has(n)).toBe(true);
  });

  describe.each(LAYOUTS.map((l) => [l.id, l] as const))("%s", (_id, layout) => {
    it("matches LayoutSchema", () => {
      expect(LayoutSchema.safeParse(layout).success).toBe(true);
    });

    it("photoCount === slots.length === prefers.length", () => {
      expect(layout.slots.length).toBe(layout.photoCount);
      expect(layout.prefers.length).toBe(layout.photoCount);
    });

    it("slots lie within the page and do not overlap", () => {
      for (const s of layout.slots) expect(inside(s)).toBe(true);
      for (let i = 0; i < layout.slots.length; i++)
        for (let j = i + 1; j < layout.slots.length; j++)
          expect(overlaps(layout.slots[i], layout.slots[j])).toBe(false);
    });

    it("caption is inside the page and does not overlap slots", () => {
      if (!layout.caption) return;
      expect(inside(layout.caption)).toBe(true);
      for (const s of layout.slots) expect(overlaps(layout.caption, s)).toBe(false);
    });

    it("slot shape agrees with its orientation preference on an A5 page", () => {
      layout.slots.forEach((s, i) => {
        const ratio = (s.w * PAGE_MM.w) / (s.h * PAGE_MM.h);
        if (layout.prefers[i] === "portrait") expect(ratio).toBeLessThan(1);
        if (layout.prefers[i] === "landscape") expect(ratio).toBeGreaterThan(1);
      });
    });
  });
});
