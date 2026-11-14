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

const { StepShape } = await import("@/components/books/wizard/StepShape");
const { StepStyle } = await import("@/components/books/wizard/StepStyle");
const { PagesSheet } = await import("@/components/editor/tools/pages");

const STYLE_IDS = ["style-modern", "style-classic", "style-geometric", "style-scrapbook"];

function inputTag(html: string, value: string): string {
  const m = html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`));
  if (!m) throw new Error(`no input ${value}`);
  return m[0];
}

// M19 (D-071): shape and style are wizard steps 3 and 4 (was the New book form, M10b A12).
describe("wizard shape + style steps (M10b A12 → M19)", () => {
  const shape = renderToStaticMarkup(<StepShape format={null} onFormat={() => {}} headlineId="h" />);
  const style = renderToStaticMarkup(
    <StepStyle designStyle="modern" format="A5_LANDSCAPE" onStyle={() => {}} headlineId="h" />,
  );

  it("renders Portrait/Landscape and all four styles as named radio groups in fieldsets", () => {
    for (const id of ["format-A5_PORTRAIT", "format-A5_LANDSCAPE"]) expect(shape).toContain(`data-testid="${id}"`);
    expect(inputTag(shape, "A5_PORTRAIT")).toMatch(/type="radio"[^>]*name="wizard-format"/);
    for (const id of STYLE_IDS) expect(style).toContain(`data-testid="${id}"`);
    for (const v of ["modern", "classic", "geometric", "scrapbook"]) {
      expect(inputTag(style, v)).toMatch(/type="radio"[^>]*name="wizard-designStyle"/);
    }
    // Display order Modern, Classic, Geometric, Scrapbook; one 2-column grid (2×2 also on phones).
    const at = STYLE_IDS.map((id) => style.indexOf(`data-testid="${id}"`));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(style).toMatch(/<fieldset[\s\S]*class="grid grid-cols-2/);
    expect(shape).toMatch(/<fieldset[\s\S]*class="grid grid-cols-2/);
  });

  it("no shape is preselected; the given style is checked", () => {
    expect(inputTag(shape, "A5_PORTRAIT")).not.toContain("checked");
    expect(inputTag(shape, "A5_LANDSCAPE")).not.toContain("checked");
    expect(inputTag(style, "modern")).toContain("checked");
    for (const v of ["classic", "geometric", "scrapbook"]) expect(inputTag(style, v)).not.toContain("checked");
  });

  it("each option has a visible label; previews are decorative and enlarged", () => {
    for (const label of [">Portrait<", ">Landscape<", ">Modern<", ">Classic<", ">Geometric<", ">Scrapbook<"]) {
      expect(shape + style).toContain(label);
    }
    expect(shape).toContain("148 × 210 mm");
    expect(shape + style).not.toMatch(/<svg(?![^>]*aria-hidden="true")/);
    // M19 polish: wizard cards use the "card" art (viewBox hugs the page, sized by height ~2/3 of the card).
    expect(shape).toContain('viewBox="14 7 36.5 50.5"');
    expect(shape).toContain("h-36 max-w-full sm:h-56");
    expect(shape).toContain("h-[6.5rem] max-w-full sm:h-40");
    expect(style).toContain("h-24 max-w-full sm:h-36");
    expect(style).toContain('viewBox="7 14 50.5 36.5"');
    // style previews are drawn in the chosen shape (landscape page box)
    expect(style).toContain('width="45" height="31"');
  });

  it("locked design shows only the current choice, read-only, with a note", () => {
    const locked = renderToStaticMarkup(<StepShape format="A5_LANDSCAPE" onFormat={() => {}} headlineId="h" locked />);
    expect(locked).toContain('data-testid="wizard-design-locked"');
    expect(locked).not.toContain('data-testid="format-A5_PORTRAIT"');
    expect(inputTag(locked, "A5_LANDSCAPE")).toMatch(/checked=""[^>]*readOnly=""|readOnly=""[^>]*checked=""/i);
  });

  it("card variant: warm palette photo tints + a photo motif; default look unchanged (M19 polish)", () => {
    for (const style of ["modern", "classic", "geometric", "scrapbook"] as const) {
      const card = renderToStaticMarkup(<StylePreview style={style} format="A5_PORTRAIT" variant="card" />);
      expect(card).not.toContain("fill-muted-foreground/35");
      expect(card).toMatch(/fill-success\/35|fill-warning-border|fill-success-border/);
      expect(card).not.toContain("NaN");
      const plain = renderToStaticMarkup(<StylePreview style={style} format="A5_PORTRAIT" />);
      expect(plain).toMatch(/^<svg viewBox="0 0 64 64"[^>]*class="size-16 shrink-0"/);
      expect(plain).toContain("fill-muted-foreground/35");
      expect(plain).not.toMatch(/fill-success|fill-warning-soft/);
    }
    expect(renderToStaticMarkup(<ShapePreview format="A5_LANDSCAPE" variant="card" />)).toContain("fill-warning-soft");
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
