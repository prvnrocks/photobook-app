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

function inputTag(html: string, testId: string): string {
  const m = html.match(new RegExp(`<input[^>]*data-testid="${testId}"[^>]*>`));
  if (!m) throw new Error(`no input ${testId}`);
  return m[0];
}

describe("NewBookForm shape + style (M10b A12)", () => {
  const html = renderToStaticMarkup(<NewBookForm />);

  it("renders Portrait/Landscape and Modern/Classic as named radio groups in fieldsets", () => {
    expect(html).toContain("Page shape");
    expect(html).toContain("Design style");
    for (const id of ["format-A5_PORTRAIT", "format-A5_LANDSCAPE"]) {
      expect(inputTag(html, id)).toMatch(/type="radio"[^>]*name="format"/);
    }
    for (const id of ["style-modern", "style-classic"]) {
      expect(inputTag(html, id)).toMatch(/type="radio"[^>]*name="designStyle"/);
    }
    expect(html).not.toContain("style-geometric");
    expect(html).not.toContain("style-scrapbook");
  });

  it("defaults: Portrait + Modern (no occasion yet)", () => {
    expect(inputTag(html, "format-A5_PORTRAIT")).toContain("checked");
    expect(inputTag(html, "format-A5_LANDSCAPE")).not.toContain("checked");
    expect(inputTag(html, "style-modern")).toContain("checked");
    expect(inputTag(html, "style-classic")).not.toContain("checked");
  });

  it("each option has a visible label + described-by hint; previews are decorative", () => {
    for (const id of ["format-A5_PORTRAIT", "format-A5_LANDSCAPE", "style-modern", "style-classic"]) {
      const hint = inputTag(html, id).match(/aria-describedby="([^"]+)"/)?.[1];
      expect(hint).toBeTruthy();
      expect(html).toContain(`id="${hint}"`);
    }
    expect(html).toContain(">Portrait<");
    expect(html).toContain(">Landscape<");
    expect(html).toContain(">Modern<");
    expect(html).toContain(">Classic<");
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
