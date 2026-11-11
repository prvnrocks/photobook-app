// M10c T14: editor on shaped / tilted / framed slots — tap + drop targets (slotAt), selection
// outline, crop mask + crop maths parity with the render model, layout-picker diagrams, and the
// "Suggested" chip for a book-level AI background.

import type { DroppableContainer } from "@dnd-kit/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { cropTarget } from "@/components/editor/tools/crop-mode";
import { LayoutDiagram } from "@/components/editor/tools/layout-picker";
import { cropToStyle } from "@/lib/book/crop";
import { devSampleDoc, devSamplePhotos } from "@/lib/book/dev-sample";
import { setCrop } from "@/lib/book/edit-ops";
import { pageMm } from "@/lib/book/format";
import { pageRenderModel } from "@/lib/book/render";
import { paintOrder, photoRectOf, pointInSlot, slotAt, type Point } from "@/lib/book/slot-geometry";
import type { BookDoc, Layout, SlotShapeKind } from "@/lib/book/types";
import { isBookSuggested, isSuggested } from "@/lib/editor/background-picker";
import { panCrop, zoomCrop } from "@/lib/editor/crop-gesture";
import {
  cropMaskOf,
  cropMaskPath,
  diagramSlotLook,
  layoutPointFromClient,
  resolveSlotTap,
  slotCollision,
  slotOutline,
  type SlotHitContext,
} from "@/lib/editor/shaped-slots";
import { initEditorState } from "@/lib/editor/store";
import { CLASSIC_PORTRAIT_LAYOUTS, getLayout, LAYOUTS } from "@/lib/layouts";

const layout = (id: string): Layout => {
  const l = getLayout(id);
  if (!l) throw new Error(`missing layout ${id}`);
  return l;
};

/** First catalogue slot with shape `kind` (null if the catalogue has none). */
function slotWithShape(kind: SlotShapeKind): { layout: Layout; i: number } | null {
  for (const l of LAYOUTS) {
    const i = l.slots.findIndex((s) => s.shape?.kind === kind);
    if (i >= 0) return { layout: l, i };
  }
  return null;
}

/** A point (layout units) inside the bounding boxes of slots a and b where both shapes hit. */
function overlapPoint(l: Layout, a: number, b: number): Point | null {
  const sa = l.slots[a];
  const sb = l.slots[b];
  const x0 = Math.max(sa.x, sb.x) - 10;
  const x1 = Math.min(sa.x + sa.w, sb.x + sb.w) + 10;
  const y0 = Math.max(sa.y, sb.y) - 10;
  const y1 = Math.min(sa.y + sa.h, sb.y + sb.h) + 10;
  for (let x = x0; x <= x1; x += 0.5)
    for (let y = y0; y <= y1; y += 0.5) if (pointInSlot(l, a, { x, y }) && pointInSlot(l, b, { x, y })) return { x, y };
  return null;
}

// ---- tap + drop targets ----------------------------------------------------------------------

describe("layoutPointFromClient", () => {
  const rect = { left: 10, top: 20, width: 200, height: 400 };
  it("maps a client point to % of the page; right spread halves add 100", () => {
    expect(layoutPointFromClient(rect, { x: 110, y: 220 })).toEqual({ x: 50, y: 50 });
    expect(layoutPointFromClient(rect, { x: 110, y: 220 }, "left")).toEqual({ x: 50, y: 50 });
    expect(layoutPointFromClient(rect, { x: 60, y: 20 }, "right")).toEqual({ x: 125, y: 0 });
  });
  it("null for an empty box", () => {
    expect(layoutPointFromClient({ left: 0, top: 0, width: 0, height: 10 }, { x: 1, y: 1 })).toBeNull();
  });
});

describe("resolveSlotTap: the visible top slot where boxes overlap", () => {
  const l = layout("s-p-two-overlap");
  const [bottom, top] = paintOrder(l);
  const pt = overlapPoint(l, bottom, top)!;

  it("the sample layout really overlaps (tilted polaroids)", () => {
    expect(pt).not.toBeNull();
    expect(l.slots.some((s) => s.rotate)).toBe(true);
  });
  it("a tap that the lower slot's element received selects the top slot", () => {
    expect(resolveSlotTap(l, bottom, pt)).toBe(top);
    expect(resolveSlotTap(l, top, pt)).toBe(top);
    expect(slotAt(l, pt)).toBe(top);
  });
  it("no point (keyboard) or no slot under the point → the tapped slot", () => {
    expect(resolveSlotTap(l, bottom, null)).toBe(bottom);
    expect(resolveSlotTap(l, bottom, { x: -50, y: -50 })).toBe(bottom);
    expect(resolveSlotTap(undefined, 1, pt)).toBe(1);
  });
  it("a circle's bounding-box corner is not the circle", () => {
    const c = slotWithShape("circle");
    expect(c).not.toBeNull();
    const s = c!.layout.slots[c!.i];
    const corner = { x: s.x + s.w * 0.03, y: s.y + s.h * 0.03 };
    expect(pointInSlot(c!.layout, c!.i, corner)).toBe(false);
    expect(slotAt(c!.layout, corner)).not.toBe(c!.i);
    expect(slotAt(c!.layout, { x: s.x + s.w / 2, y: s.y + s.h / 2 })).toBe(c!.i);
  });
});

describe("slotCollision (dnd-kit): drop target = visible slot under the pointer", () => {
  const l = layout("s-p-two-overlap");
  const [bottom, top] = paintOrder(l);
  const pt = overlapPoint(l, bottom, top)!;
  const rect = { left: 0, top: 0, width: 148, height: 210 };
  const containers = l.slots.map((_, i) => ({ id: `0:${i}`, data: { current: { slotIdx: i } } })) as unknown as DroppableContainer[];
  const run = (ctx: SlotHitContext | null, pointer: { x: number; y: number } | null) =>
    slotCollision(() => ctx)({
      active: {} as never,
      collisionRect: { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 },
      droppableRects: new Map(),
      droppableContainers: containers,
      pointerCoordinates: pointer,
    });
  const client = (p: Point) => ({ x: (p.x / 100) * rect.width, y: (p.y / 100) * rect.height });

  it("overlap → the top slot, even though both bounding boxes contain the pointer", () => {
    expect(run({ layout: l, rect }, client(pt)).map((c) => c.id)).toEqual([`0:${top}`]);
  });
  it("no pointer, no context or empty page space → no collision", () => {
    expect(run({ layout: l, rect }, null)).toEqual([]);
    expect(run(null, client(pt))).toEqual([]);
    expect(run({ layout: l, rect }, { x: -5, y: -5 })).toEqual([]);
  });
  it("right spread half: pointer x maps to 100..200", () => {
    const sp = layout("s-p-spread-wall");
    const i = sp.slots.findIndex((s) => s.x >= 100);
    const s = sp.slots[i];
    const ctrs = sp.slots.map((_, k) => ({ id: `0:${k}`, data: { current: { slotIdx: k } } })) as unknown as DroppableContainer[];
    const out = slotCollision(() => ({ layout: sp, rect, side: "right" }))({
      active: {} as never,
      collisionRect: { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 },
      droppableRects: new Map(),
      droppableContainers: ctrs,
      pointerCoordinates: client({ x: s.x + s.w / 2 - 100, y: s.y + s.h / 2 }),
    });
    expect(out.map((c) => c.id)).toEqual([`0:${slotAt(sp, { x: s.x + s.w / 2, y: s.y + s.h / 2 })}`]);
  });
});

// ---- selection outline -----------------------------------------------------------------------

describe("slotOutline", () => {
  it("polygon shapes get an SVG outline; rect / round shapes use the inherited-radius ring", () => {
    const hex = slotWithShape("hexagon")!;
    const o = slotOutline(hex.layout.slots[hex.i]);
    expect(o).toEqual({ kind: "polygon", points: "25,0 75,0 100,50 75,100 25,100 0,50" });
    expect(slotOutline(slotWithShape("diamond")!.layout.slots[slotWithShape("diamond")!.i]).kind).toBe("polygon");
    expect(slotOutline(slotWithShape("circle")!.layout.slots[slotWithShape("circle")!.i])).toEqual({ kind: "box" });
    expect(slotOutline(layout("one-portrait").slots[0])).toEqual({ kind: "box" });
    expect(slotOutline(undefined)).toEqual({ kind: "box" });
  });
});

// ---- crop mask + crop maths ------------------------------------------------------------------

describe("cropMaskOf / cropMaskPath", () => {
  it("per shape", () => {
    const c = slotWithShape("circle")!;
    expect(cropMaskOf(c.layout, c.i)).toEqual({ kind: "ellipse" });
    const h = slotWithShape("hexagon")!;
    expect(cropMaskOf(h.layout, h.i).kind).toBe("polygon");
    const d = slotWithShape("diamond")!;
    expect(cropMaskOf(d.layout, d.i)).toEqual({ kind: "polygon", points: [[50, 0], [100, 50], [50, 100], [0, 50]] });
    // Plain rect (classic) and framed rect polaroids: the whole photo rect shows.
    expect(cropMaskOf(layout("one-portrait"), 0)).toEqual({ kind: "none" });
    expect(cropMaskOf(layout("s-p-one-polaroid"), 0)).toEqual({ kind: "none" });
    expect(cropMaskOf(undefined, 0)).toEqual({ kind: "none" });
  });
  it("rounded: radius in % of the photo rect per axis (frame band subtracted when framed)", () => {
    const base = layout("one-portrait");
    const rounded: Layout = { ...base, slots: [{ ...base.slots[0], shape: { kind: "rounded", r: 6 } }] };
    const page = pageMm(rounded.format);
    const m = cropMaskOf(rounded, 0);
    expect(m.kind).toBe("rounded");
    if (m.kind !== "rounded") return;
    expect(m.rx).toBeCloseTo((6 / ((base.slots[0].w / 100) * page.w)) * 100, 3);
    expect(m.ry).toBeCloseTo((6 / ((base.slots[0].h / 100) * page.h)) * 100, 3);
    const framed: Layout = { ...rounded, slots: [{ ...rounded.slots[0], frame: { kind: "border", mm: 6, hex: "#FFFFFF" } }] };
    expect(cropMaskOf(framed, 0)).toEqual({ kind: "none" }); // 6 − 6 mm band = square corners
  });
  it("paths stay in the 0..100 box", () => {
    expect(cropMaskPath({ kind: "none" })).toBeNull();
    expect(cropMaskPath({ kind: "ellipse" })).toMatch(/^M0,50 A50,50/);
    expect(cropMaskPath({ kind: "polygon", points: [[50, 0], [100, 50], [50, 100], [0, 50]] })).toBe("M50,0 L100,50 L50,100 L0,50 Z");
    expect(cropMaskPath({ kind: "rounded", rx: 10, ry: 5 })).toContain("A10,5 0 0,1 100,5");
  });
});

/** Minimal editor context for cropTarget on a sample doc. */
function cropCtx(doc: BookDoc, pageIdx: number, slotIdx: number) {
  const state = { ...initEditorState(doc, { page: pageIdx }), selection: { kind: "slot" as const, pageIdx, slotIdx } };
  return { state, photos: { web: devSamplePhotos() } } as unknown as Pick<EditorContextValue, "state" | "photos">;
}

describe("crop on shaped / framed / tilted slots matches the render model (screen + print)", () => {
  const cases: Array<{ sample: "geometric-portrait" | "scrapbook-portrait"; layoutId: string; note: string }> = [
    { sample: "geometric-portrait", layoutId: "g-p-two-circle", note: "circle" },
    { sample: "geometric-portrait", layoutId: "g-p-five-hex", note: "hexagon" },
    { sample: "geometric-portrait", layoutId: "g-p-three-diamond", note: "diamond" },
    { sample: "scrapbook-portrait", layoutId: "s-p-one-polaroid", note: "tilted polaroid (frame excluded)" },
    { sample: "scrapbook-portrait", layoutId: "s-p-two-overlap", note: "overlapping tilted polaroids" },
  ];
  for (const c of cases) {
    it(`${c.layoutId} (${c.note})`, () => {
      let doc = devSampleDoc(c.sample);
      const pageIdx = doc.pages.findIndex((p) => p.layout === c.layoutId && p.side !== "right");
      expect(pageIdx).toBeGreaterThanOrEqual(0);
      const l = layout(c.layoutId);
      for (let slotIdx = 0; slotIdx < l.slots.length; slotIdx++) {
        const t = cropTarget(cropCtx(doc, pageIdx, slotIdx))!;
        expect(t).not.toBeNull();
        // The panel crops the unrotated photo rect (photoRectOf), never the frame or the tilted box.
        const pr = photoRectOf(l, slotIdx, doc.format)!;
        const page = pageMm(doc.format);
        expect(t.frame.slotWmm).toBeCloseTo((pr.w / 100) * page.w, 6);
        expect(t.frame.slotHmm).toBeCloseTo((pr.h / 100) * page.h, 6);
        expect(t.mask).toEqual(cropMaskOf(l, slotIdx, doc.format));
        expect(t.rotate).toBe(l.slots[slotIdx].rotate ?? 0);

        // A pan + zoom in the panel, saved, renders exactly as the panel showed it.
        const crop = panCrop(t.frame, zoomCrop(t.frame, t.crop, 1.8), 0.12, -0.08);
        doc = setCrop(doc, pageIdx, slotIdx, crop);
        const shown = cropToStyle(t.frame.photoW, t.frame.photoH, t.frame.slotWmm, t.frame.slotHmm, doc.pages[pageIdx].slots[slotIdx].crop);
        for (const bleed of [false, true]) {
          const m = pageRenderModel(doc, pageIdx, devSamplePhotos(), "en", { bleed })!;
          const rs = m.slots.find((s) => s.index === slotIdx)!;
          const bleeds = bleed && (rs.rect.x !== l.slots[slotIdx].x || rs.rect.w !== l.slots[slotIdx].w || rs.rect.y !== l.slots[slotIdx].y || rs.rect.h !== l.slots[slotIdx].h);
          // Bleed-extended (edge polygon) slots crop their bigger print box, as every bleed slot always has.
          if (!bleeds) expect(rs.photo!.style).toEqual(shown);
        }
      }
    });
  }
});

// ---- layout-picker diagrams ------------------------------------------------------------------

describe("LayoutDiagram on M10c layouts", () => {
  it("classic layouts keep their plain markup (no shaped boxes)", () => {
    for (const l of CLASSIC_PORTRAIT_LAYOUTS) {
      expect(l.slots.every((_, i) => diagramSlotLook(l, i) === null)).toBe(true);
      expect(renderToStaticMarkup(<LayoutDiagram layout={l} />)).not.toContain("data-diagram-shaped");
    }
  });
  it("scrapbook: tilt + polaroid card with the photo inside", () => {
    const l = layout("s-p-one-polaroid");
    const look = diagramSlotLook(l, 0)!;
    expect(look.rotate).toBe(l.slots[0].rotate);
    const pr = photoRectOf(l, 0)!;
    expect(look.photo!.h).toBeCloseTo((pr.h / l.slots[0].h) * 100, 3);
    const html = renderToStaticMarkup(<LayoutDiagram layout={l} format={l.format} />);
    expect(html).toContain(`rotate(${l.slots[0].rotate}deg)`);
    expect(html).toContain('data-diagram-shaped="true"');
  });
  it("geometric: circles round, hexagons / diamonds clipped", () => {
    const c = slotWithShape("circle")!;
    expect(diagramSlotLook(c.layout, c.i)?.borderRadius).toBe("50%");
    const h = slotWithShape("hexagon")!;
    expect(diagramSlotLook(h.layout, h.i)?.clipPath).toBe("polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)");
    const html = renderToStaticMarkup(<LayoutDiagram layout={h.layout} format={h.layout.format} />);
    expect(html).toContain("clip-path:polygon(");
    expect(html.match(/data-diagram-box/g)?.length).toBe(h.layout.slots.length);
  });
  it("overlapping slots draw bottom → top (z), like the page", () => {
    const l = layout("s-p-two-overlap");
    const html = renderToStaticMarkup(<LayoutDiagram layout={l} format={l.format} />);
    const rotations = [...html.matchAll(/rotate\((-?[\d.]+)deg\)/g)].map((m) => Number(m[1]));
    expect(rotations).toEqual(paintOrder(l).map((i) => l.slots[i].rotate ?? 0).filter((r) => r !== 0));
  });
});

// ---- Suggested chip --------------------------------------------------------------------------

describe("Suggested chip: book-level AI background (style.backgroundSource, T11)", () => {
  const doc = devSampleDoc("scrapbook-portrait");
  const withSource = (src: "ai" | "user") => ({ ...doc, style: { ...doc.style, backgroundSource: src } }) as unknown as BookDoc;
  it("absent field → not suggested (today's docs)", () => {
    expect(isBookSuggested(doc)).toBe(false);
    expect(isSuggested(doc, 0, "book")).toBe(false);
    expect(isSuggested(doc, 0, "page")).toBe(false);
  });
  it("ai → suggested in Whole book, and on pages without their own background", () => {
    const ai = withSource("ai");
    expect(isSuggested(ai, null, "book")).toBe(true);
    expect(isSuggested(ai, 0, "book")).toBe(true);
    expect(isSuggested(ai, 0, "page")).toBe(true);
    const own = { ...ai, pages: ai.pages.map((p, i) => (i === 0 ? { ...p, background: { kind: "color" as const, hex: "#112233", source: "user" as const } } : p)) };
    expect(isSuggested(own, 0, "page")).toBe(false);
    expect(isSuggested(own, 0, "book")).toBe(true);
  });
  it("user → not suggested", () => {
    expect(isSuggested(withSource("user"), 0, "book")).toBe(false);
  });
});
