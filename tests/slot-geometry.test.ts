// M10c T1: layout schema fields for shaped / tilted / framed slots + decorations, and the shared
// slot geometry helper (src/lib/book/slot-geometry.ts).

import { describe, expect, it } from "vitest";
import { bleedRect, spreadBleedRect } from "@/lib/book/bleed";
import { pageMm } from "@/lib/book/format";
import { ACCENT_STICKER_ID, LayoutSchema, layoutIssues, makeLayoutSchema } from "@/lib/book/schema";
import {
  clipPathFor,
  extendIntoBleed,
  paintOrder,
  photoRectOf,
  pointInPolygon,
  pointInSlot,
  polygonInPage,
  rotatedBoundsPct,
  SHAPE_POLYGONS,
  slotAt,
  type Point,
} from "@/lib/book/slot-geometry";
import type { Layout, LayoutSlotDef, Rect } from "@/lib/book/types";
import { LAYOUTS } from "@/lib/layouts";
import { GEOMETRIC_LANDSCAPE_LAYOUTS } from "@/lib/layouts/geometric/landscape";
import { GEOMETRIC_PORTRAIT_LAYOUTS } from "@/lib/layouts/geometric/portrait";
import { SCRAPBOOK_LANDSCAPE_LAYOUTS } from "@/lib/layouts/scrapbook/landscape";
import { SCRAPBOOK_PORTRAIT_LAYOUTS } from "@/lib/layouts/scrapbook/portrait";

const PORTRAIT = pageMm("A5_PORTRAIT"); // 148 × 210
const LANDSCAPE = pageMm("A5_LANDSCAPE"); // 210 × 148

function page(slots: LayoutSlotDef[], extra: Partial<Layout> = {}): Layout {
  return {
    id: "t-geo",
    name: "test",
    role: "page",
    style: "geometric",
    format: "A5_PORTRAIT",
    photoCount: slots.length,
    prefers: slots.map(() => "any" as const),
    slots,
    caption: null,
    ...extra,
  };
}

function spread(slots: LayoutSlotDef[], extra: Partial<Layout> = {}): Layout {
  return page(slots, { id: "t-geo-spread", role: "spread", twin: ["t-a", "t-b"], ...extra });
}

/** Parses `polygon(a% b%, …)` relative to `render` back to layout units. */
function polygonPoints(css: string, render: Rect): Point[] {
  const m = /^polygon\((.*)\)$/.exec(css);
  if (!m) throw new Error(`not a polygon: ${css}`);
  return m[1].split(", ").map((pair) => {
    const [x, y] = pair.split(" ").map((v) => parseFloat(v));
    return { x: render.x + (x / 100) * render.w, y: render.y + (y / 100) * render.h };
  });
}

/** Distance (layout units) of `p` from the infinite line through a, b. */
function lineDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / Math.hypot(dx, dy);
}

describe("photoRectOf: slot minus frame inset", () => {
  it("returns the slot's own numbers when unframed (byte-identical render)", () => {
    const l = page([{ x: 12.3456, y: 7.1, w: 40.25, h: 33.3333 }]);
    expect(photoRectOf(l, 0)).toEqual({ x: 12.3456, y: 7.1, w: 40.25, h: 33.3333 });
    expect(photoRectOf(page([{ x: 1, y: 2, w: 3, h: 4, frame: { kind: "none" } }]), 0)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(photoRectOf(l, 1)).toBeNull();
  });

  it("insets a border evenly in mm on the layout's format", () => {
    const l = page([{ x: 10, y: 10, w: 50, h: 40, frame: { kind: "border", mm: 3, hex: "#FFFFFF" } }]);
    const r = photoRectOf(l, 0)!;
    expect(r.x).toBeCloseTo(10 + (3 / 148) * 100, 9);
    expect(r.y).toBeCloseTo(10 + (3 / 210) * 100, 9);
    expect((r.w / 100) * PORTRAIT.w).toBeCloseTo(0.5 * 148 - 6, 9);
    expect((r.h / 100) * PORTRAIT.h).toBeCloseTo(0.4 * 210 - 6, 9);
  });

  it("polaroid: side on left/top/right, bigger bottom; format override uses that page", () => {
    const slot: LayoutSlotDef = { x: 20, y: 20, w: 40, h: 50, frame: { kind: "polaroid", side: 4, bottom: 14 } };
    const r = photoRectOf(page([slot]), 0)!;
    const topMm = ((r.y - 20) / 100) * 210;
    const bottomMm = ((20 + 50 - (r.y + r.h)) / 100) * 210;
    expect(topMm).toBeCloseTo(4, 9);
    expect(bottomMm).toBeCloseTo(14, 9);
    expect(((r.x - 20) / 100) * 148).toBeCloseTo(4, 9);
    const land = photoRectOf(page([slot]), 0, "A5_LANDSCAPE")!;
    expect(((land.x - 20) / 100) * LANDSCAPE.w).toBeCloseTo(4, 9);
    expect(((20 + 50 - (land.y + land.h)) / 100) * LANDSCAPE.h).toBeCloseTo(14, 9);
  });

  it("works in spread units (x per page width, right page 100..200)", () => {
    const l = spread([{ x: 120, y: 10, w: 50, h: 50, frame: { kind: "border", mm: 2, hex: "#000000" } }]);
    const r = photoRectOf(l, 0)!;
    expect(r.x).toBeCloseTo(120 + (2 / 148) * 100, 9);
  });
});

describe("clipPathFor", () => {
  const slot: Rect = { x: 10, y: 10, w: 40, h: 30 };

  it("no clip for rect / absent shape", () => {
    expect(clipPathFor(undefined, slot, slot, PORTRAIT)).toBeUndefined();
    expect(clipPathFor({ kind: "rect" }, slot, slot, PORTRAIT)).toBeUndefined();
  });

  it("ellipse / circle inscribed in the slot, positioned in page space inside a bigger render box", () => {
    expect(clipPathFor({ kind: "ellipse" }, slot, slot, PORTRAIT)).toBe("ellipse(50% 50% at 50% 50%)");
    const render: Rect = { x: 0, y: 0, w: 80, h: 60 };
    expect(clipPathFor({ kind: "circle" }, slot, render, PORTRAIT)).toBe("ellipse(25% 25% at 37.5% 41.6667%)");
  });

  it("rounded: inset with the mm radius as % of the render box on each axis", () => {
    const css = clipPathFor({ kind: "rounded", r: 4 }, slot, slot, PORTRAIT)!;
    const rx = (4 / (0.4 * 148)) * 100;
    const ry = (4 / (0.3 * 210)) * 100;
    expect(css).toBe(`inset(0% 0% 0% 0% round ${Math.round(rx * 1e4) / 1e4}% / ${Math.round(ry * 1e4) / 1e4}%)`);
    // Radius is clamped to half the short side.
    expect(clipPathFor({ kind: "rounded", r: 30 }, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }, PORTRAIT)).toContain(
      "round 50% / ",
    );
  });

  it("hexagon / diamond / polygon without bleed map their points onto the slot box", () => {
    expect(clipPathFor({ kind: "diamond" }, slot, slot, PORTRAIT)).toBe("polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)");
    expect(clipPathFor({ kind: "hexagon" }, slot, slot, PORTRAIT)).toBe(
      "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)",
    );
    expect(clipPathFor({ kind: "polygon", points: [[0, 0], [100, 0], [0, 100]] }, slot, slot, PORTRAIT)).toBe(
      "polygon(0% 0%, 100% 0%, 0% 100%)",
    );
  });

  describe("bleed-extended polygon keeps its page-space edges", () => {
    // A diagonal band bleeding off left, right and bottom; top edge diagonal (ref4-style).
    const fullBleed: Rect = { x: 0, y: 30, w: 100, h: 70 };
    const band = { kind: "polygon" as const, points: [[0, 20], [100, 0], [100, 100], [0, 100]] as [number, number][] };
    const render = bleedRect(fullBleed, PORTRAIT).pct;
    const clip = polygonPoints(clipPathFor(band, fullBleed, render, PORTRAIT)!, render);
    const orig = polygonInPage(band.points, fullBleed);

    it("the render box really is extended (left, right, bottom)", () => {
      expect(render.x).toBeLessThan(0);
      expect(render.x + render.w).toBeGreaterThan(100);
      expect(render.y).toBe(30);
      expect(render.y + render.h).toBeGreaterThan(100);
    });

    it("inside the trim the clipped shape equals the page-space polygon (dense sample)", () => {
      for (let x = 0.37; x < 100; x += 1.13) {
        for (let y = 0.29; y < 100; y += 0.97) {
          expect(pointInPolygon({ x, y }, clip), `(${x}, ${y})`).toBe(pointInPolygon({ x, y }, orig));
        }
      }
    });

    it("the diagonal top edge continues on its own line into the left and right bleed", () => {
      const [a, b] = [orig[0], orig[1]];
      const left = clip.find((p) => Math.abs(p.x - render.x) < 1e-6 && p.y < 60)!;
      const right = clip.find((p) => Math.abs(p.x - (render.x + render.w)) < 1e-6 && p.y < 60)!;
      expect(left).toBeDefined();
      expect(right).toBeDefined();
      expect(lineDistance(left, a, b)).toBeLessThan(1e-4); // CSS output has 4 decimals
      expect(lineDistance(right, a, b)).toBeLessThan(1e-4);
    });

    it("fills the bleed beside the shape and nowhere above its diagonal", () => {
      const bleedX = render.x / 2; // inside the left bleed
      expect(pointInPolygon({ x: bleedX, y: 80 }, clip)).toBe(true);
      expect(pointInPolygon({ x: 50, y: 100.5 }, clip)).toBe(true); // bottom bleed
      expect(pointInPolygon({ x: bleedX, y: 40 }, clip)).toBe(false); // above the band's top-left vertex (y 44)
      // Right bleed: the top edge meets the slot top (y 30) at x 100; the strip below it is filled.
      expect(pointInPolygon({ x: 100 + (render.x + render.w - 100) / 2, y: 30.5 }, clip)).toBe(true);
    });

    it("same result for the right page of a spread (spread units, no bleed at the fold)", () => {
      const s: Rect = { x: 100, y: 30, w: 100, h: 70 };
      const r = spreadBleedRect(s, PORTRAIT).pct;
      expect(r.x).toBe(100); // the fold side is not extended
      const pts = polygonPoints(clipPathFor(band, s, r, PORTRAIT)!, r);
      const o = polygonInPage(band.points, s);
      for (let x = 100.41; x < 200; x += 1.7) {
        for (let y = 30.3; y < 100; y += 1.3) expect(pointInPolygon({ x, y }, pts)).toBe(pointInPolygon({ x, y }, o));
      }
      expect(pointInPolygon({ x: 99.9, y: 80 }, pts)).toBe(false);
      expect(pointInPolygon({ x: 200.5, y: 80 }, pts)).toBe(true);
    });

    it("a diamond touching a trim edge at one vertex stays the same inside the trim", () => {
      const d: Rect = { x: 0, y: 20, w: 50, h: 40 };
      const r = bleedRect(d, PORTRAIT).pct;
      const pts = extendIntoBleed(polygonInPage(SHAPE_POLYGONS.diamond, d), d, r);
      const o = polygonInPage(SHAPE_POLYGONS.diamond, d);
      for (let x = 0.21; x < 50; x += 0.77) for (let y = 20.13; y < 60; y += 0.61) {
        expect(pointInPolygon({ x, y }, pts)).toBe(pointInPolygon({ x, y }, o));
      }
    });

    it("a full-slot polygon (rect corners) becomes the whole bleed box", () => {
      const s: Rect = { x: 0, y: 0, w: 100, h: 100 };
      const r = bleedRect(s, PORTRAIT).pct;
      expect(clipPathFor({ kind: "polygon", points: [[0, 0], [100, 0], [100, 100], [0, 100]] }, s, r, PORTRAIT)).toBe(
        "polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)",
      );
    });
  });
});

describe("pointInSlot / slotAt", () => {
  it("honours rotation (in mm, clockwise about the slot centre)", () => {
    const slot: LayoutSlotDef = { x: 30, y: 30, w: 40, h: 40, rotate: 10 };
    const l = page([slot]);
    // The unrotated top-left corner falls outside the clockwise-rotated slot …
    expect(pointInSlot(l, 0, { x: 30.3, y: 30.3 })).toBe(false);
    expect(pointInSlot(page([{ ...slot, rotate: undefined }]), 0, { x: 30.3, y: 30.3 })).toBe(true);
    // … while the rotated image of a point just inside that corner is inside.
    const rad = (10 * Math.PI) / 180;
    const cx = 0.5 * 148;
    const cy = 0.5 * 210;
    const lx = -0.2 * 148 + 0.5; // 0.5 mm in from the left edge
    const ly = -0.2 * 210 + 0.5;
    const px = cx + lx * Math.cos(rad) - ly * Math.sin(rad);
    const py = cy + lx * Math.sin(rad) + ly * Math.cos(rad);
    expect(pointInSlot(l, 0, { x: (px / 148) * 100, y: (py / 210) * 100 })).toBe(true);
    expect(pointInSlot(l, 0, { x: 50, y: 50 })).toBe(true);
    expect(pointInSlot(l, 1, { x: 50, y: 50 })).toBe(false);
  });

  it("honours shapes: circle, diamond, polygon, rounded corners", () => {
    const circle = page([{ x: 20, y: 20, w: 50, h: (50 * 148) / 210, shape: { kind: "circle" } }]);
    expect(pointInSlot(circle, 0, { x: 45, y: 20 + (25 * 148) / 210 })).toBe(true);
    expect(pointInSlot(circle, 0, { x: 20.5, y: 20.5 })).toBe(false);
    const diamond = page([{ x: 0, y: 0, w: 100, h: 100, shape: { kind: "diamond" } }]);
    expect(pointInSlot(diamond, 0, { x: 50, y: 50 })).toBe(true);
    expect(pointInSlot(diamond, 0, { x: 10, y: 10 })).toBe(false);
    const tri = page([{ x: 0, y: 0, w: 100, h: 100, shape: { kind: "polygon", points: [[0, 0], [100, 0], [0, 100]] } }]);
    expect(pointInSlot(tri, 0, { x: 20, y: 20 })).toBe(true);
    expect(pointInSlot(tri, 0, { x: 80, y: 80 })).toBe(false);
    const rounded = page([{ x: 10, y: 10, w: 50, h: 50, shape: { kind: "rounded", r: 10 } }]);
    expect(pointInSlot(rounded, 0, { x: 10.2, y: 10.2 })).toBe(false);
    expect(pointInSlot(rounded, 0, { x: 35, y: 10.2 })).toBe(true);
  });

  it("slotAt picks the top-most slot by z, ties by slot order", () => {
    const l = page([
      { x: 10, y: 10, w: 50, h: 50, z: 2 },
      { x: 30, y: 30, w: 50, h: 50 },
      { x: 40, y: 40, w: 10, h: 10, z: 2 },
    ]);
    expect(paintOrder(l)).toEqual([1, 0, 2]);
    expect(slotAt(l, { x: 35, y: 35 })).toBe(0); // 0 (z 2) over 1 (z 0)
    expect(slotAt(l, { x: 45, y: 45 })).toBe(2); // same z as 0, later in order
    expect(slotAt(l, { x: 70, y: 70 })).toBe(1);
    expect(slotAt(l, { x: 95, y: 5 })).toBeNull();
  });
});

describe("layout validation (M10c fields)", () => {
  const ok = (l: Layout) => expect(layoutIssues(l)).toEqual([]);
  const bad = (l: Layout, re: RegExp) => {
    expect(layoutIssues(l).join("\n")).toMatch(re);
    expect(LayoutSchema.safeParse(l).success).toBe(false);
  };

  it("accepts every field on a valid layout and keeps them after parsing", () => {
    const l = page(
      [
        { x: 10, y: 10, w: 40, h: 30, shape: { kind: "rounded", r: 3 }, rotate: -6, frame: { kind: "polaroid", side: 3, bottom: 10 }, shadow: "lifted", z: 1 },
        { x: 55, y: 45, w: 35, h: (35 * 148) / 210, shape: { kind: "circle" }, frame: { kind: "border", mm: 1.5, hex: "#FFFFFF" }, shadow: "soft" },
        { x: 0, y: 75, w: 100, h: 25, shape: { kind: "polygon", points: [[0, 30], [100, 0], [100, 100], [0, 100]] } },
      ],
      {
        decorations: [
          { kind: "tape", id: "tape-washi", box: { x: 20, y: 8, w: 15, h: 4 }, rotate: -30, layer: "over", tint: "#E9D9B6" },
          { kind: "sticker", id: ACCENT_STICKER_ID, box: { x: 70, y: 10, w: 12, h: 8 }, layer: "under" },
        ],
        texts: [{ bind: "dateLabel", box: { x: 55, y: 20, w: 35, h: 6 }, align: "center", font: "subtitle", plate: { id: "plate-label" }, rotate: 4 }],
      },
    );
    ok(l);
    const parsed = LayoutSchema.parse(l);
    expect(parsed.slots[0].frame).toEqual({ kind: "polaroid", side: 3, bottom: 10 });
    expect(parsed.decorations).toHaveLength(2);
    expect(parsed.texts![0].plate).toEqual({ id: "plate-label" });
  });

  it("rejects unknown keys on slots, decorations, shapes and frames, and out-of-range values", () => {
    const base = { x: 10, y: 10, w: 40, h: 30 };
    expect(LayoutSchema.safeParse(page([{ ...base, rotation: 5 } as LayoutSlotDef])).success).toBe(false);
    expect(LayoutSchema.safeParse(page([{ ...base, rotate: 13 }])).success).toBe(false);
    expect(LayoutSchema.safeParse(page([{ ...base, shape: { kind: "star" } } as unknown as LayoutSlotDef])).success).toBe(false);
    expect(LayoutSchema.safeParse(page([{ ...base, frame: { kind: "border", mm: 2 } } as unknown as LayoutSlotDef])).success).toBe(false);
    expect(LayoutSchema.safeParse(page([{ ...base, shape: { kind: "polygon", points: [[0, 0], [100, 0]] } }])).success).toBe(false);
    expect(LayoutSchema.safeParse(page([{ ...base, z: 1.5 }])).success).toBe(false);
    const deco = { kind: "sticker" as const, id: "star", box: { x: 10, y: 10, w: 5, h: 5 }, layer: "over" as const };
    expect(LayoutSchema.safeParse(page([base], { decorations: [deco] })).success).toBe(true);
    expect(LayoutSchema.safeParse(page([base], { decorations: [{ ...deco, extra: 1 } as typeof deco] })).success).toBe(false);
    expect(LayoutSchema.safeParse(page([base], { decorations: [{ ...deco, id: "../x.svg" }] })).success).toBe(false);
    expect(LayoutSchema.safeParse(page([base], { decorations: [{ ...deco, rotate: 181 }] })).success).toBe(false);
  });

  describe("safe zone: framed / rotated slots keep their rotated box ≥ 4 mm inside the trim", () => {
    // 4 mm = 2.7027 % of 148 mm.
    it("a plain slot may bleed; framed or rotated at the edge may not", () => {
      ok(page([{ x: 0, y: 0, w: 50, h: 50 }]));
      bad(page([{ x: 0, y: 10, w: 50, h: 50, frame: { kind: "border", mm: 2, hex: "#FFFFFF" } }]), /safe zone/);
      bad(page([{ x: 2, y: 10, w: 50, h: 50, rotate: 3 }]), /safe zone/);
    });

    it("measures the ROTATED bounding box in mm", () => {
      const slot: LayoutSlotDef = { x: 3, y: 30, w: 40, h: 40, frame: { kind: "border", mm: 1, hex: "#FFFFFF" } };
      ok(page([slot])); // 4.44 mm from the left edge
      bad(page([{ ...slot, rotate: 12 }]), /safe zone/); // the tilted corners reach past the edge
      const b = rotatedBoundsPct(slot, 12, PORTRAIT);
      expect((b.x0 / 100) * 148).toBeLessThan(0);
      ok(page([{ ...slot, x: 10, rotate: 12 }]));
      // Bottom / right edges too, and on landscape pages (4 mm of 148 mm height).
      bad(page([{ x: 50, y: 50, w: 48, h: 30, rotate: -5 }]), /safe zone/);
      bad(page([{ x: 10, y: 10, w: 30, h: 88, rotate: 2 }], { format: "A5_LANDSCAPE" }), /safe zone/);
    });

    it("spreads: the outer edges are x 0 and 200", () => {
      ok(spread([{ x: 150, y: 10, w: 40, h: 40, rotate: 5 }]));
      bad(spread([{ x: 160, y: 10, w: 39, h: 40, rotate: 5 }]), /safe zone/);
    });

    it("rotated / plated texts follow the same rule", () => {
      const text = { bind: "dateLabel" as const, box: { x: 1, y: 10, w: 30, h: 6 }, align: "center" as const, font: "subtitle" as const };
      ok(page([{ x: 10, y: 30, w: 50, h: 50 }], { texts: [text] })); // unplated: checked by the catalogue tests
      bad(page([{ x: 10, y: 30, w: 50, h: 50 }], { texts: [{ ...text, plate: { id: "plate-label" } }] }), /safe zone/);
      bad(page([{ x: 10, y: 30, w: 50, h: 50 }], { texts: [{ ...text, box: { ...text.box, x: 3 }, rotate: 12 }] }), /safe zone/);
    });

    it("decorations stay inside the trim (rotated box)", () => {
      const deco = { kind: "tape" as const, id: "tape-washi", box: { x: 0.5, y: 10, w: 20, h: 4 }, layer: "over" as const };
      ok(page([{ x: 10, y: 30, w: 50, h: 50 }], { decorations: [deco] }));
      const tall = { ...deco, box: { x: 0.5, y: 10, w: 4, h: 20 } };
      ok(page([{ x: 10, y: 30, w: 50, h: 50 }], { decorations: [tall] }));
      bad(page([{ x: 10, y: 30, w: 50, h: 50 }], { decorations: [{ ...tall, rotate: 40 }] }), /decoration 0: outside the trim/);
      bad(page([{ x: 10, y: 30, w: 50, h: 50 }], { decorations: [{ ...deco, box: { ...deco.box, x: 90 } }] }), /outside the trim/);
    });
  });

  it("rounded / circle / ellipse never touch the trim; polygons may (they bleed)", () => {
    bad(page([{ x: 0, y: 10, w: 50, h: 40, shape: { kind: "rounded", r: 3 } }]), /rounded slot touches the trim/);
    bad(page([{ x: 10, y: 0, w: 50, h: 40, shape: { kind: "ellipse" } }]), /ellipse slot touches the trim/);
    ok(page([{ x: 0, y: 0, w: 100, h: 60, shape: { kind: "polygon", points: [[0, 0], [100, 0], [100, 80], [0, 100]] } }]));
    ok(page([{ x: 0, y: 10, w: 50, h: 40, shape: { kind: "hexagon" } }]));
  });

  it("circle slots are square in mm; polaroid only on rect / rounded; the frame leaves a photo", () => {
    bad(page([{ x: 10, y: 10, w: 40, h: 40, shape: { kind: "circle" } }]), /not square/);
    ok(page([{ x: 10, y: 10, w: 40, h: (40 * 148) / 210, shape: { kind: "circle" } }]));
    bad(page([{ x: 10, y: 10, w: 40, h: 30, shape: { kind: "diamond" }, frame: { kind: "polaroid", side: 3, bottom: 8 } }]), /polaroid/);
    bad(page([{ x: 10, y: 10, w: 5, h: 30, frame: { kind: "border", mm: 3, hex: "#FFFFFF" } }]), /no photo area/);
  });

  describe("fold: nothing shaped, framed, rotated or decorative crosses x = 100 on a spread", () => {
    it("plain rects may cross (panorama), shaped ones may not", () => {
      ok(spread([{ x: 0, y: 0, w: 200, h: 100 }]));
      bad(spread([{ x: 80, y: 20, w: 40, h: (40 * 148) / 210, shape: { kind: "circle" } }]), /crosses the fold/);
      bad(spread([{ x: 0, y: 0, w: 120, h: 60, shape: { kind: "polygon", points: [[0, 0], [100, 0], [80, 100], [0, 100]] } }]), /crosses the fold/);
      bad(spread([{ x: 80, y: 20, w: 40, h: 30, frame: { kind: "border", mm: 2, hex: "#FFFFFF" } }]), /crosses the fold/);
      // Rotation alone can push the box over the fold.
      bad(spread([{ x: 60, y: 20, w: 39.5, h: 40, rotate: 8 }]), /crosses the fold/);
      ok(spread([{ x: 60, y: 20, w: 39.5, h: 40 }]));
      // Touching the fold from one side is fine.
      ok(spread([{ x: 0, y: 0, w: 100, h: 60, shape: { kind: "polygon", points: [[0, 0], [100, 0], [80, 100], [0, 100]] } }]));
    });

    it("decorations and plated texts may not cross either", () => {
      const deco = { kind: "tape" as const, id: "tape-washi", box: { x: 95, y: 10, w: 10, h: 4 }, layer: "over" as const };
      bad(spread([{ x: 0, y: 0, w: 200, h: 100 }], { decorations: [deco] }), /decoration 0: crosses the fold/);
      const text = { bind: "dateLabel" as const, box: { x: 90, y: 10, w: 20, h: 6 }, align: "center" as const, font: "subtitle" as const, plate: { id: "plate-label" } };
      bad(spread([{ x: 0, y: 30, w: 200, h: 70 }], { texts: [text] }), /text 0: plated text crosses the fold/);
    });
  });

  describe("sticker ids", () => {
    const deco = (id: string, kind: "sticker" | "tape" | "plate" = "sticker") => ({ kind, id, box: { x: 10, y: 10, w: 5, h: 5 }, layer: "over" as const });
    const ids = new Set(["star", "tape-washi", "plate-label"]);

    it("LayoutSchema checks the id format only; an injected id set checks existence", () => {
      const l = page([{ x: 10, y: 30, w: 50, h: 50 }], { decorations: [deco("no-such-sticker")] });
      expect(LayoutSchema.safeParse(l).success).toBe(true);
      expect(layoutIssues(l, { stickerIds: ids })).toEqual(['decoration 0: unknown sticker "no-such-sticker"']);
      expect(makeLayoutSchema({ stickerIds: ids }).safeParse(l).success).toBe(false);
      expect(layoutIssues(page([{ x: 10, y: 30, w: 50, h: 50 }], { decorations: [deco("star")] }), { stickerIds: ids })).toEqual([]);
    });

    it("the occasion accent is always accepted, as a sticker only", () => {
      const l = page([{ x: 10, y: 30, w: 50, h: 50 }], { decorations: [deco(ACCENT_STICKER_ID)] });
      expect(layoutIssues(l, { stickerIds: ids })).toEqual([]);
      expect(layoutIssues(page([{ x: 10, y: 30, w: 50, h: 50 }], { decorations: [deco(ACCENT_STICKER_ID, "tape")] })).join()).toMatch(
        /accent must be kind sticker/,
      );
    });

    it("stickerKinds also checks decoration kinds and that text plates are plates", () => {
      const kinds = new Map([["star", "sticker"], ["tape-washi", "tape"], ["plate-label", "plate"]] as const);
      const l = page([{ x: 10, y: 30, w: 50, h: 50 }], {
        decorations: [deco("star", "tape")],
        texts: [{ bind: "dateLabel", box: { x: 10, y: 10, w: 30, h: 6 }, align: "center", font: "subtitle", plate: { id: "star" } }],
      });
      expect(layoutIssues(l, { stickerKinds: kinds })).toEqual(['text 0: "star" is not a plate', 'decoration 0: "star" is not a tape']);
    });

    it("matches the sticker catalogue's placeholder id", async () => {
      const stickers = await import("@/lib/design/stickers");
      expect(ACCENT_STICKER_ID).toBe(stickers.OCCASION_ACCENT);
    });
  });
});

describe("catalogue", () => {
  it("every existing layout still parses, and parsing adds no keys (unchanged data)", () => {
    for (const l of LAYOUTS) {
      const r = LayoutSchema.safeParse(l);
      expect(r.success, l.id).toBe(true);
      expect(layoutIssues(l), l.id).toEqual([]);
      expect(r.data).toEqual(l);
    }
  });

  it("geometric / scrapbook lists are registered (empty until T5/T6)", () => {
    for (const list of [GEOMETRIC_PORTRAIT_LAYOUTS, GEOMETRIC_LANDSCAPE_LAYOUTS, SCRAPBOOK_PORTRAIT_LAYOUTS, SCRAPBOOK_LANDSCAPE_LAYOUTS]) {
      for (const l of list) expect(LAYOUTS).toContain(l);
    }
  });
});

describe("decoration rotation range (photo-corner sets)", async () => {
  const { LayoutDecorationSchema } = await import("@/lib/book/schema");
  const base = { kind: "sticker" as const, id: "photo-corner", box: { x: 10, y: 10, w: 5, h: 5 }, layer: "over" as const };
  it("accepts any turn within ±180 (corners at 0/90/180/-90 plus tilt), rejects beyond", () => {
    for (const r of [0, 45, -45, 90, 180, -90, 183 - 360, -177]) expect(LayoutDecorationSchema.safeParse({ ...base, rotate: r }).success).toBe(true);
    for (const r of [181, -181, 270, 360]) expect(LayoutDecorationSchema.safeParse({ ...base, rotate: r }).success).toBe(false);
  });
});
