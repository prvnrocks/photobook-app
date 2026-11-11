// M10b A9 — shared renderer for the new layouts: spread halves, text panels, design-style fonts,
// split-strip covers, landscape type sizing. Goldens: tests/golden/m10b-render.test.tsx.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage } from "@/components/book/BookPage";
import { printSlotSizeMm, spreadBleedRect } from "@/lib/book/bleed";
import { devSampleDoc, devSamplePhotos } from "@/lib/book/dev-sample";
import {
  CAPTION_FONT_SIZE_CQW,
  coverRenderModel,
  pageRenderModel,
  panelFontMm,
  textScale,
} from "@/lib/book/render";
import { LayoutSchema, parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";

const photos = devSamplePhotos();
const portrait = () => devSampleDoc("modern-portrait");
const landscape = () => devSampleDoc("modern-landscape");
const idx = (doc: BookDoc, layout: string, side?: "left" | "right") =>
  doc.pages.findIndex((p) => p.layout === layout && (side ? p.side === side : true));

describe("sample docs", () => {
  it.each(["modern-portrait", "modern-landscape"] as const)("%s parses and validates", (s) => {
    const doc = devSampleDoc(s);
    expect(parseBookDoc(doc).ok).toBe(true);
    expect(validateBookDoc(doc, { photoIds: new Set(Object.keys(photos)), maxPages: 100 })).toEqual([]);
  });
});

describe("spread halves", () => {
  it("left half shows the slots whose box overlaps x 0..100, right half the rest shifted by −100", () => {
    const doc = portrait();
    const li = idx(doc, "m-p-spread-mosaic", "left");
    const left = pageRenderModel(doc, li, photos)!;
    const right = pageRenderModel(doc, li + 1, photos)!;
    expect(left.spread).toEqual({ side: "left", ownerIndex: li });
    expect(right.spread).toEqual({ side: "right", ownerIndex: li });
    expect(left.slots.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(right.slots.map((s) => s.index)).toEqual([3, 4, 5, 6]);
    const layout = getLayout("m-p-spread-mosaic")!;
    expect(right.slots[0].rect.x).toBeCloseTo(layout.slots[3].x - 100, 9);
    // Right half photos come from the LEFT page's slots.
    expect(right.slots.map((s) => s.photoId)).toEqual(doc.pages[li].slots.slice(3).map((s) => s.photoId));
    // Caption + chapter panels live on the left half only (owner data).
    expect(left.caption?.text).toBe(doc.pages[li].caption?.text);
    expect(right.caption).toBeNull();
    expect(left.texts?.map((t) => t.bind)).toEqual(["chapterTitle", "dateLabel"]);
    expect(right.texts).toBeUndefined();
  });

  it("landscape mosaic: chapter panels on the right half are bound to the left page's chapter", () => {
    const doc = landscape();
    const li = idx(doc, "m-l-spread-mosaic", "left");
    const right = pageRenderModel(doc, li + 1, photos)!;
    const ch = doc.chapters.find((c) => c.id === doc.pages[li].chapterId)!;
    expect(right.texts?.map((t) => t.text)).toEqual([ch.title, ch.dateLabel]);
    expect(right.texts?.[0].rect.x).toBeCloseTo(4.762, 6);
    expect(right.texts?.[0].lang).toBe("ar");
  });

  it("a panorama is one box across both halves: same crop, shifted by one page", () => {
    for (const doc of [portrait(), landscape()]) {
      const id = doc.format === "A5_PORTRAIT" ? "m-p-spread-panorama" : "m-l-spread-panorama";
      const li = idx(doc, id, "left");
      for (const bleed of [false, true]) {
        const l = pageRenderModel(doc, li, photos, "en", { bleed })!.slots[0];
        const r = pageRenderModel(doc, li + 1, photos, "en", { bleed })!.slots[0];
        expect(r.photo!.style).toEqual(l.photo!.style);
        expect(r.rect.w).toBe(l.rect.w);
        expect(r.rect.x).toBeCloseTo(l.rect.x - 100, 9);
      }
    }
  });

  it("print: bleed only on the spread's outer edges, never at the fold", () => {
    const page = { w: 148, h: 210 };
    const pano = spreadBleedRect({ x: 0, y: 0, w: 200, h: 100 }, page);
    expect(pano.sheetMm).toEqual({ x: 0, y: 0, w: 296 + 6, h: 216 });
    // A slot that stops 1.25 mm short of the fold keeps its inner edge.
    const leftCell = getLayout("m-p-spread-grid")!.slots[1];
    const b = spreadBleedRect(leftCell, page);
    expect(b.pct.x + b.pct.w).toBe(leftCell.x + leftCell.w);
    // A slot ending exactly on the fold (x 100) is NOT extended past it.
    const atFold = spreadBleedRect({ x: 50, y: 0, w: 50, h: 100 }, page);
    expect(atFold.edges.right).toBe(false);
    expect(atFold.pct.x + atFold.pct.w).toBe(100);
    expect(printSlotSizeMm("m-p-spread-panorama", 0)).toEqual({ w: 302, h: 216 });
  });

  it("an orphaned right half renders background only; a missing side renders as a left half", () => {
    const doc = portrait();
    const li = idx(doc, "m-p-spread-mosaic", "left");
    const orphan: BookDoc = { ...doc, pages: doc.pages.filter((_p, i) => i !== li) };
    const m = pageRenderModel(orphan, li, photos)!;
    expect(m.spread).toEqual({ side: "right", ownerIndex: null });
    expect(m.slots).toEqual([]);
    const noSide: BookDoc = { ...doc, pages: doc.pages.map((p, i) => (i === li ? { ...p, side: undefined } : p)) };
    expect(pageRenderModel(noSide, li, photos)!.slots.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("markup: each half uses its own page background and carries data-spread-side", () => {
    const doc = portrait();
    const li = idx(doc, "m-p-spread-mosaic", "left");
    const left = renderToStaticMarkup(<BookPage doc={doc} page={li} mode="view" photos={photos} />);
    const right = renderToStaticMarkup(<BookPage doc={doc} page={li + 1} mode="view" photos={photos} />);
    expect(left).toContain('data-spread-side="left"');
    expect(right).toContain('data-spread-side="right"');
    expect(left).not.toContain('data-bg="texture"');
    expect(right).toContain('data-bg-texture="paper-cream"');
  });

  it("edit overlays get the owner page index (right half → left page)", () => {
    const doc = portrait();
    const li = idx(doc, "m-p-spread-mosaic", "left");
    const seen: Array<[number, number | "cover"]> = [];
    const owners: number[] = [];
    renderToStaticMarkup(
      <BookPage
        doc={doc}
        page={li + 1}
        mode="edit"
        photos={photos}
        renderSlotOverlay={(i, owner) => {
          seen.push([i, owner]);
          return null;
        }}
      />,
    );
    renderToStaticMarkup(
      <BookPage
        doc={doc}
        page={li}
        mode="edit"
        photos={photos}
        renderCaption={(_c, _m, _ink, owner) => {
          owners.push(owner);
          return null;
        }}
      />,
    );
    expect(seen).toEqual([3, 4, 5, 6].map((i) => [i, li]));
    expect(owners).toEqual([li]);
  });
});

describe("text panels", () => {
  it("pageCaption panel styles the caption (drawn once), chapter/date panels render in style fonts", () => {
    const doc = portrait();
    const i = idx(doc, "m-p-two-panel");
    const html = renderToStaticMarkup(<BookPage doc={doc} page={i} mode="view" photos={photos} />);
    expect(html.match(/data-testid="page-caption"/g)).toHaveLength(1);
    expect(html).not.toContain('data-text-panel="pageCaption"');
    expect(html).toContain('data-text-panel="chapterTitle"');
    expect(html).toContain('data-text-panel="dateLabel"');
    expect(html).toContain("--font-bebas"); // chapter role (modern)
    expect(html.match(/dir="auto"/g)!.length).toBe(3);
    const m = pageRenderModel(doc, i, photos)!;
    expect(m.caption?.align).toBe("start"); // panel align (AI caption)
    expect(m.caption?.typography).toEqual({ fontWeight: 400, fontStyle: "normal" });
    expect(m.texts?.[0].typography.textTransform).toBe("uppercase");
  });

  it("a user-aligned caption keeps its own alignment; caption.font overrides the role face", () => {
    const doc = portrait();
    const i = idx(doc, "m-p-two-panel");
    const c = { text: "Hello", font: "Bebas", align: "right" as const, source: "user" as const };
    const d: BookDoc = { ...doc, pages: doc.pages.map((p, j) => (j === i ? { ...p, caption: c } : p)) };
    const m = pageRenderModel(d, i, photos)!;
    expect(m.caption?.align).toBe("right");
    expect(m.caption?.fontFamily.startsWith("var(--font-bebas")).toBe(true);
  });

  it("Arabic chapter title uses the Arabic face of the role (Lalezar for modern chapter)", () => {
    const doc = portrait();
    const m = pageRenderModel(doc, idx(doc, "m-p-spread-mosaic", "left"), photos)!;
    expect(m.texts?.[0].fontFamily.startsWith("var(--font-lalezar")).toBe(true);
    expect(m.texts?.[0].lang).toBe("ar");
  });

  it("empty bound text renders no panel", () => {
    const doc = portrait();
    const d: BookDoc = { ...doc, chapters: doc.chapters.map((c) => ({ ...c, title: "", dateLabel: "" })) };
    expect(pageRenderModel(d, idx(d, "m-p-two-panel"), photos)!.texts).toBeUndefined();
  });

  it("panel size shrinks for long text and never exceeds the role maximum", () => {
    expect(panelFontMm("Sara & Omar", "title", 132, 26)).toBe(15);
    expect(panelFontMm("a".repeat(120), "title", 132, 26)).toBeLessThan(10);
    expect(panelFontMm("a".repeat(120), "title", 132, 26)).toBeGreaterThanOrEqual(5);
  });
});

describe("covers", () => {
  it("panels replace the stacked title block; the edit tap target stays on the title block", () => {
    const doc = portrait();
    const view = renderToStaticMarkup(<BookPage doc={doc} page="cover" mode="view" photos={photos} />);
    expect(view).toContain('data-text-panel="coverTitle"');
    expect(view).toContain('data-text-panel="coverSubtitle"');
    expect(view).not.toContain('data-testid="cover-title"');
    expect(view).not.toContain("data-cover-text");
    expect(view).toContain("--font-great-vibes");
    const edit = renderToStaticMarkup(
      <BookPage doc={doc} page="cover" mode="edit" photos={photos} renderCoverTextOverlay={() => <i data-x="overlay" />} />,
    );
    expect(edit).toContain('data-cover-text="true"');
    expect(edit).toContain('data-x="overlay"');
  });

  it.each([
    ["modern-portrait", "m-p-cover-strips"],
    ["modern-landscape", "m-l-cover-strip"],
  ] as const)("%s split-strip cover: one photo drawn through 3 slices", (sample, id) => {
    const doc = devSampleDoc(sample);
    expect(doc.cover.layout).toBe(id);
    const m = coverRenderModel(doc, photos);
    expect(m.slices).toHaveLength(3);
    const html = renderToStaticMarkup(<BookPage doc={doc} page="cover" mode="view" photos={photos} />);
    expect(html.match(/data-slice="/g)).toHaveLength(3);
    expect(html.match(/<img /g)).toHaveLength(3);
    expect(html.match(/data-slot-index="0"/g)).toHaveLength(1);
    // Slices in % of the slot box: within 0..100, in print extended into the bleed at trim edges.
    for (const s of m.slices!) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x + s.w).toBeLessThanOrEqual(100 + 1e-6);
    }
    const p = coverRenderModel(doc, photos, "en", { bleed: true });
    const last = p.slices![2];
    expect(last.x + last.w).toBeCloseTo(100, 3);
    expect(last.y + last.h).toBeCloseTo(100, 3);
  });

  it("schema: slices need a one-slot cover and must lie inside the slot", () => {
    const base = getLayout("m-p-cover-strips")!;
    expect(LayoutSchema.safeParse(base).success).toBe(true);
    expect(base.photoCount).toBe(1);
    expect(base.slots).toHaveLength(1);
    expect(LayoutSchema.safeParse({ ...base, role: "page", texts: undefined }).success).toBe(false);
    expect(LayoutSchema.safeParse({ ...base, photoCount: 2, prefers: ["any", "any"], slots: [base.slots[0], base.slots[0]] }).success).toBe(false);
    expect(LayoutSchema.safeParse({ ...base, slices: [...base.slices!, { x: 0, y: 0, w: 10, h: 10 }] }).success).toBe(false);
  });
});

describe("landscape type sizing (mm match portrait)", () => {
  it("captions and cover text scale by min(w,h)/w; portrait is exactly unscaled", () => {
    expect(textScale("A5_PORTRAIT")).toBe(1);
    expect(textScale("A5_LANDSCAPE")).toBeCloseTo(148 / 210, 9);
    const doc = landscape();
    const m = pageRenderModel(doc, idx(doc, "m-l-one"), photos)!;
    expect(m.caption!.fontSizeCqw! * 2.1).toBeCloseTo(CAPTION_FONT_SIZE_CQW * 1.48, 2);
    expect(pageRenderModel(portrait(), idx(portrait(), "m-p-four-grid"), photos)!.caption!.fontSizeCqw).toBeUndefined();
    const classicLandscape: BookDoc = {
      ...doc,
      style: { ...doc.style, designStyle: "classic" },
      cover: { ...doc.cover, layout: "c-l-cover" },
    };
    const c = coverRenderModel(classicLandscape, photos);
    expect(c.textScale).toBeCloseTo(148 / 210, 4);
    expect(c.title.sizeCqw).toBeCloseTo(7 * (148 / 210), 3);
    expect(c.panels).toBeUndefined();
  });

  it("panel sizes are mm-based: same title in both formats has the same mm size", () => {
    const p = coverRenderModel(portrait(), photos).panels!.find((t) => t.bind === "coverTitle")!;
    const l = coverRenderModel(landscape(), photos).panels!.find((t) => t.bind === "coverTitle")!;
    expect(p.fontSizeCqw * 1.48).toBeCloseTo(l.fontSizeCqw * 2.1, 2);
  });
});
