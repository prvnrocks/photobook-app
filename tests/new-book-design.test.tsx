import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { ShapePreview, StylePreview } from "@/components/books/DesignPreview";
import { BOOK_COVER_PLACEHOLDER_ART, BookCoverPlaceholder } from "@/components/dashboard/book-cover-art";
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

const STYLES = ["modern", "classic", "geometric", "scrapbook", "magazine", "editorial"] as const;
const STYLE_IDS = STYLES.map((s) => `style-${s}`);

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

  it("renders Portrait/Landscape and all six styles as named radio groups in fieldsets", () => {
    for (const id of ["format-A5_PORTRAIT", "format-A5_LANDSCAPE"]) expect(shape).toContain(`data-testid="${id}"`);
    expect(inputTag(shape, "A5_PORTRAIT")).toMatch(/type="radio"[^>]*name="wizard-format"/);
    for (const id of STYLE_IDS) expect(style).toContain(`data-testid="${id}"`);
    for (const v of STYLES) {
      expect(inputTag(style, v)).toMatch(/type="radio"[^>]*name="wizard-designStyle"/);
    }
    // Display order Modern, Classic, Geometric, Scrapbook, Magazine, Editorial; one grid: 2 columns
    // on phones (2 × 3 at 375 px), 3 from sm (M30 T12). Cards keep ≥ 44 px (min-h-11) and may shrink.
    const at = STYLE_IDS.map((id) => style.indexOf(`data-testid="${id}"`));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(style).toMatch(/<fieldset class="min-w-0"[\s\S]*class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5"/);
    expect(style.match(/<label[^>]*class="[^"]*\bmin-h-11 min-w-0\b/g)).toHaveLength(6);
    expect(shape).toMatch(/<fieldset[\s\S]*class="grid grid-cols-2/);
  });

  it("no shape is preselected; the given style is checked", () => {
    expect(inputTag(shape, "A5_PORTRAIT")).not.toContain("checked");
    expect(inputTag(shape, "A5_LANDSCAPE")).not.toContain("checked");
    expect(inputTag(style, "modern")).toContain("checked");
    for (const v of STYLES.filter((v) => v !== "modern")) expect(inputTag(style, v)).not.toContain("checked");
  });

  it("each option has a visible label; previews are decorative and enlarged", () => {
    for (const label of [">Portrait<", ">Landscape<", ">Modern<", ">Classic<", ">Geometric<", ">Scrapbook<", ">Magazine<", ">Editorial<"]) {
      expect(shape + style).toContain(label);
    }
    expect(shape).toContain("148 × 210 mm");
    expect(shape + style).not.toMatch(/<svg(?![^>]*aria-hidden="true")/);
    // M20 T4: shape cards show a small 3D book per shape (one art box height, so labels line up)
    // with a "fits …" hint; style cards show a two-page spread in the "card" art (viewBox hugs the
    // page), sized by a reserved box per shape.
    expect(shape).toContain('class="ws-book" data-format="A5_PORTRAIT"');
    expect(shape).toContain('class="ws-book" data-format="A5_LANDSCAPE"');
    expect(shape.match(/ws-shape-art relative flex h-40 w-full/g)).toHaveLength(2);
    expect(shape).toContain("Fits phone photos");
    expect(shape).toContain("Fits landscapes");
    expect(shape).not.toContain("wizard-preview-title");
    expect(style).toContain('class="ws-spread-box" data-format="A5_LANDSCAPE"');
    // Two pages per style card, six styles (M30).
    expect(style.match(/ws-spread-page ws-spread-(left|right)/g)).toHaveLength(12);
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
    for (const style of STYLES) {
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

describe("Magazine + Editorial preview art (M30 T12)", () => {
  const FORMATS = ["A5_PORTRAIT", "A5_LANDSCAPE"] as const;
  const svg = (style: (typeof STYLES)[number], format: (typeof FORMATS)[number], variant: "default" | "card" = "card") =>
    renderToStaticMarkup(<StylePreview style={style} format={format} variant={variant} />);

  it("each of the six styles has its own art (none falls back to Classic)", () => {
    for (const format of FORMATS) {
      for (const variant of ["default", "card"] as const) {
        const all = STYLES.map((s) => svg(s, format, variant));
        expect(new Set(all).size).toBe(6);
      }
    }
  });

  it("magazine = dark masthead with title bars, an accent tab, a photo; editorial = diagonal-cut photo, heavy bars, hairline", () => {
    for (const format of FORMATS) {
      const mag = svg("magazine", format);
      expect(mag).toContain("fill-primary"); // masthead band + dark tab
      expect(mag).toContain("fill-accent-strong"); // accent tab
      expect(mag.match(/class="fill-background"/g)!.length).toBeGreaterThanOrEqual(3); // title bars + foot strip
      const ed = svg("editorial", format);
      const cut = ed.match(/<polygon points="([^"]+)" class="fill-success\/35"/)?.[1].split(" ").map((p) => p.split(",").map(Number));
      expect(cut).toHaveLength(4);
      expect(cut![0][1]).toBeGreaterThan(cut![1][1]); // the photo's top edge rises to the right
      expect(ed).not.toContain("fill-primary");
      expect(ed.match(/fill-foreground\/85/g)!.length).toBeGreaterThanOrEqual(3);
      expect(ed).toContain('stroke-width="0.4"'); // thin rule along the cut
      for (const out of [mag, ed, svg("magazine", format, "default"), svg("editorial", format, "default")]) {
        expect(out).toMatch(/^<svg[^>]*aria-hidden="true"/);
        // Shapes only: no text (the styles' display fonts are not loaded on the wizard), no images, no filters.
        expect(out).not.toMatch(/<text|<image|<use|filter|href|NaN/);
      }
    }
  });

  it("art stays inside the page box", () => {
    const BOX = { A5_PORTRAIT: [16.5, 9.5, 31, 45], A5_LANDSCAPE: [9.5, 16.5, 45, 31] } as const;
    for (const format of FORMATS) {
      const [x, y, w, h] = BOX[format];
      for (const style of ["magazine", "editorial"] as const) {
        const out = svg(style, format);
        for (const m of out.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
          const [rx, ry, rw, rh] = m.slice(1).map(Number);
          if (rx === x + 1.2) continue; // the page's drop shadow
          expect(rx).toBeGreaterThanOrEqual(x - 0.05);
          expect(ry).toBeGreaterThanOrEqual(y - 0.05);
          expect(rx + rw).toBeLessThanOrEqual(x + w + 0.11);
          expect(ry + rh).toBeLessThanOrEqual(y + h + 0.11);
        }
      }
    }
  });

  it("without onStyle the step is a static demo: uncontrolled radios, the given style checked", () => {
    const demo = renderToStaticMarkup(<StepStyle designStyle="editorial" format="A5_PORTRAIT" headlineId="h" />);
    expect(inputTag(demo, "editorial")).toContain("checked");
    expect(inputTag(demo, "magazine")).not.toContain("checked");
    expect(demo).not.toContain("readOnly");
  });
});

describe("Dashboard cover placeholder per style (M30 T12)", () => {
  it("every style has a chosen placeholder; magazine and editorial get their own thumb art", () => {
    expect(BOOK_COVER_PLACEHOLDER_ART).toEqual({
      classic: "framed",
      modern: "bleed",
      geometric: "bleed",
      scrapbook: "bleed",
      magazine: "masthead",
      editorial: "diagonal",
    });
    const thumb = (designStyle: (typeof STYLES)[number]) =>
      renderToStaticMarkup(<BookCoverPlaceholder size="thumb" designStyle={designStyle} />);
    for (const s of STYLES) expect(thumb(s)).toContain(`data-art="${BOOK_COVER_PLACEHOLDER_ART[s]}"`);
    expect(thumb("magazine")).toContain("bg-primary");
    expect(thumb("editorial")).toContain("clip-path:polygon");
    expect(thumb("modern")).toBe(thumb("geometric"));
    // Shelf (library) size: Classic in linen, all others — magazine / editorial included — in emerald cloth.
    const shelf = (designStyle: (typeof STYLES)[number]) =>
      renderToStaticMarkup(<BookCoverPlaceholder size="shelf" designStyle={designStyle} />);
    expect(shelf("classic")).toContain("#fbf6ea");
    for (const s of ["magazine", "editorial"] as const) expect(shelf(s)).toBe(shelf("modern"));
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
