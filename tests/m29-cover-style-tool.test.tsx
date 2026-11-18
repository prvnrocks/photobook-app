// M29 T7 — editor "Cover style" tool: options per theme × format, live cover thumbnails of the
// user's book, apply = one setCoverLayout edit = one undo step (photo/title/subtitle kept),
// read-only = hidden + no-op, toolbar placement (primary on the cover, never a 4th button), and the
// save path accepts every cover style (classic portrait M29 covers serialise as v2).
// No DOM environment: tap/undo/reload flows live in e2e/m29-cover-style.spec.ts.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { applyCoverStyle, CoverStylePanel, coverStyleTool } from "@/components/editor/tools/cover-style";
import { EDITOR_TOOLS, splitTools, visibleTools } from "@/components/editor/tools/registry";
import { serializeDoc } from "@/lib/book/doc-version";
import { devPreviewDoc, devPreviewPhotos } from "@/lib/book/dev-preview";
import { devSampleDoc, devSamplePhotos } from "@/lib/book/dev-sample";
import { setCover, setCoverLayout } from "@/lib/book/edit-ops";
import { SUPPORTED_DESIGN_STYLES } from "@/lib/book/book-design";
import { BOOK_FORMATS } from "@/lib/book/schema";
import { autoCoversFor, coverStylesFor, layoutsFor } from "@/lib/book/spreads";
import type { BookDoc, BookFormat, DesignStyle } from "@/lib/book/types";
import { validateEditorDoc } from "@/lib/book/validate-editor-doc";
import { coverStyleAvailable, coverStyleName, coverStyleOptions } from "@/lib/editor/cover-styles";
import { devEditorData } from "@/lib/editor/dev-fixture";
import { editorReducer, initEditorState, type EditorAction, type EditorSelection, type EditorState } from "@/lib/editor/store";
import { M29_COVERS } from "@/lib/layouts";

// The editor registry → UpgradeSheet → UpgradeButton imports the upgrade server action (server-only).
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

// M30 T1: styles with a layout catalogue (magazine / editorial are in DESIGN_STYLES before their layouts ship).
const DESIGNS = SUPPORTED_DESIGN_STYLES.flatMap((designStyle) => BOOK_FORMATS.map((format) => ({ format, designStyle })));
const key = (d: { format: BookFormat; designStyle: DesignStyle }) => `${d.designStyle}/${d.format}`;
const M29_IDS = new Set(M29_COVERS.map((l) => l.id));

/** A real sample book of that design (classic = the dev fixture, others = the M10c samples). */
function bookOf(format: BookFormat, style: DesignStyle): { doc: BookDoc; photos: ReturnType<typeof devPreviewPhotos> } {
  if (style === "classic" && format === "A5_PORTRAIT") return { doc: devPreviewDoc(format), photos: devPreviewPhotos() };
  if (style === "classic") {
    // devPreviewDoc("A5_LANDSCAPE") keeps portrait layouts (pre-M10b fixture): give it real
    // classic landscape layouts so the book is valid.
    let n = 1;
    const base = devPreviewDoc(format);
    const pages = layoutsFor(format, "classic", "page").slice(0, 4).map((l, i) => ({
      id: `pl${i}`,
      chapterId: null,
      layout: l.id,
      slots: l.slots.map(() => ({ photoId: `d${n++}`, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
      caption: null,
    }));
    return { doc: { ...base, cover: { ...base.cover, layout: autoCoversFor(format, "classic")[0].id }, pages }, photos: devPreviewPhotos() };
  }
  const orient = format === "A5_PORTRAIT" ? "portrait" : "landscape";
  return { doc: devSampleDoc(`${style}-${orient}` as Parameters<typeof devSampleDoc>[0]), photos: devSamplePhotos() };
}

/** A context backed by the real editor reducer: actions dispatch into `box.state`. */
function liveCtx(doc: BookDoc, opts: { readOnly?: boolean; selection?: EditorSelection; page?: "cover" | number } = {}) {
  const data = devEditorData("ok");
  const box: { state: EditorState } = {
    state: { ...initEditorState(doc, { readOnly: opts.readOnly, page: opts.page ?? "cover" }), selection: opts.selection ?? null },
  };
  const dispatch = (a: EditorAction) => (box.state = editorReducer(box.state, a));
  const ctx = {
    book: { ...data.book, maxPages: 20 },
    get state() {
      return box.state;
    },
    actions: {
      edit: (op: (d: BookDoc) => BookDoc, o = {}) => dispatch({ type: "apply", op, ...o }),
      undo: () => dispatch({ type: "undo" }),
      redo: () => dispatch({ type: "redo" }),
      goTo: vi.fn(),
      next: vi.fn(),
      prev: vi.fn(),
      select: vi.fn(),
      setReadOnly: vi.fn(),
      dismissError: vi.fn(),
      reset: vi.fn(),
    },
    photos: { photos: [], byId: new Map(), web: {}, thumbs: bookOf(doc.format, doc.style.designStyle ?? "classic").photos, idForUrl: () => undefined, reportBroken: () => {} },
    readOnly: opts.readOnly === true,
    save: { status: { kind: "idle" }, flush: vi.fn(), settle: vi.fn() },
    activeTool: null,
    openTool: vi.fn(),
    closeTool: vi.fn(),
  } as unknown as EditorContextValue;
  return { ctx, box };
}

const ids = (tools: { id: string }[]) => tools.map((t) => t.id);

describe("coverStyleOptions — every cover of the book's format + design style", () => {
  for (const d of DESIGNS) {
    it(`${key(d)}: = coverStylesFor, current marked once, previews keep photo/title/subtitle`, () => {
      const { doc } = bookOf(d.format, d.designStyle);
      expect(doc.format).toBe(d.format);
      expect(doc.style.designStyle ?? "classic").toBe(d.designStyle);
      const opts = coverStyleOptions(doc);
      expect(opts.map((o) => o.layout.id)).toEqual(coverStylesFor(d.format, d.designStyle).map((l) => l.id));
      // The new M29 styles are offered (the user may pick them; only the AI never does).
      expect(opts.some((o) => M29_IDS.has(o.layout.id)), "has M29 styles").toBe(true);
      expect(opts.length).toBeGreaterThan(autoCoversFor(d.format, d.designStyle).length);
      expect(opts.filter((o) => o.current).map((o) => o.layout.id)).toEqual([doc.cover.layout]);
      for (const o of opts) {
        expect(o.layout.role).toBe("cover");
        expect(o.layout.format).toBe(d.format);
        expect(o.layout.style).toBe(d.designStyle);
        expect(o.preview.cover).toEqual({ ...doc.cover, layout: o.layout.id });
        expect(o.preview.pages).toBe(doc.pages);
        if (o.current) expect(o.preview).toBe(doc);
      }
      expect(coverStyleAvailable(doc, "cover")).toBe(true);
      expect(coverStyleAvailable(doc, 0)).toBe(false);
    });
  }

  it("names in plain words: 'Cover: split' → 'Split', bare 'Cover' → 'Photo + title'", () => {
    expect(coverStyleName({ name: "Cover: split" })).toBe("Split");
    expect(coverStyleName({ name: "Cover: full-bleed photo + title plate" })).toBe("Full-bleed photo + title plate");
    expect(coverStyleName({ name: "Cover" })).toBe("Photo + title");
  });
});

describe("applying a cover style", () => {
  it("one tap = one undo step; photo, title and subtitle stay; undo restores the old cover", () => {
    const base = setCover(devPreviewDoc(), { title: "رحلتنا إلى العين", subtitle: "Abu Dhabi · 2026" });
    const { ctx, box } = liveCtx(base);
    const target = coverStyleOptions(base).find((o) => !o.current && M29_IDS.has(o.layout.id))!;
    applyCoverStyle(ctx, target.layout.id);
    expect(box.state.doc.cover).toEqual({ ...base.cover, layout: target.layout.id });
    expect(box.state.doc.pages).toBe(base.pages);
    expect(box.state.past).toHaveLength(1);
    expect(box.state.error).toBeNull();
    // A second style is a second step (no coalescing across taps).
    const other = coverStyleOptions(box.state.doc).find((o) => !o.current && o.layout.id !== base.cover.layout)!;
    applyCoverStyle(ctx, other.layout.id);
    expect(box.state.past).toHaveLength(2);
    ctx.actions.undo();
    expect(box.state.doc.cover.layout).toBe(target.layout.id);
    ctx.actions.undo();
    expect(box.state.doc).toBe(base);
    expect(box.state.page).toBe("cover");
  });

  it("the current style is a no-op (no undo entry)", () => {
    const base = devPreviewDoc();
    const { ctx, box } = liveCtx(base);
    applyCoverStyle(ctx, base.cover.layout);
    expect(box.state.doc).toBe(base);
    expect(box.state.past).toHaveLength(0);
  });

  it("read-only: no edit at all", () => {
    const base = devPreviewDoc();
    const { ctx, box } = liveCtx(base, { readOnly: true });
    const edit = vi.spyOn(ctx.actions, "edit");
    applyCoverStyle(ctx, coverStyleOptions(base).find((o) => !o.current)!.layout.id);
    expect(edit).not.toHaveBeenCalled();
    expect(box.state.doc).toBe(base);
  });

  it("a cover style of another design never applies (error, no undo entry)", () => {
    const base = devPreviewDoc();
    const { ctx, box } = liveCtx(base);
    applyCoverStyle(ctx, coverStylesFor("A5_PORTRAIT", "modern")[0].id);
    expect(box.state.doc).toBe(base);
    expect(box.state.error).toBe("layout_not_for_book");
  });
});

describe("toolbar placement", () => {
  it("cover, nothing selected: Cover style / Background / Pages + More (no 4th primary)", () => {
    const { ctx } = liveCtx(devPreviewDoc());
    const s = splitTools(visibleTools(EDITOR_TOOLS, ctx), ctx);
    expect(ids(s.primary)).toEqual(["cover-style", "background", "pages"]);
    expect(ids(s.more)).not.toContain("cover-style");
  });

  it("cover photo / title selected: Cover style behind More (or folded in when alone), ≤ 4 buttons", () => {
    for (const part of ["photo", "text"] as const) {
      const { ctx } = liveCtx(devPreviewDoc(), { selection: { kind: "cover", part } });
      const s = splitTools(visibleTools(EDITOR_TOOLS, ctx), ctx);
      expect([...ids(s.primary), ...ids(s.more)]).toContain("cover-style");
      expect(s.primary.length + (s.more.length ? 1 : 0)).toBeLessThanOrEqual(4);
      expect(ids(s.primary).slice(0, 1)).not.toEqual(["cover-style"]);
    }
  });

  it("not on inner pages; hidden when read-only", () => {
    const page = liveCtx(devPreviewDoc(), { page: 0 }).ctx;
    expect(ids(visibleTools(EDITOR_TOOLS, page))).not.toContain("cover-style");
    const ro = liveCtx(devPreviewDoc(), { readOnly: true }).ctx;
    expect(ids(visibleTools(EDITOR_TOOLS, ro))).not.toContain("cover-style");
    expect(coverStyleTool.editsDoc).not.toBe(false);
  });
});

describe("CoverStylePanel markup", () => {
  it("one live cover thumbnail per style (the user's title, dir=auto), current one pressed + check", () => {
    const base = setCover(devPreviewDoc(), { title: "رحلتنا إلى العين" });
    const { ctx } = liveCtx(base);
    const html = renderToStaticMarkup(<CoverStylePanel ctx={ctx} close={() => {}} />);
    const n = coverStylesFor(base.format, "classic").length;
    expect(html.match(/data-testid="cover-style-option"/g)).toHaveLength(n);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*data-layout-id="${base.cover.layout}"`));
    expect(html.split("رحلتنا إلى العين").length - 1).toBeGreaterThanOrEqual(n);
    expect(html).toContain('dir="auto"');
    expect(html).toContain("min-h-11");
  });

  it("read-only: options are disabled", () => {
    const { ctx } = liveCtx(devPreviewDoc(), { readOnly: true });
    const html = renderToStaticMarkup(<CoverStylePanel ctx={ctx} close={() => {}} />);
    expect(html.match(/data-testid="cover-style-option"/g)!.length).toBeGreaterThan(1);
    expect(html.match(/<button[^>]*disabled=""/g)!.length).toBe(html.match(/data-testid="cover-style-option"/g)!.length);
  });
});

describe("save path accepts every cover style", () => {
  for (const d of DESIGNS) {
    it(`${key(d)}: validateEditorDoc ok for each style; new classic portrait covers serialise as v2`, () => {
      const { doc } = bookOf(d.format, d.designStyle);
      const placed = [doc.cover.photoId, ...doc.pages.flatMap((p) => p.slots.map((s) => s.photoId))].filter((x): x is string => !!x);
      const photoIds = new Set(placed);
      for (const l of coverStylesFor(d.format, d.designStyle)) {
        const next = setCoverLayout(doc, l.id);
        const r = validateEditorDoc(JSON.parse(JSON.stringify(serializeDoc(next))), {
          photoIds,
          maxPages: 100,
          savedDoc: serializeDoc(doc),
          design: { format: d.format, designStyle: d.designStyle },
        });
        expect(r.ok, `${l.id}: ${r.ok ? "" : r.code}`).toBe(true);
        if (!r.ok) continue;
        expect(r.doc.cover.layout).toBe(l.id);
        if (d.format === "A5_PORTRAIT" && d.designStyle === "classic") {
          expect((serializeDoc(next) as { version: number }).version).toBe(M29_IDS.has(l.id) ? 2 : 1);
        }
      }
    });
  }
});
