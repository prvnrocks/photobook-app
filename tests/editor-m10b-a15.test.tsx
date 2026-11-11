// M10b A15 — editor UI for format/style-aware layouts and spreads: picker filtering + disabled
// state, unit-aware page helpers, spread-aware selection, page tools on spreads, new-caption font.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EditorContextValue } from "@/components/editor/editor-context";
import type { EditorToast } from "@/components/editor/EditorToast";
import { runAddPage } from "@/components/editor/tools/add-page";
import { LayoutDiagram, LayoutPickerPanel, layoutAppliedNotice } from "@/components/editor/tools/layout-picker";
import { PageMenu } from "@/components/editor/tools/page-menu";
import { PagesSheet } from "@/components/editor/tools/pages";
import { newCaptionFont, setCaption, type ChangeLayoutResult } from "@/lib/book/edit-ops";
import { devSampleDoc } from "@/lib/book/dev-sample";
import { layoutsFor } from "@/lib/book/spreads";
import type { BookDoc } from "@/lib/book/types";
import { devEditorData, withDevSampleBook } from "@/lib/editor/dev-fixture";
import { disabledReason, layoutOptions } from "@/lib/editor/layout-options";
import { movePageById, pageUnits, splitNotice, unitMoveTarget } from "@/lib/editor/pages";
import { editorReducer, initEditorState, sameUnit, type EditorAction, type EditorPosition, type EditorState } from "@/lib/editor/store";
import { layoutsByRole } from "@/lib/layouts";

vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
const toasts = vi.hoisted(() => [] as Array<Omit<EditorToast, "id">>);
vi.mock("@/components/editor/EditorToast", async (orig) => ({
  ...(await orig<typeof import("@/components/editor/EditorToast")>()),
  showEditorToast: (t: Omit<EditorToast, "id">) => {
    toasts.push(t);
    return toasts.length;
  },
}));

// Modern portrait sample: 0 one-band, 1 two-panel, 2–3 spread-mosaic, 4–5 panorama, 6–7 grid, 8… singles.
const modern = () => devSampleDoc("modern-portrait");
const classic = () => devEditorData("ok").doc;

function liveCtx(doc: BookDoc, opts: { page?: EditorPosition; maxPages?: number } = {}) {
  const box: { state: EditorState } = { state: initEditorState(doc, { page: opts.page }) };
  const dispatch = (a: EditorAction) => {
    box.state = editorReducer(box.state, a);
  };
  const ctx = {
    book: { ...devEditorData("ok").book, maxPages: opts.maxPages ?? 20 },
    get state() {
      return box.state;
    },
    readOnly: false,
    actions: {
      edit: (op: (d: BookDoc) => BookDoc, o = {}) => dispatch({ type: "apply", op, ...o }),
      undo: () => dispatch({ type: "undo" }),
      goTo: (page: EditorPosition) => dispatch({ type: "goTo", page }),
      select: (selection: EditorState["selection"]) => dispatch({ type: "select", selection }),
    },
    photos: { web: {}, thumbs: {} },
    activeTool: null,
    openTool: vi.fn(),
    closeTool: vi.fn(),
  } as unknown as EditorContextValue;
  return { ctx, box };
}

describe("layoutOptions — picker filtering", () => {
  it("offers only the book's format + style; spreads in their own group", () => {
    const d = modern();
    const o = layoutOptions(d, 0, 20);
    expect(o.pages.map((x) => x.layout.id)).toEqual(layoutsFor("A5_PORTRAIT", "modern", "page").map((l) => l.id));
    expect(o.spreads.map((x) => x.layout.id)).toEqual(layoutsFor("A5_PORTRAIT", "modern", "spread").map((l) => l.id));
    expect(o.spreads.length).toBeGreaterThan(0);
    for (const x of [...o.pages, ...o.spreads]) {
      expect(x.layout.format).toBe("A5_PORTRAIT");
      expect(x.layout.style).toBe("modern");
    }
    const land = layoutOptions(devSampleDoc("modern-landscape"), 0, 20);
    expect(land.pages.every((x) => x.layout.format === "A5_LANDSCAPE" && x.layout.style === "modern")).toBe(true);
  });

  it("classic portrait book: the classic page layouts, no spread group", () => {
    const o = layoutOptions(classic(), 0, 20);
    expect(o.pages.map((x) => x.layout.id)).toEqual(layoutsByRole("page").map((l) => l.id));
    expect(o.spreads).toEqual([]);
  });

  it("left page: spreads enabled; right single page: disabled 'Starts on a left page'", () => {
    const d = modern();
    expect(layoutOptions(d, 0, 20).spreads.every((x) => !x.disabled && x.reason === null)).toBe(true);
    const right = layoutOptions(d, 1, 20).spreads;
    expect(right.every((x) => x.disabled && x.reason === "Starts on a left page")).toBe(true);
    // Single layouts stay available on the right page.
    expect(layoutOptions(d, 1, 20).pages.some((x) => !x.disabled)).toBe(true);
  });

  it("either half of an existing spread: spreads enabled, current marked, photos counted on the spread", () => {
    const d = modern();
    for (const idx of [2, 3]) {
      const o = layoutOptions(d, idx, 20);
      expect(o.onSpread).toBe(true);
      expect(o.placed).toBe(d.pages[2].slots.length);
      expect(o.spreads.find((x) => x.current)?.layout.id).toBe("m-p-spread-mosaic");
      expect(o.spreads.every((x) => !x.disabled)).toBe(true);
    }
  });

  it("spread on the last page at the limit → disabled with a page-limit reason", () => {
    const d = modern();
    const last = d.pages.length - 1; // 14, even, single
    expect(last % 2).toBe(0);
    expect(layoutOptions(d, last, d.pages.length).spreads.every((x) => x.reason === "No room for another page")).toBe(true);
    expect(layoutOptions(d, last, 20).spreads.every((x) => !x.disabled)).toBe(true);
    expect(disabledReason("unknown_layout")).toBe("Not available here");
  });

  it("user captions on both pages → the spread needs a confirm listing the dropped caption", () => {
    let d = modern();
    d = setCaption(d, 0, "Left words");
    d = setCaption(d, 1, "Right words");
    const opt = layoutOptions(d, 0, 20).spreads.find((x) => x.layout.caption !== null);
    expect(opt).toBeDefined();
    const plan = opt!.plan;
    expect(plan.ok && plan.needsConfirm).toBe(true);
    if (plan.ok) expect(plan.droppedUserCaptions.map((c) => c.text)).toEqual(["Right words"]);
  });
});

describe("LayoutPickerPanel / LayoutDiagram render", () => {
  it("right page: spread options rendered disabled with the reason", () => {
    const { ctx } = liveCtx(modern(), { page: 1 });
    const html = renderToStaticMarkup(<LayoutPickerPanel ctx={ctx} close={() => {}} />);
    const n = layoutsFor("A5_PORTRAIT", "modern", "spread").length;
    expect(html.match(/data-testid="layout-spreads"/g)).toHaveLength(1);
    expect(html.match(/data-role="spread"[^>]*data-disabled="true"/g)).toHaveLength(n);
    expect(html.match(/Starts on a left page/g)?.length).toBeGreaterThanOrEqual(n);
    expect(html.match(/data-role="page"[^>]*data-disabled/g)).toBeNull();
  });

  it("left page: spread options enabled; spread half says '2-page spread'", () => {
    const left = renderToStaticMarkup(<LayoutPickerPanel ctx={liveCtx(modern(), { page: 0 }).ctx} close={() => {}} />);
    expect(left).not.toContain('data-disabled="true"');
    const half = renderToStaticMarkup(<LayoutPickerPanel ctx={liveCtx(modern(), { page: 3 }).ctx} close={() => {}} />);
    expect(half).toContain("on this 2-page spread");
    expect(half).toMatch(/aria-pressed="true"[^>]*data-layout-id="m-p-spread-mosaic"/);
  });

  it("spread diagram is two pages wide with a fold; slots at half x", () => {
    const grid = layoutsFor("A5_PORTRAIT", "modern", "spread")[0];
    const html = renderToStaticMarkup(<LayoutDiagram layout={grid} format="A5_PORTRAIT" />);
    expect(html).toContain("aspect-ratio:296 / 210");
    expect(html).toContain('data-testid="layout-diagram-fold"');
    const r = grid.slots[grid.slots.length - 1];
    expect(html).toContain(`left:${r.x / 2}%`);
    const land = renderToStaticMarkup(<LayoutDiagram layout={layoutsFor("A5_LANDSCAPE", "modern", "spread")[0]} format="A5_LANDSCAPE" />);
    expect(land).toContain("aspect-ratio:420 / 148");
  });

  it("sliced cover diagram draws its slices", () => {
    const cover = layoutsFor("A5_PORTRAIT", "modern", "cover").find((l) => l.slices);
    expect(cover).toBeDefined();
    const html = renderToStaticMarkup(<LayoutDiagram layout={cover!} />);
    expect(html.match(/data-diagram-box=""/g)).toHaveLength(cover!.slices!.length);
  });

  it("layoutAppliedNotice joins own split, lost photos and reflow splits", () => {
    const base = { removedPhotoIds: ["a"], droppedCaption: null, splitCount: 2 } as unknown as ChangeLayoutResult;
    expect(layoutAppliedNotice(base, true)).toBe(
      "Spread split into two pages · 1 photo moved to Not used · 2 spreads were split into single pages",
    );
    expect(layoutAppliedNotice({ ...base, removedPhotoIds: [], splitCount: 0 }, false)).toBeNull();
  });
});

describe("unit-aware page helpers", () => {
  it("pageUnits: a spread is one unit of 2", () => {
    const u = pageUnits(modern());
    expect(u.slice(0, 5).map((x) => [x.start, x.count])).toEqual([
      [0, 1],
      [1, 1],
      [2, 2],
      [4, 2],
      [6, 2],
    ]);
    expect(u.reduce((n, x) => n + x.count, 0)).toBe(modern().pages.length);
  });

  it("unitMoveTarget / movePageById: dragging a spread tile moves the pair intact", () => {
    const d = modern();
    // Mosaic (s2,s3) dropped on the panorama tile (s4) → after the panorama.
    const t = unitMoveTarget(d, "s2", "s5");
    expect(t).toEqual({ from: 2, to: 4 });
    const out = movePageById(d, "s2", "s4", 20);
    expect(out.pages.slice(2, 6).map((p) => p.layout)).toEqual([
      "m-p-spread-panorama",
      "m-p-spread-panorama",
      "m-p-spread-mosaic",
      "m-p-spread-mosaic",
    ]);
    expect(out.pages.length).toBe(d.pages.length);
    // Backward: grid (s6) onto the first page → lands at 0.
    expect(unitMoveTarget(d, "s7", "s0")).toEqual({ from: 6, to: 0 });
    expect(unitMoveTarget(d, "s2", "s3")).toBeNull();
    expect(unitMoveTarget(d, "nope", "s3")).toBeNull();
  });

  it("splitNotice", () => {
    expect(splitNotice(0)).toBeNull();
    expect(splitNotice(1)).toBe("A spread was split into two pages");
    expect(splitNotice(3)).toBe("3 spreads were split into single pages");
  });
});

describe("store: selecting either half selects the spread", () => {
  it("a right-half slot selects the left page's slot but keeps the right page shown", () => {
    const d = modern();
    expect(sameUnit(d, 2, 3)).toBe(true);
    expect(sameUnit(d, 1, 2)).toBe(false);
    let s = initEditorState(d, { page: 3 });
    s = editorReducer(s, { type: "select", selection: { kind: "slot", pageIdx: 2, slotIdx: 5 } });
    expect(s.page).toBe(3);
    expect(s.selection).toEqual({ kind: "slot", pageIdx: 2, slotIdx: 5 });
    // An edit that re-selects the slot also stays on the right half.
    s = editorReducer(s, { type: "apply", op: (x) => ({ ...x }), select: { kind: "slot", pageIdx: 2, slotIdx: 5 } });
    expect(s.page).toBe(3);
    expect(s.selection).not.toBeNull();
    // A different page still navigates.
    s = editorReducer(s, { type: "select", selection: { kind: "slot", pageIdx: 0, slotIdx: 0 } });
    expect(s.page).toBe(0);
  });
});

describe("page tools on spreads", () => {
  it("PageMenu on either half acts on the 2-page spread", () => {
    for (const page of [2, 3]) {
      const html = renderToStaticMarkup(<PageMenu ctx={liveCtx(modern(), { page }).ctx} close={() => {}} />);
      expect(html).toContain("Pages 3–4 of 15");
      expect(html).toContain("Delete pages 3–4");
    }
    expect(renderToStaticMarkup(<PageMenu ctx={liveCtx(modern(), { page: 1 }).ctx} close={() => {}} />)).toContain("Delete page 2");
  });

  it("Pages sheet: one 2-wide tile per spread", () => {
    const html = renderToStaticMarkup(<PagesSheet ctx={liveCtx(modern()).ctx} close={() => {}} />);
    expect(html.match(/data-testid="pages-tile"/g)).toHaveLength(pageUnits(modern()).length);
    expect(html.match(/data-spread="true"/g)).toHaveLength(3);
    expect(html).toContain("col-span-2");
  });

  it("Add page before a spread splits it, navigates to the new page, shows Undo; Undo restores", () => {
    const d = modern();
    const { ctx, box } = liveCtx(d, { page: 1 });
    runAddPage(ctx);
    expect(box.state.doc.pages.length).toBeGreaterThan(d.pages.length);
    expect(box.state.page).toBe(2);
    expect(box.state.doc.pages[3].layout).not.toBe("m-p-spread-mosaic");
    const toast = toasts.at(-1);
    expect(toast?.message).toMatch(/^(A spread was split into two pages|\d+ spreads were split into single pages)$/);
    expect(toast?.action?.label).toBe("Undo");
    toast?.action?.run();
    expect(box.state.doc).toBe(d);
  });
});

describe("new caption font follows the design style", () => {
  it("classic keeps Playfair / Cairo; modern gets Cormorant / Amiri", () => {
    const c = classic();
    expect(newCaptionFont(c, "Hello")).toBe("Playfair");
    expect(newCaptionFont(c, "مرحبا بكم")).toBe("Cairo");
    const m = modern();
    expect(newCaptionFont(m, "Hello")).toBe("Cormorant");
    expect(newCaptionFont(m, "مرحبا بكم")).toBe("Amiri");
    expect(newCaptionFont(m, "123", "ar")).toBe("Amiri");
  });

  it("setCaption: a new caption gets the style face; an existing caption keeps its font", () => {
    const m = modern();
    // Page 0 (m-p-one-band) has a caption area: clear it, then add a new user caption.
    const cleared = setCaption(m, 0, "");
    expect(cleared.pages[0].caption).toBeNull();
    expect(setCaption(cleared, 0, "Sunset walk").pages[0].caption?.font).toBe("Cormorant");
    expect(setCaption(cleared, 0, "غروب جميل").pages[0].caption?.font).toBe("Amiri");
    expect(setCaption(m, 0, "Changed").pages[0].caption?.font).toBe(m.pages[0].caption?.font);
    // Classic: exactly today's font (byte-identical classic docs).
    const c = classic();
    const ci = c.pages.findIndex((p) => layoutsByRole("page").find((l) => l.id === p.layout)?.caption);
    const cc = setCaption(c, ci, "");
    expect(setCaption(cc, ci, "Sunset walk").pages[ci].caption?.font).toBe("Playfair");
    expect(setCaption(cc, ci, "غروب جميل").pages[ci].caption?.font).toBe("Cairo");
  });
});

it("withDevSampleBook gives every placed photo a kept photo row", () => {
  const data = withDevSampleBook(devEditorData("ok"), "modern-portrait");
  const ids = new Set(data.photos.map((p) => p.id));
  for (const p of data.doc.pages) for (const s of p.slots) if (s.photoId) expect(ids.has(s.photoId)).toBe(true);
  expect(ids.has(data.doc.cover.photoId ?? "")).toBe(true);
});
