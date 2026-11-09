import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EditorShell } from "@/components/editor/EditorShell";
import type { EditorContextValue } from "@/components/editor/editor-context";
import type { EditorPhotos } from "@/components/editor/usePhotoUrls";
import { cropTarget, CropPanel, cropTool } from "@/components/editor/tools/crop-mode";
import { LayoutPickerPanel, layoutPickerTool, layoutTargetPage } from "@/components/editor/tools/layout-picker";
import { LOW_RES_MESSAGE, slotIsLowRes } from "@/components/editor/tools/low-res-badge";
import { PhotoPickerPanel, photoPickerTool, pickerTarget } from "@/components/editor/tools/photo-picker";
import { visibleTools } from "@/components/editor/tools/registry";
import { cropToStyle, DEFAULT_CROP } from "@/lib/book/crop";
import { changeLayout, replacePhoto, setCrop } from "@/lib/book/edit-ops";
import { cropBoxStyle } from "@/lib/book/render";
import { layoutSlotMm } from "@/lib/book/resolution";
import { effectiveFocal, panCrop, pinchZoom, zoomCrop, type CropFrame } from "@/lib/editor/crop-gesture";
import { devEditorData, devTransport } from "@/lib/editor/dev-fixture";
import { defaultPickerTab, groupPickerPhotos, layoutChangeNotice } from "@/lib/editor/photo-picker";
import { initEditorState, type EditorPosition, type EditorSelection } from "@/lib/editor/store";
import type { EditorShellPhoto } from "@/lib/editor/types";
import { layoutsByRole } from "@/lib/layouts";

const data = devEditorData("ok");

function photosOf(list: EditorShellPhoto[]): EditorPhotos {
  const web: Record<string, { url: string; width: number | null; height: number | null }> = {};
  for (const p of list) if (p.webUrl) web[p.id] = { url: p.webUrl, width: p.width, height: p.height };
  return {
    photos: list,
    byId: new Map(list.map((p) => [p.id, p])),
    web,
    thumbs: web,
    idForUrl: () => undefined,
    reportBroken: () => {},
  };
}

function ctxWith(selection: EditorSelection, opts: { page?: EditorPosition; readOnly?: boolean; doc?: typeof data.doc } = {}): EditorContextValue {
  const doc = opts.doc ?? data.doc;
  const page = opts.page ?? (selection === null ? "cover" : selection.kind === "cover" ? "cover" : selection.pageIdx);
  const state = { ...initEditorState(doc, { readOnly: opts.readOnly, page }), selection };
  const noop = () => {};
  return {
    book: data.book,
    state,
    actions: { edit: noop, undo: noop, redo: noop, goTo: noop, next: noop, prev: noop, select: noop, setReadOnly: noop, dismissError: noop, reset: noop },
    photos: photosOf(data.photos),
    readOnly: opts.readOnly === true,
    activeTool: null,
    openTool: noop,
    closeTool: noop,
  } as unknown as EditorContextValue;
}

// ---- photo picker grouping ---------------------------------------------------------------------

describe("groupPickerPhotos", () => {
  it("splits fixture photos into in book (doc order) / not used / dropped", () => {
    const g = groupPickerPhotos(data.photos, data.doc);
    expect(g.inBook.map((p) => p.id)).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10", "d11", "d12"]);
    expect(g.notUsed.map((p) => p.id)).toEqual(["d13"]);
    expect(g.dropped.map((p) => p.id)).toEqual(["d14", "d15"]);
    expect(defaultPickerTab(g)).toBe("notUsed");
  });

  it("placement wins over AI status; removing puts a dropped photo back", () => {
    const placed = replacePhoto(data.doc, 2, 1, "d14");
    let g = groupPickerPhotos(data.photos, placed);
    expect(g.inBook.map((p) => p.id)).toContain("d14");
    expect(g.dropped.map((p) => p.id)).toEqual(["d15"]);
    g = groupPickerPhotos(data.photos, replacePhoto(placed, 2, 1, null));
    expect(g.dropped.map((p) => p.id)).toEqual(["d14", "d15"]);
  });

  it("skips doc ids without a photo row and lists the cover once", () => {
    const doc = { ...replacePhoto(data.doc, 2, 1, "gone"), cover: { ...data.doc.cover, photoId: "d1" } };
    const g = groupPickerPhotos(data.photos, doc);
    expect(g.inBook.map((p) => p.id).filter((id) => id === "d1")).toHaveLength(1);
    expect(g.inBook.map((p) => p.id)).not.toContain("gone");
    expect(g.notUsed.map((p) => p.id)).toEqual(["d0", "d13"]);
  });

  it("default tab falls back to dropped, then in book", () => {
    expect(defaultPickerTab({ inBook: [], notUsed: [], dropped: [data.photos[0]] })).toBe("dropped");
    expect(defaultPickerTab({ inBook: [], notUsed: [], dropped: [] })).toBe("inBook");
  });
});

describe("layoutChangeNotice", () => {
  const cap = { text: "x", font: "Cairo", align: "center" as const, source: "ai" as const };
  it("copy for photos / caption / both / nothing", () => {
    expect(layoutChangeNotice({ removedPhotoIds: ["a"], droppedCaption: null })).toBe("1 photo moved to Not used");
    expect(layoutChangeNotice({ removedPhotoIds: ["a", "b"], droppedCaption: null })).toBe("2 photos moved to Not used");
    expect(layoutChangeNotice({ removedPhotoIds: [], droppedCaption: cap })).toBe("Caption removed");
    expect(layoutChangeNotice({ removedPhotoIds: ["a"], droppedCaption: cap })).toBe("1 photo moved to Not used · caption removed");
    expect(layoutChangeNotice({ removedPhotoIds: [], droppedCaption: null })).toBeNull();
  });
  it("matches a real changeLayout (four-grid → full-page)", () => {
    const idx = data.doc.pages.findIndex((p) => p.layout === "four-grid");
    expect(layoutChangeNotice(changeLayout(data.doc, idx, "full-page"))).toBe("3 photos moved to Not used · caption removed");
  });
});

// ---- crop maths --------------------------------------------------------------------------------

describe("crop gesture maths", () => {
  // Landscape photo in a square slot: 150 % wide, 100 % tall at zoom 1.
  const f: CropFrame = { photoW: 1500, photoH: 1000, slotWmm: 100, slotHmm: 100 };

  it("effective focal point = stored one when reachable, clamped one otherwise", () => {
    expect(effectiveFocal(f, DEFAULT_CROP)).toEqual({ x: 0.5, y: 0.5 });
    expect(effectiveFocal(f, { x: 0, y: 0.5, zoom: 1 }).x).toBeCloseTo(1 / 3, 6);
  });

  it("pan moves the photo by exactly the dragged fraction of the slot", () => {
    const start = { x: 0.5, y: 0.5, zoom: 1 };
    const next = panCrop(f, start, 0.1, 0);
    expect(next.x).toBeCloseTo(0.5 - 0.1 / 1.5, 3);
    expect(next.y).toBe(0.5); // no slack vertically → unchanged
    const before = cropToStyle(1500, 1000, 100, 100, start);
    const after = cropToStyle(1500, 1000, 100, 100, next);
    expect(after.left - before.left).toBeCloseTo(10, 1);
  });

  it("pan clamps to the edge and never has a dead zone", () => {
    expect(panCrop(f, DEFAULT_CROP, 5, 0).x).toBeCloseTo(1 / 3, 3);
    expect(panCrop(f, DEFAULT_CROP, -5, 0).x).toBeCloseTo(2 / 3, 3);
    // Stored x = 0 shows as 1/3: a small drag left moves the photo immediately.
    expect(panCrop(f, { x: 0, y: 0.5, zoom: 1 }, -0.03, 0).x).toBeCloseTo(1 / 3 + 0.02, 3);
  });

  it("pan ignores non-finite deltas", () => {
    expect(panCrop(f, DEFAULT_CROP, Number.NaN, Number.POSITIVE_INFINITY)).toEqual(DEFAULT_CROP);
  });

  it("zoom keeps the visible centre and clamps to 1–4", () => {
    const c = zoomCrop(f, { x: 0.4, y: 0.5, zoom: 1 }, 2);
    expect(c.zoom).toBe(2);
    expect(c.x).toBeCloseTo(0.4, 4);
    expect(zoomCrop(f, DEFAULT_CROP, 9).zoom).toBe(4);
    expect(zoomCrop(f, DEFAULT_CROP, 0.2).zoom).toBe(1);
    // Zooming out pulls an edge focal point back into range.
    const edge = panCrop(f, { x: 0.5, y: 0.5, zoom: 3 }, 5, 5);
    const out = zoomCrop(f, edge, 1);
    expect(out.x).toBeCloseTo(1 / 3, 3);
    expect(out.y).toBe(0.5);
  });

  it("pinch scales with finger distance", () => {
    expect(pinchZoom(1, 100, 200)).toBe(2);
    expect(pinchZoom(2, 100, 50)).toBe(1);
    expect(pinchZoom(3, 100, 400)).toBe(4);
    expect(pinchZoom(2, 0, 50)).toBe(2);
  });
});

// ---- tools: visibility -------------------------------------------------------------------------

describe("photo tools visibility", () => {
  const tools = [photoPickerTool, cropTool, layoutPickerTool];
  const ids = (ctx: EditorContextValue) => visibleTools(tools, ctx).map((t) => t.id);

  it("slot with a photo: Replace, Crop, Layout (in that order)", () => {
    expect(ids(ctxWith({ kind: "slot", pageIdx: 0, slotIdx: 0 }))).toEqual(["replace", "crop", "layout"]);
  });
  it("empty slot: no Crop", () => {
    expect(ids(ctxWith({ kind: "slot", pageIdx: 2, slotIdx: 1 }))).toEqual(["replace", "layout"]);
  });
  it("cover photo: Replace only; cover text: none", () => {
    expect(ids(ctxWith({ kind: "cover", part: "photo" }))).toEqual(["replace"]);
    expect(ids(ctxWith({ kind: "cover", part: "text" }))).toEqual([]);
  });
  it("page-level Layout without selection, not on the cover; caption selection keeps Layout", () => {
    expect(ids(ctxWith(null, { page: 3 }))).toEqual(["layout"]);
    expect(ids(ctxWith(null, { page: "cover" }))).toEqual([]);
    expect(ids(ctxWith({ kind: "caption", pageIdx: 1 }))).toEqual(["layout"]);
  });
  it("read-only hides all three", () => {
    expect(ids(ctxWith({ kind: "slot", pageIdx: 0, slotIdx: 0 }, { readOnly: true }))).toEqual([]);
  });
  it("targets", () => {
    expect(pickerTarget(ctxWith({ kind: "slot", pageIdx: 2, slotIdx: 1 }))).toEqual({ kind: "slot", pageIdx: 2, slotIdx: 1, current: null });
    expect(pickerTarget(ctxWith({ kind: "cover", part: "photo" }))).toEqual({ kind: "cover", current: "d0" });
    expect(layoutTargetPage(ctxWith({ kind: "caption", pageIdx: 4 }))).toBe(4);
    expect(cropTarget(ctxWith({ kind: "slot", pageIdx: 0, slotIdx: 0 }))?.crop).toEqual({ x: 0.3, y: 0.5, zoom: 1.4 });
  });
});

// ---- render smoke ------------------------------------------------------------------------------

describe("photo tools render smoke", () => {
  const noop = () => {};

  it("PhotoPicker: tabs with counts, Not used first, remove option", () => {
    const ctx = ctxWith({ kind: "slot", pageIdx: 0, slotIdx: 0 });
    const html = renderToStaticMarkup(<PhotoPickerPanel ctx={ctx} close={noop} />);
    expect(html).toContain("In book <span");
    expect(html).toMatch(/Dropped by AI <span[^>]*>\(2\)/);
    expect(html).toMatch(/data-testid="picker-tab-notUsed"[^>]*>|aria-selected="true"[^>]*data-testid="picker-tab-notUsed"/);
    expect(html.match(/data-testid="picker-photo"/g)).toHaveLength(1);
    expect(html).toContain('data-photo-id="d13"');
    expect(html).toContain('data-testid="picker-remove"');
  });

  it("PhotoPicker: empty slot has no remove option; cover text renders nothing", () => {
    expect(renderToStaticMarkup(<PhotoPickerPanel ctx={ctxWith({ kind: "slot", pageIdx: 2, slotIdx: 1 })} close={noop} />)).not.toContain("picker-remove");
    expect(renderToStaticMarkup(<PhotoPickerPanel ctx={ctxWith({ kind: "cover", part: "text" })} close={noop} />)).toBe("");
    expect(renderToStaticMarkup(<PhotoPickerPanel ctx={ctxWith({ kind: "cover", part: "photo" })} close={noop} />)).toContain("Remove cover photo");
  });

  it("LayoutPicker: one diagram per page layout, no-caption layouts marked, current pressed", () => {
    const html = renderToStaticMarkup(<LayoutPickerPanel ctx={ctxWith({ kind: "slot", pageIdx: 0, slotIdx: 0 })} close={noop} />);
    const page = layoutsByRole("page");
    expect(html.match(/data-testid="layout-option"/g)).toHaveLength(page.length);
    expect(html.match(/data-testid="layout-no-caption"/g)).toHaveLength(page.filter((l) => !l.caption).length);
    expect(html.match(/data-testid="layout-diagram-caption"/g)).toHaveLength(page.filter((l) => l.caption).length);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-layout-id="full-page"/);
  });

  it("CropPanel: same cropToStyle box as BookPage, zoom slider at the slot zoom", () => {
    const ctx = ctxWith({ kind: "slot", pageIdx: 0, slotIdx: 0 });
    const html = renderToStaticMarkup(<CropPanel ctx={ctx} close={noop} />);
    const p = ctx.photos.web.d1!;
    const mm = layoutSlotMm("full-page", 0)!;
    const box = cropBoxStyle(cropToStyle(p.width!, p.height!, mm.w, mm.h, { x: 0.3, y: 0.5, zoom: 1.4 }));
    expect(html).toContain(`left:${box.left}`);
    expect(html).toContain(`width:${box.width}`);
    expect(html).toMatch(/value="1.4"[^>]*data-testid="crop-zoom"|data-testid="crop-zoom"[^>]*value="1.4"/);
    expect(html).toContain('data-testid="crop-done"');
    expect(html).toContain('data-testid="crop-reset"');
    expect(html).toContain('data-testid="crop-low-res"'); // d1 landscape bled full-page at 1.4× < 150 dpi
  });
});

describe("low-res badge", () => {
  it("slotIsLowRes uses original size, layout slot and zoom", () => {
    const byId = new Map(data.photos.map((p) => [p.id, p]));
    expect(slotIsLowRes(data.doc, 0, 0, byId)).toBe(true); // d1 1600×1067 full-page at 1.4×
    expect(slotIsLowRes(data.doc, "cover", 0, byId)).toBe(false);
    expect(slotIsLowRes(data.doc, 2, 1, byId)).toBe(false); // empty slot
    const fourGrid = data.doc.pages.findIndex((p) => p.layout === "four-grid");
    expect(slotIsLowRes(data.doc, fourGrid, 0, byId)).toBe(false);
    expect(slotIsLowRes(setCrop(data.doc, fourGrid, 0, { zoom: 4 }), fourGrid, 0, byId)).toBe(true);
    const unknown = new Map([["d1", { width: null, height: null }]]);
    expect(slotIsLowRes(data.doc, 0, 0, unknown)).toBe(false);
  });

  it("renders on low-res slots in the editor (never in read-only)", () => {
    const html = renderToStaticMarkup(<EditorShell data={data} transport={devTransport("ok")} />);
    expect(html).toContain('data-testid="low-res-badge"');
    expect(html).toContain(`aria-label="Low resolution: ${LOW_RES_MESSAGE}"`);
    const ro = renderToStaticMarkup(<EditorShell data={devEditorData("readonly")} transport={devTransport("readonly")} />);
    expect(ro).not.toContain("low-res-badge");
  });
});
