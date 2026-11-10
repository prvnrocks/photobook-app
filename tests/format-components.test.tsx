// M10a A3: format-aware frames in components. Portrait markup must stay exactly as in M9 (the
// goldens in tests/golden prove byte identity); landscape pages get their real size/aspect:
// print sheet 216×154 mm (trim 210×148), aspect 210/148 everywhere else.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// EditorShell → tools registry → UpgradeSheet imports a server action (server-only).
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

import { BookPage } from "@/components/book/BookPage";
import { EditorShell } from "@/components/editor/EditorShell";
import { LayoutDiagram } from "@/components/editor/tools/layout-picker";
import { PRINT_CSS, printCss, PrintDocument } from "@/components/print/PrintDocument";
import { EndCard } from "@/components/viewer/EndCard";
import { FlipbookSkeleton } from "@/components/viewer/FlipbookLoader";
import { devPreviewDoc, devPreviewPhotos, parseDevFormat } from "@/lib/book/dev-preview";
import { isClassAspect, pageAspectRatio, pageAspectStyle, withPageAspect } from "@/lib/book/format-style";
import type { BookDoc } from "@/lib/book/types";
import { devEditorData, devTransport } from "@/lib/editor/dev-fixture";
import { getLayout } from "@/lib/layouts";
import { printSheetTargets } from "@/lib/pdf/print-doc";
import { devViewerDoc } from "@/lib/viewer/dev-fixture";
import { fitBook, PAGE_RATIO_H, PAGE_RATIO_W, pageRatio } from "@/lib/viewer/fit";

const LANDSCAPE_ASPECT = "aspect-ratio:210 / 148";
const photos = devPreviewPhotos();
const portrait = devPreviewDoc();
const landscape = devPreviewDoc("A5_LANDSCAPE");

const pageIdx = (doc: BookDoc, layout: string) => doc.pages.findIndex((p) => p.layout === layout);

describe("format-style helpers", () => {
  it("portrait → no override (class draws 148/210), landscape → inline aspect-ratio", () => {
    expect(isClassAspect("A5_PORTRAIT")).toBe(true);
    expect(isClassAspect(undefined)).toBe(true);
    expect(isClassAspect("A5_LANDSCAPE")).toBe(false);
    expect(pageAspectStyle("A5_PORTRAIT")).toBeUndefined();
    expect(pageAspectStyle(null)).toBeUndefined();
    expect(pageAspectStyle("A5_LANDSCAPE")).toEqual({ aspectRatio: "210 / 148" });
    expect(pageAspectRatio("A5_PORTRAIT")).toBe("148 / 210");
    const base = { background: "#fff" };
    expect(withPageAspect(base, "A5_PORTRAIT")).toBe(base);
    expect(withPageAspect(base, "A5_LANDSCAPE")).toEqual({ background: "#fff", aspectRatio: "210 / 148" });
  });

  it("parseDevFormat: only 'landscape' selects A5_LANDSCAPE", () => {
    expect(parseDevFormat("landscape")).toBe("A5_LANDSCAPE");
    for (const v of [undefined, "", "portrait", "LANDSCAPE", ["landscape"], 1]) expect(parseDevFormat(v)).toBe("A5_PORTRAIT");
  });
});

describe("<BookPage> per format", () => {
  const full = pageIdx(landscape, "full-page");
  const caption = pageIdx(landscape, "one-portrait");

  it("view/edit: landscape page + cover carry aspect 210/148; portrait has no aspect-ratio style", () => {
    for (const mode of ["view", "edit"] as const) {
      for (const page of ["cover", full, caption] as const) {
        const l = renderToStaticMarkup(<BookPage doc={landscape} page={page} mode={mode} photos={photos} />);
        const p = renderToStaticMarkup(<BookPage doc={portrait} page={page} mode={mode} photos={photos} />);
        expect(l).toContain("aspect-[148/210]");
        expect(l).toContain(LANDSCAPE_ASPECT);
        expect(p).not.toContain("aspect-ratio");
        // Same frame tag apart from the aspect override (crop maths differ: slot mm are per format).
        const tag = (html: string) => html.slice(0, html.indexOf(">") + 1);
        expect(tag(l).replace(`;${LANDSCAPE_ASPECT}`, "")).toBe(tag(p));
      }
    }
  });

  it("missing page frame also takes the format", () => {
    expect(renderToStaticMarkup(<BookPage doc={landscape} page={999} mode="view" photos={photos} />)).toContain(LANDSCAPE_ASPECT);
  });

  it("print: landscape sheet 216×154 mm, trim 210×148 mm; portrait 154×216 / 148×210", () => {
    for (const page of ["cover", full, caption] as const) {
      const l = renderToStaticMarkup(<BookPage doc={landscape} page={page} mode="print" photos={photos} />);
      expect(l).toContain("width:216mm;height:154mm");
      expect(l).toContain("left:3mm;top:3mm;width:210mm;height:148mm");
      expect(l).not.toContain("aspect-ratio");
      const p = renderToStaticMarkup(<BookPage doc={portrait} page={page} mode="print" photos={photos} />);
      expect(p).toContain("width:154mm;height:216mm");
      expect(p).toContain("left:3mm;top:3mm;width:148mm;height:210mm");
    }
  });

  it("print: a full-page photo on landscape bleeds 3 mm past the 210×148 trim", () => {
    const html = renderToStaticMarkup(<BookPage doc={landscape} page={full} mode="print" photos={photos} />);
    // Rect in % of the trim page: 3/210 = 1.428…% horizontally, 3/148 = 2.027…% vertically.
    const rect = getLayout("full-page")!.slots[0];
    expect(rect).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(html).toMatch(/left:-1\.428\d*%/);
    expect(html).toMatch(/top:-2\.027\d*%/);
  });
});

describe("<PrintDocument> @page per format", () => {
  it("printCss: sheetMm(format); PRINT_CSS stays the portrait default", () => {
    expect(printCss("A5_LANDSCAPE")).toContain("@page { size: 216mm 154mm; margin: 0; }");
    expect(printCss("A5_PORTRAIT")).toContain("@page { size: 154mm 216mm; margin: 0; }");
    expect(PRINT_CSS).toBe(printCss("A5_PORTRAIT"));
  });

  it("renders the doc's @page and landscape sheets", () => {
    const sheets = printSheetTargets(landscape.pages.length, 0, 3)!;
    const l = renderToStaticMarkup(<PrintDocument doc={landscape} photos={photos} captionLang="ar" sheets={sheets} />);
    expect(l).toContain("@page { size: 216mm 154mm; margin: 0; }");
    expect(l.match(/width:216mm;height:154mm/g)?.length).toBe(sheets.length);
    const p = renderToStaticMarkup(<PrintDocument doc={portrait} photos={photos} captionLang="ar" sheets={sheets} />);
    expect(p).toContain("@page { size: 154mm 216mm; margin: 0; }");
  });
});

describe("viewer fit per format", () => {
  it("pageRatio: portrait 148:210, landscape 210:148", () => {
    expect(pageRatio("A5_PORTRAIT")).toEqual({ w: PAGE_RATIO_W, h: PAGE_RATIO_H });
    expect(pageRatio(undefined)).toEqual({ w: 148, h: 210 });
    expect(pageRatio("A5_LANDSCAPE")).toEqual({ w: 210, h: 148 });
  });

  it("default ratio = portrait, identical for a sweep of stage sizes", () => {
    for (let w = 200; w <= 2000; w += 37) {
      for (let h = 200; h <= 1200; h += 41) {
        for (const spread of [false, true]) {
          expect(fitBook({ width: w, height: h }, spread, pageRatio("A5_PORTRAIT"))).toEqual(fitBook({ width: w, height: h }, spread));
        }
      }
    }
  });

  it("landscape: 375 px phone fits by width; 1280 px spread fits by width", () => {
    expect(fitBook({ width: 375, height: 600 }, false, pageRatio("A5_LANDSCAPE"))).toEqual({ width: 375, height: 264, pageWidth: 375 });
    expect(fitBook({ width: 1280, height: 700 }, true, pageRatio("A5_LANDSCAPE"))).toEqual({ width: 1280, height: 451, pageWidth: 640 });
    // Height-bound: 300 px tall stage → page 425 px wide.
    expect(fitBook({ width: 1280, height: 300 }, true, pageRatio("A5_LANDSCAPE"))).toEqual({ width: 850, height: 300, pageWidth: 425 });
  });
});

describe("viewer extras per format", () => {
  it("EndCard: landscape aspect override, portrait unchanged", () => {
    for (const isPaid of [true, false]) {
      const l = renderToStaticMarkup(<EndCard isPaid={isPaid} format="A5_LANDSCAPE" />);
      const p = renderToStaticMarkup(<EndCard isPaid={isPaid} format="A5_PORTRAIT" />);
      expect(l).toContain(`style="${LANDSCAPE_ASPECT}"`);
      expect(p).not.toContain("aspect-ratio");
      expect(p).toBe(renderToStaticMarkup(<EndCard isPaid={isPaid} />));
    }
  });

  it("loader skeleton takes the book shape", () => {
    expect(renderToStaticMarkup(<FlipbookSkeleton format="A5_LANDSCAPE" />)).toContain(LANDSCAPE_ASPECT);
    expect(renderToStaticMarkup(<FlipbookSkeleton format="A5_PORTRAIT" />)).not.toContain("aspect-ratio");
  });

  it("dev viewer fixture accepts a format", () => {
    expect(devViewerDoc({ format: "A5_LANDSCAPE" }).format).toBe("A5_LANDSCAPE");
    expect(devViewerDoc().format).toBe("A5_PORTRAIT");
  });
});

describe("editor per format", () => {
  it("layout picker diagram uses the book's page shape", () => {
    const layout = getLayout("two-vertical")!;
    expect(renderToStaticMarkup(<LayoutDiagram layout={layout} format="A5_LANDSCAPE" />)).toContain(LANDSCAPE_ASPECT);
    const p = renderToStaticMarkup(<LayoutDiagram layout={layout} format="A5_PORTRAIT" />);
    expect(p).not.toContain("aspect-ratio");
    expect(p).toBe(renderToStaticMarkup(<LayoutDiagram layout={layout} />));
  });

  it("carousel boxes + pages are landscape for a landscape book, untouched for portrait", () => {
    const base = devEditorData("ok");
    const l = renderToStaticMarkup(
      <EditorShell data={{ ...base, doc: { ...base.doc, format: "A5_LANDSCAPE" } }} transport={devTransport("ok")} tools={[]} />,
    );
    const items = l.split('data-testid="carousel-item"').slice(1);
    expect(items.length).toBe(base.doc.pages.length + 1);
    for (const item of items) expect(item).toContain(`class="flex aspect-[148/210] h-full max-w-full items-center" style="${LANDSCAPE_ASPECT}"`);
    const p = renderToStaticMarkup(<EditorShell data={base} transport={devTransport("ok")} tools={[]} />);
    expect(p).toContain('class="flex aspect-[148/210] h-full max-w-full items-center">');
    expect(p).not.toContain("aspect-ratio:210");
  });
});
