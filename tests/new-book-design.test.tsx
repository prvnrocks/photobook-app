import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { ShapePreview, StylePreview } from "@/components/books/DesignPreview";
import { initEditorState } from "@/lib/editor/store";
import { devEditorData } from "@/lib/editor/dev-fixture";

vi.mock("@/app/books/actions", () => ({ createBookAction: vi.fn() }));
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

const { NewBookForm } = await import("@/components/books/NewBookForm");
const { PagesSheet } = await import("@/components/editor/tools/pages");

const STYLE_IDS = ["style-modern", "style-classic", "style-geometric", "style-scrapbook"];

function inputTag(html: string, testId: string): string {
  const m = html.match(new RegExp(`<input[^>]*data-testid="${testId}"[^>]*>`));
  if (!m) throw new Error(`no input ${testId}`);
  return m[0];
}

describe("NewBookForm shape + style (M10b A12)", () => {
  const html = renderToStaticMarkup(<NewBookForm />);

  it("renders Portrait/Landscape and all four styles as named radio groups in fieldsets", () => {
    expect(html).toContain("Page shape");
    expect(html).toContain("Design style");
    for (const id of ["format-A5_PORTRAIT", "format-A5_LANDSCAPE"]) {
      expect(inputTag(html, id)).toMatch(/type="radio"[^>]*name="format"/);
    }
    for (const id of STYLE_IDS) {
      expect(inputTag(html, id)).toMatch(/type="radio"[^>]*name="designStyle"/);
    }
    // Display order Modern, Classic, Geometric, Scrapbook; one 2-column grid (2×2 on phones).
    const at = STYLE_IDS.map((id) => html.indexOf(`data-testid="${id}"`));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    const grid = html.slice(html.lastIndexOf("<div", at[0]), at[0]);
    expect(grid).toMatch(/class="grid grid-cols-2/);
  });

  it("defaults: Portrait + Modern (no occasion yet)", () => {
    expect(inputTag(html, "format-A5_PORTRAIT")).toContain("checked");
    expect(inputTag(html, "format-A5_LANDSCAPE")).not.toContain("checked");
    expect(inputTag(html, "style-modern")).toContain("checked");
    for (const id of ["style-classic", "style-geometric", "style-scrapbook"]) expect(inputTag(html, id)).not.toContain("checked");
  });

  it("each option has a visible label + described-by hint; previews are decorative", () => {
    for (const id of ["format-A5_PORTRAIT", "format-A5_LANDSCAPE", ...STYLE_IDS]) {
      const hint = inputTag(html, id).match(/aria-describedby="([^"]+)"/)?.[1];
      expect(hint).toBeTruthy();
      expect(html).toContain(`id="${hint}"`);
    }
    expect(html).toContain(">Portrait<");
    expect(html).toContain(">Landscape<");
    expect(html).toContain(">Modern<");
    expect(html).toContain(">Classic<");
    expect(html).toContain(">Geometric<");
    expect(html).toContain(">Scrapbook<");
    expect(html).not.toMatch(/<svg(?![^>]*aria-hidden="true")/);
    // M11 T9 (D-063): the fixed-at-creation note describes both design fieldsets.
    expect(html).toContain("Set when the book is created — these two can&#x27;t be changed later.");
  });

  it("previews: the page box follows the shape", () => {
    const portrait = renderToStaticMarkup(<ShapePreview format="A5_PORTRAIT" />);
    const landscape = renderToStaticMarkup(<StylePreview style="classic" format="A5_LANDSCAPE" />);
    expect(portrait).toContain('width="31" height="45"');
    expect(landscape).toContain('width="45" height="31"');
  });

  it("geometric preview hints at diagonal band + circle + hexagon; scrapbook at a tilted polaroid + tape", () => {
    for (const format of ["A5_PORTRAIT", "A5_LANDSCAPE"] as const) {
      const geo = renderToStaticMarkup(<StylePreview style="geometric" format={format} />);
      expect(geo.match(/<polygon /g)?.length).toBe(2); // band + hexagon
      const points = [...geo.matchAll(/<polygon[^>]*points="([^"]+)"/g)].map((m) => m[1].split(" ").length);
      expect(points).toEqual([4, 6]); // diagonal band, hexagon
      expect(geo).toContain("<circle");
      const scrap = renderToStaticMarkup(<StylePreview style="scrapbook" format={format} />);
      expect(scrap).toMatch(/transform="rotate\(-5 /);
      expect(scrap).toMatch(/transform="rotate\(3 /);
      for (const svg of [geo, scrap]) {
        expect(svg).toMatch(/^<svg[^>]*aria-hidden="true"/);
        expect(svg).not.toContain("filter");
        expect(svg).not.toContain("NaN");
      }
    }
  });
});

describe("Editor shows the book design read-only (D-063)", () => {
  function ctxFor(designStyle: "classic" | "modern") {
    const data = devEditorData("ok");
    const doc = { ...data.doc, style: { ...data.doc.style, designStyle } };
    return {
      book: data.book,
      state: initEditorState(doc, {}),
      readOnly: false,
      actions: { edit: vi.fn(), undo: vi.fn(), goTo: vi.fn() },
      photos: { web: {}, thumbs: {} },
      activeTool: null,
      openTool: vi.fn(),
      closeTool: vi.fn(),
    } as unknown as EditorContextValue;
  }

  it("Pages sheet names shape · style, with no control to change it", () => {
    const html = renderToStaticMarkup(<PagesSheet ctx={ctxFor("classic")} close={() => {}} />);
    const label = html.match(/<p[^>]*data-testid="editor-book-design"[^>]*>(.*?)<\/p>/)?.[1] ?? "";
    expect(label).toContain("A5 Portrait · Classic");
    expect(label).not.toMatch(/<(button|input|select)/);
  });
});
