import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage } from "@/components/book/BookPage";
import { bleedRect, printSlotSizeMm } from "@/lib/book/bleed";
import { cropToStyle } from "@/lib/book/crop";
import { devPreviewDoc, devPreviewPhotos } from "@/lib/book/dev-preview";
import { coverRenderModel, pageRenderModel, type RenderPhotos } from "@/lib/book/render";
import { slotSizeMm } from "@/lib/book/resolution";
import type { BookDoc, BookPage as DocPage, Rect } from "@/lib/book/types";
import { pageMm } from "@/lib/book/format";
import { BLEED_MM, CLASSIC_PORTRAIT_LAYOUTS, getLayout, LAYOUTS, PAGE_MM, SAFE_MM, SHEET_MM } from "@/lib/layouts";

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

function page(id: string, layout: string, photoIds: (string | null)[]): DocPage {
  return {
    id,
    chapterId: null,
    layout,
    slots: photoIds.map((photoId) => ({ photoId, crop: { x: 0.3, y: 0.6, zoom: 1.5 } })),
    caption: { text: "أجمل ليلة بدأت بضحكة", font: "Cairo", align: "center", source: "ai" },
  };
}

function makeDoc(pages: DocPage[]): BookDoc {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "wedding",
    cover: { layout: "cover", photoId: "p1", title: "Sara & Omar", subtitle: "Abu Dhabi · 2026" },
    chapters: [],
    pages,
    style: { background: { kind: "color", hex: "#F5EFE6" }, designStyle: "classic", font: "Playfair" },
  };
}

const photos: RenderPhotos = {
  p1: { url: "https://x.test/p1.jpg", width: 3000, height: 4000 },
  p2: { url: "https://x.test/p2.jpg", width: 4000, height: 3000 },
};

describe("bleed constants", () => {
  it("sheet = trim + 3 mm every side", () => {
    expect(BLEED_MM).toBe(3);
    expect(SAFE_MM).toBe(4);
    expect(SHEET_MM).toEqual({ w: 154, h: 216 });
    expect(PAGE_MM).toEqual({ w: 148, h: 210 });
  });
});

describe("bleedRect", () => {
  it("full-page slot extends 3 mm on all four sides", () => {
    const b = bleedRect({ x: 0, y: 0, w: 100, h: 100 });
    expect(b.edges).toEqual({ left: true, top: true, right: true, bottom: true });
    expect(b.sheetMm).toEqual({ x: 0, y: 0, w: 154, h: 216 });
    close(b.pct.x, (-3 / 148) * 100);
    close(b.pct.y, (-3 / 210) * 100);
    close(b.pct.w, (154 / 148) * 100);
    close(b.pct.h, (216 / 210) * 100);
  });

  it("inner slot is unchanged (only shifted by the bleed on the sheet)", () => {
    const r: Rect = { x: 5, y: 5, w: 44, h: 39 };
    const b = bleedRect(r);
    expect(b.edges).toEqual({ left: false, top: false, right: false, bottom: false });
    expect(b.pct).toEqual(r);
    close(b.sheetMm.x, 3 + 0.05 * 148);
    close(b.sheetMm.y, 3 + 0.05 * 210);
    close(b.sheetMm.w, 0.44 * 148);
    close(b.sheetMm.h, 0.39 * 210);
  });

  it("corner slot (cover photo: top/left/right) extends on touching sides only", () => {
    const b = bleedRect({ x: 0, y: 0, w: 100, h: 74 });
    expect(b.edges).toEqual({ left: true, top: true, right: true, bottom: false });
    close(b.sheetMm.x, 0);
    close(b.sheetMm.y, 0);
    close(b.sheetMm.w, 154);
    close(b.sheetMm.h, 3 + 0.74 * 210);
    // bottom edge stays where the layout puts it
    close(b.pct.y + b.pct.h, 74);
  });

  it("a slot in the bottom-right corner extends right and bottom", () => {
    const b = bleedRect({ x: 50, y: 50, w: 50, h: 50 });
    expect(b.edges).toEqual({ left: false, top: false, right: true, bottom: true });
    close(b.sheetMm.x, 3 + 74);
    close(b.sheetMm.y, 3 + 105);
    close(b.sheetMm.w, 74 + 3);
    close(b.sheetMm.h, 105 + 3);
  });

  it("edge detection tolerates float noise but not a real margin", () => {
    expect(bleedRect({ x: 0.005, y: 10, w: 99.99, h: 10 }).edges).toMatchObject({ left: true, right: true });
    expect(bleedRect({ x: 0.5, y: 10, w: 99, h: 10 }).edges).toMatchObject({ left: false, right: false });
  });

  it("printSlotSizeMm: bleed-extended mm per layout slot (id or object), null when unknown", () => {
    expect(printSlotSizeMm("full-page", 0)).toEqual({ w: 154, h: 216 });
    expect(printSlotSizeMm(getLayout("cover")!, 0)).toEqual({ w: 154, h: 3 + 0.74 * 210 });
    const inner = printSlotSizeMm("four-grid", 3)!;
    close(inner.w, 0.44 * 148);
    close(inner.h, 0.39 * 210);
    expect(printSlotSizeMm("four-grid", 4)).toBeNull();
    expect(printSlotSizeMm("nope", 0)).toBeNull();
  });
});

describe("safe zone: text never closer than SAFE_MM to the trim", () => {
  // Caption + text-panel rects of every layout, in mm of the layout's own format. Spread rects
  // (x 0..200) are measured on the page half they sit on (a text never crosses the fold).
  const textRects = LAYOUTS.flatMap((l) =>
    [...(l.caption ? [l.caption] : []), ...(l.texts ?? []).map((t) => t.box)].map((r) => [l.id, r, l] as const),
  );

  it("the catalogue has caption/cover-text rects to check (incl. cover)", () => {
    const classic = CLASSIC_PORTRAIT_LAYOUTS.filter((l) => l.caption).map((l) => l.id);
    expect(classic).toContain("cover");
    expect(classic.length).toBeGreaterThanOrEqual(CLASSIC_PORTRAIT_LAYOUTS.length - 1);
    expect(textRects.length).toBeGreaterThanOrEqual(classic.length);
  });

  it.each(textRects)("%s text rect is ≥ SAFE_MM inside the trim", (_id, r, l) => {
    const page = pageMm(l.format);
    const x = l.role === "spread" && r.x >= 100 ? r.x - 100 : r.x;
    if (l.role === "spread") expect(x + r.w).toBeLessThanOrEqual(100 + 1e-9);
    const left = (x / 100) * page.w;
    const top = (r.y / 100) * page.h;
    const right = page.w - ((x + r.w) / 100) * page.w;
    const bottom = page.h - ((r.y + r.h) / 100) * page.h;
    for (const gap of [left, top, right, bottom]) expect(gap).toBeGreaterThanOrEqual(SAFE_MM);
  });
});

describe("print render model", () => {
  it("edge slots use the bleed rect and crop maths on the extended box; inner slots unchanged", () => {
    const doc = makeDoc([page("a", "full-page", ["p1"]), page("b", "four-grid", ["p2", "p1", "p2", "p1"])]);
    const full = pageRenderModel(doc, 0, photos, "en", { bleed: true })!;
    const b = bleedRect(getLayout("full-page")!.slots[0]);
    expect(full.slots[0].rect).toEqual(b.pct);
    const mm = slotSizeMm(b.pct);
    close(mm.w, 154);
    close(mm.h, 216);
    expect(full.slots[0].photo?.style).toEqual(cropToStyle(3000, 4000, mm.w, mm.h, { x: 0.3, y: 0.6, zoom: 1.5 }));

    const grid = pageRenderModel(doc, 1, photos, "en", { bleed: true })!;
    const view = pageRenderModel(doc, 1, photos, "en")!;
    expect(grid.slots).toEqual(view.slots);
    expect(grid.caption).toEqual(view.caption);
  });

  it("cover: photo extends top/left/right, text rect unchanged", () => {
    const doc = makeDoc([]);
    const print = coverRenderModel(doc, photos, "en", { bleed: true });
    const view = coverRenderModel(doc, photos, "en");
    expect(print.slot?.rect).toEqual(bleedRect(getLayout("cover")!.slots[0]).pct);
    expect(print.textRect).toEqual(view.textRect);
    expect(print.title).toEqual(view.title);
  });
});

describe("print markup", () => {
  const doc = devPreviewDoc();
  const ph = devPreviewPhotos();
  const targets: (number | "cover")[] = ["cover", ...doc.pages.map((_, i) => i)];

  it.each(targets.map((t) => [String(t), t] as const))("%s: 154×216 mm sheet, 148×210 mm trim box at 3 mm, cqw on the trim box", (_n, t) => {
    const out = renderToStaticMarkup(<BookPage doc={doc} page={t} mode="print" photos={ph} captionLang="ar" />);
    expect(out).toMatch(/^<div class="relative shrink-0 overflow-hidden select-none [^"]*" style="width:154mm;height:216mm;background:#FFFFFF;print-color-adjust:exact;-webkit-print-color-adjust:exact" data-mode="print" data-print-sheet="true"/);
    expect(out).toContain('<div class="absolute" style="left:3mm;top:3mm;width:148mm;height:210mm;container-type:inline-size" data-print-trim="true">');
    expect((out.match(/container-type:inline-size/g) ?? []).length).toBe(1);
    expect(out).not.toContain("aspect-[148/210]");
    expect(out).not.toMatch(/watermark/i);
    expect(out).not.toMatch(/Add photo|<button|hover:|cursor-/);
  });

  it("full-page photo is positioned past the trim into the bleed", () => {
    const i = doc.pages.findIndex((p) => p.layout === "full-page");
    const out = renderToStaticMarkup(<BookPage doc={doc} page={i} mode="print" photos={ph} />);
    const b = bleedRect({ x: 0, y: 0, w: 100, h: 100 }).pct;
    expect(out).toContain(`style="left:${b.x}%;top:${b.y}%;width:${b.w}%;height:${b.h}%" data-slot-index="0"`);
  });

  it("Arabic caption keeps dir=auto + lang=ar in print", () => {
    const i = doc.pages.findIndex((p) => p.caption?.font === "Cairo");
    const out = renderToStaticMarkup(<BookPage doc={doc} page={i} mode="print" photos={ph} captionLang="ar" />);
    expect(out).toMatch(/<p dir="auto" lang="ar"[^>]*data-testid="page-caption"/);
  });

  it("missing page renders an empty print sheet", () => {
    const out = renderToStaticMarkup(<BookPage doc={doc} page={99} mode="print" photos={ph} />);
    expect(out).toContain('data-page="missing"');
    expect(out).toContain("width:154mm;height:216mm");
  });

  it("view mode is untouched (no sheet, aspect box, layout rects)", () => {
    const out = renderToStaticMarkup(<BookPage doc={doc} page={0} mode="view" photos={ph} />);
    expect(out).not.toContain("data-print-sheet");
    expect(out).not.toContain("mm");
    expect(out).toContain("aspect-[148/210]");
  });
});
