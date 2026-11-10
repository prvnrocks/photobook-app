import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EditorShell } from "@/components/editor/EditorShell";
import { devEditorData, devTransport } from "@/lib/editor/dev-fixture";
import {
  editorSpreads,
  pagesOfSpread,
  spreadAriaLabel,
  spreadAspectRatio,
  spreadCount,
  spreadCounterLabel,
  spreadOfPage,
  spreadOfPosition,
  spreadsFor,
  spreadToPosition,
  stepSpread,
  type EditorSpread,
} from "@/lib/editor/spreads";
import { flipLayout, flipPageKind } from "@/lib/viewer/pages";
import { visiblePages } from "@/lib/viewer/window";

// The editor registry → UpgradeSheet → UpgradeButton imports the upgrade server action (server-only).
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

/** The flipbook's spreads (cover + doc pages only) in editor shape, from flipLayout + visiblePages. */
function flipbookSpreads(d: number, endCard: boolean): EditorSpread[] {
  const layout = flipLayout(d, { endCard, spread: true });
  const out: EditorSpread[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < layout.count; i++) {
    const kinds = visiblePages(i, layout.count, true).map((v) => flipPageKind(layout, v));
    const key = JSON.stringify(kinds);
    if (seen.has(key)) continue;
    seen.add(key);
    if (kinds.some((k) => k.kind === "cover")) {
      out.push({ kind: "cover" });
      continue;
    }
    const pages = kinds.flatMap((k) => (k.kind === "page" ? [k.pageIdx] : []));
    if (pages.length === 0) continue; // end card / filler-only spread
    out.push({ kind: "pages", left: pages[0], right: pages[1] ?? null });
  }
  return out;
}

describe("editorSpreads", () => {
  it("cover alone, then pages paired [0,1], [2,3], …; odd last page alone on the left", () => {
    expect(spreadsFor(0)).toEqual([{ kind: "cover" }]);
    expect(spreadsFor(1)).toEqual([{ kind: "cover" }, { kind: "pages", left: 0, right: null }]);
    expect(spreadsFor(4)).toEqual([
      { kind: "cover" },
      { kind: "pages", left: 0, right: 1 },
      { kind: "pages", left: 2, right: 3 },
    ]);
    expect(spreadsFor(5).at(-1)).toEqual({ kind: "pages", left: 4, right: null });
    const doc = devEditorData("ok").doc;
    expect(editorSpreads(doc)).toEqual(spreadsFor(doc.pages.length));
  });

  for (const endCard of [false, true]) {
    it(`matches the flipbook's pairing (flipLayout, endCard ${endCard}) for 0–21 pages`, () => {
      for (let d = 0; d <= 21; d++) {
        expect(spreadsFor(d), `${d} pages`).toEqual(flipbookSpreads(d, endCard));
        expect(spreadCount(d)).toBe(spreadsFor(d).length);
      }
    });
  }

  it("spreadOfPage / spreadOfPosition / pagesOfSpread agree", () => {
    for (let d = 0; d <= 21; d++) {
      const spreads = spreadsFor(d);
      for (let p = 0; p < d; p++) {
        const s = spreadOfPage(p);
        const sp = spreads[s];
        expect(sp.kind).toBe("pages");
        if (sp.kind === "pages") expect([sp.left, sp.right]).toContain(p);
        expect(pagesOfSpread(s, d)).toContain(p);
        expect(spreadOfPosition(p)).toBe(s);
      }
    }
    expect(spreadOfPosition("cover")).toBe(0);
    expect(pagesOfSpread(0, 6)).toEqual([]);
    expect(pagesOfSpread(9, 6)).toEqual([]);
  });

  it("spreadToPosition lands on the left page; stepSpread clamps", () => {
    expect(spreadToPosition(0, 6)).toBe("cover");
    expect(spreadToPosition(1, 6)).toBe(0);
    expect(spreadToPosition(3, 6)).toBe(4);
    expect(spreadToPosition(99, 6)).toBe(4);
    expect(spreadToPosition(-2, 6)).toBe("cover");
    expect(spreadToPosition(1, 0)).toBe("cover");
    expect(stepSpread("cover", 1, 6)).toBe(0);
    expect(stepSpread(1, 1, 6)).toBe(2); // from the right page: next spread's left page
    expect(stepSpread(3, -1, 6)).toBe(0);
    expect(stepSpread(0, -1, 6)).toBe("cover");
    expect(stepSpread(5, 1, 6)).toBe(4);
    expect(stepSpread(6, 1, 7)).toBe(6);
  });

  it("labels and aspect", () => {
    expect(spreadCounterLabel(0, 6)).toBe("Cover · 6 pages");
    expect(spreadCounterLabel(0, 1)).toBe("Cover · 1 page");
    expect(spreadCounterLabel(1, 6)).toBe("1–2 / 6");
    expect(spreadCounterLabel(4, 7)).toBe("7 / 7");
    expect(spreadAriaLabel(0, 6)).toBe("Cover");
    expect(spreadAriaLabel(2, 6)).toBe("Pages 3–4 of 6");
    expect(spreadAriaLabel(4, 7)).toBe("Page 7 of 7");
    expect(spreadAspectRatio("A5_PORTRAIT")).toBe("296 / 210");
    expect(spreadAspectRatio("A5_LANDSCAPE")).toBe("420 / 148");
  });
});

describe("facing-pages editor (static render)", () => {
  const items = (html: string) => html.match(/data-testid="carousel-item"/g) ?? [];

  it("layout=spread: one slide per spread, cover alone, pages side by side with a fold", () => {
    const data = devEditorData("ok");
    const html = renderToStaticMarkup(<EditorShell data={data} transport={devTransport("ok")} layout="spread" />);
    expect(html).toContain('data-mode="spread"');
    expect(items(html).length).toBe(spreadCount(data.doc.pages.length));
    expect(html).toMatch(/data-testid="editor-spread" data-kind="cover"/);
    // Cover + spread 1 render pages (window 1): cover + pages 0 and 1.
    const pages = html.match(/data-testid="editor-page"/g) ?? [];
    expect(pages.length).toBe(3);
    expect(html).toMatch(/data-testid="spread-page" data-side="left" data-page-idx="0"/);
    expect(html).toMatch(/data-testid="spread-page" data-side="right" data-page-idx="1"/);
    expect(html).toContain('data-testid="spread-fold"');
    expect(html).toContain("aspect-ratio:296 / 210");
    expect(html).toContain("Cover · ");
    expect(html).toContain('aria-label="Next pages"');
    // Phones-only preview button is not part of the spread layout; the strip pairs thumbnails.
    expect(html).not.toContain('data-testid="view-spread"');
    expect(html).toMatch(/data-testid="page-strip" data-mode="spread"/);
    expect((html.match(/data-testid="strip-spread"/g) ?? []).length).toBe(spreadCount(data.doc.pages.length));
  });

  it("odd page count: the last spread has a blank right page", () => {
    const data = devEditorData("ok");
    const doc = { ...data.doc, pages: data.doc.pages.slice(0, 3) };
    const html = renderToStaticMarkup(<EditorShell data={{ ...data, doc }} transport={devTransport("ok")} layout="spread" />);
    expect(items(html).length).toBe(3);
    expect(html).toMatch(/data-testid="spread-blank" data-side="right"/);
  });

  it("landscape: spread aspect is two landscape pages", () => {
    const data = devEditorData("ok");
    const doc = { ...data.doc, format: "A5_LANDSCAPE" as const };
    const html = renderToStaticMarkup(<EditorShell data={{ ...data, doc }} transport={devTransport("ok")} layout="spread" />);
    expect(html).toContain("aspect-ratio:420 / 148");
  });

  it("default (server render) is the single-page phone layout with a View spread button", () => {
    const data = devEditorData("ok");
    const html = renderToStaticMarkup(<EditorShell data={data} transport={devTransport("ok")} />);
    expect(html).toContain('data-mode="single"');
    expect(items(html).length).toBe(data.doc.pages.length + 1);
    expect(html).toContain('data-testid="view-spread"');
    expect(html).not.toContain('data-testid="editor-spread"');
  });
});
