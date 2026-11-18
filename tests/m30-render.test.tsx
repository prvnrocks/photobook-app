// M30 T3: the shared renderer draws the magazine / editorial primitives — colour blocks (fill
// roles, under / over, polygon clip, `when`, print bleed), text ink roles, quarter-turned text,
// the chapterDescription + coverLine bindings and the masthead / body roles. Layouts here are
// test-only and passed through `extraLayouts` (never registered in the catalogue). The dev demo
// layouts (src/lib/book/dev-m30.ts) are checked for validity and overflow too.
// Existing styles are proven unchanged by the m9 / m10b / m10c / m29 goldens (not regenerated).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage, type BookRenderMode } from "@/components/book/BookPage";
import { M30_DEMO_LAYOUTS, m30SheetItem, parseM30Sheet } from "@/lib/book/dev-m30";
import { pageMm } from "@/lib/book/format";
import {
  coverRenderModel,
  pageRenderModel,
  panelCharEm,
  panelFontMm,
  panelType,
  styleColours,
  type RenderPhotos,
} from "@/lib/book/render";
import { LayoutSchema, TEXT_INKS } from "@/lib/book/schema";
import type { BookDoc, Layout, LayoutBlock, LayoutText } from "@/lib/book/types";
import { COLOURWAYS, resolveColourway } from "@/lib/design/colourways";
import { roleFont, STYLE_TOKENS } from "@/lib/design/styles";
import { LAYOUTS, M30_LAYOUTS } from "@/lib/layouts";
import { tailwindFilterClasses } from "./fixtures/no-filter";

const photos: RenderPhotos = Object.fromEntries(
  Array.from({ length: 4 }, (_, i) => [`p${i}`, { url: `https://img.test/p${i}.jpg`, width: 3000, height: 2000 }]),
);
const PAGE = pageMm("A5_PORTRAIT");
const LIME = COLOURWAYS.magazine[0];
const DESCRIPTION = "We left before sunrise and followed the old road into the hills.";

const pageLayout = (over: Partial<Layout> = {}): Layout => ({
  id: "t-m30-page",
  name: "Test page",
  role: "page",
  style: "magazine",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [{ x: 0, y: 0, w: 50, h: 100 }],
  caption: null,
  ...over,
});
const coverLayout = (over: Partial<Layout> = {}): Layout => ({ ...pageLayout(), id: "t-m30-cover", name: "Test cover", role: "cover", ...over });

function docWith(layout: Layout, over: { description?: string | null; chapters?: number; colourway?: string; title?: string } = {}): BookDoc {
  const n = over.chapters ?? 4;
  return {
    version: 2,
    format: layout.format,
    occasion: "travel",
    cover: { layout: layout.role === "cover" ? layout.id : "cover", photoId: "p0", title: over.title ?? "Ten days across the Hajar peaks", subtitle: "Oman · 2026" },
    chapters: Array.from({ length: n }, (_, i) => ({
      id: `c${i + 1}`,
      title: `Chapter ${i + 1}`,
      dateLabel: "3 Nov 2026",
      place: null,
      ...(i === 0 && over.description !== null ? { description: { text: over.description ?? DESCRIPTION, source: "ai" as const } } : {}),
    })),
    pages:
      layout.role === "cover"
        ? []
        : [
            {
              id: "pg0",
              chapterId: "c1",
              layout: layout.id,
              slots: layout.slots.map((_s, i) => ({ photoId: `p${i}`, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
              caption: layout.caption ? { text: "A caption", font: "Poppins", align: "center", source: "ai" } : null,
              ...(layout.role === "spread" ? { side: "left" as const } : {}),
            },
            ...(layout.role === "spread"
              ? [{ id: "pg1", chapterId: "c1", layout: layout.id, side: "right" as const, slots: [], caption: null }]
              : []),
          ],
    style: {
      background: { kind: "color", hex: "#FFFFFF" },
      designStyle: layout.style,
      font: "Poppins",
      ...(over.colourway ? { colourway: { id: over.colourway as "lime", source: "user" as const } } : {}),
    },
  };
}

const model = (layout: Layout, doc = docWith(layout), bleed = false) =>
  pageRenderModel(doc, 0, photos, "en", { bleed, extraLayouts: [layout] })!;
const cover = (layout: Layout, doc = docWith(layout), bleed = false) => coverRenderModel(doc, photos, "en", { bleed, extraLayouts: [layout] });
const html = (layout: Layout, mode: BookRenderMode, doc = docWith(layout), page: number | "cover" = layout.role === "cover" ? "cover" : 0) =>
  renderToStaticMarkup(<BookPage doc={doc} page={page} mode={mode} photos={photos} captionLang="en" extraLayouts={[layout]} />);

const block = (over: Partial<LayoutBlock> = {}): LayoutBlock => ({ box: { x: 50, y: 0, w: 50, h: 100 }, fill: "panel", layer: "under", ...over });
const text = (over: Partial<LayoutText> = {}): LayoutText => ({
  bind: "chapterTitle",
  box: { x: 56, y: 10, w: 38, h: 12 },
  align: "start",
  font: "chapter",
  ...over,
});

describe("extraLayouts", () => {
  it("resolves a layout that is not in the catalogue; without it the page is unknown", () => {
    const l = pageLayout();
    expect(LAYOUTS.some((x) => x.id === l.id)).toBe(false);
    expect(model(l).knownLayout).toBe(true);
    expect(pageRenderModel(docWith(l), 0, photos)!.knownLayout).toBe(false);
  });
});

describe("blocks", () => {
  it("resolve every fill role to a literal hex of the style + colourway", () => {
    const l = pageLayout({
      blocks: [block({ fill: "panel" }), block({ fill: "accent" }), block({ fill: "paper" }), block({ fill: "ink" })],
    });
    const m = model(l);
    expect(m.blocks!.map((b) => [b.fill, b.color])).toEqual([
      ["panel", LIME.panel],
      ["accent", LIME.accent],
      ["paper", "#FFFFFF"],
      ["ink", STYLE_TOKENS.magazine.palette!.ink],
    ]);
    for (const b of m.blocks!) expect(b.color).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("follow the book's colourway; an id of another style falls back to the default", () => {
    const l = pageLayout({ blocks: [block({ fill: "panel" }), block({ fill: "accent" })] });
    const coral = resolveColourway("magazine", "coral")!;
    expect(model(l, docWith(l, { colourway: "coral" })).blocks!.map((b) => b.color)).toEqual([coral.panel, coral.accent]);
    expect(model(l, docWith(l, { colourway: "cobalt" })).blocks!.map((b) => b.color)).toEqual([LIME.panel, LIME.accent]);
    const ed = pageLayout({ style: "editorial", blocks: [block({ fill: "panel" })] });
    expect(model(ed, docWith(ed, { colourway: "cobalt" })).blocks![0].color).toBe(resolveColourway("editorial", "cobalt")!.panel);
  });

  it("`when`: drawn only while that binding has text on this page", () => {
    const l = pageLayout({
      blocks: [block(), block({ fill: "accent", when: "chapterDescription", box: { x: 56, y: 28, w: 10, h: 0.4 } })],
    });
    expect(model(l).blocks!.map((b) => b.fill)).toEqual(["panel", "accent"]);
    expect(model(l, docWith(l, { description: null })).blocks!.map((b) => b.fill)).toEqual(["panel"]);
    // Whitespace-only text counts as empty (same rule as text panels).
    expect(model(l, docWith(l, { description: "  \n " })).blocks!.map((b) => b.fill)).toEqual(["panel"]);
    // No blocks left → the key is absent.
    const only = pageLayout({ blocks: [block({ when: "chapterDescription" })] });
    expect(model(only, docWith(only, { description: null })).blocks).toBeUndefined();
  });

  it("`when: coverLine` on a cover looks at chapter 0", () => {
    const l = coverLayout({ blocks: [block({ fill: "paper", layer: "over", when: "coverLine" })] });
    expect(cover(l).blocks).toHaveLength(1);
    expect(cover(l, docWith(l, { chapters: 0 })).blocks).toBeUndefined();
  });

  it("paint under blocks before the photos and over blocks after them, below the text", () => {
    const l = pageLayout({
      blocks: [block({ layer: "over", fill: "accent" }), block({ layer: "under", fill: "panel" })],
      texts: [text()],
    });
    for (const mode of ["edit", "view", "print"] as const) {
      const out = html(l, mode);
      const under = out.indexOf('data-block-layer="under"');
      const slot = out.indexOf("data-slot-index");
      const over = out.indexOf('data-block-layer="over"');
      const txt = out.indexOf("data-text-panel");
      expect(under, mode).toBeGreaterThan(-1);
      expect(under, mode).toBeLessThan(slot);
      expect(slot, mode).toBeLessThan(over);
      expect(over, mode).toBeLessThan(txt);
    }
  });

  it("markup: flat background hex, aria-hidden, no pointer events, positioned by four insets", () => {
    const l = pageLayout({ blocks: [block({ box: { x: 0, y: 88, w: 100, h: 12 }, fill: "panel", layer: "over" })] });
    const out = html(l, "view");
    const el = /<div[^>]*data-block="panel"[^>]*>/.exec(out)![0];
    expect(el).toContain('aria-hidden="true"');
    expect(el).toContain("pointer-events-none");
    expect(el).toContain(`background:${LIME.panel}`);
    expect(el).toContain("left:0%;top:88%;right:0%;bottom:0%");
  });

  it("polygon: clip-path in % of the box; a rect block has none", () => {
    const pts: Array<[number, number]> = [[0, 100], [100, 0], [100, 100]];
    const l = pageLayout({ blocks: [block({ box: { x: 20, y: 20, w: 40, h: 40 }, points: pts }), block()] });
    const m = model(l);
    expect(m.blocks![0].clipPath).toBe("polygon(0% 100%, 100% 0%, 100% 100%)");
    expect(m.blocks![1].clipPath).toBeUndefined();
    expect(html(l, "view")).toContain("clip-path:polygon(0% 100%, 100% 0%, 100% 100%)");
  });

  it("print: blocks on a trim edge run into the bleed, inner sides stay; polygons are carried out", () => {
    const l = pageLayout({
      blocks: [
        block({ box: { x: 50, y: 0, w: 50, h: 100 } }),
        block({ box: { x: 20, y: 20, w: 40, h: 40 } }),
        block({ box: { x: 0, y: 50, w: 100, h: 50 }, points: [[0, 50], [100, 0], [100, 100], [0, 100]] }),
      ],
    });
    const [edge, inner, poly] = model(l, docWith(l), true).blocks!;
    const bx = (3 / PAGE.w) * 100;
    const by = (3 / PAGE.h) * 100;
    expect(edge.rect.x).toBe(50);
    expect(edge.rect.y).toBeCloseTo(-by, 6);
    expect(edge.rect.w).toBeCloseTo(50 + bx, 6);
    expect(edge.rect.h).toBeCloseTo(100 + 2 * by, 6);
    expect(inner.rect).toEqual({ x: 20, y: 20, w: 40, h: 40 });
    expect(poly.rect.x).toBeCloseTo(-bx, 6);
    // Screen and print polygons differ (bleed extension) and both are plain polygons.
    expect(poly.clipPath).toMatch(/^polygon\(/);
    expect(poly.clipPath).not.toBe(model(l).blocks![2].clipPath);
  });

  it("spreads: a block shows on the half it lies on, shifted into that page", () => {
    const l = pageLayout({
      id: "t-m30-spread",
      role: "spread",
      twin: ["t-m30-page", "t-m30-page"],
      slots: [{ x: 0, y: 0, w: 100, h: 100 }],
      blocks: [block({ box: { x: 120, y: 0, w: 80, h: 100 } }), block({ box: { x: 80, y: 90, w: 40, h: 10 }, fill: "accent" })],
    });
    const doc = docWith(l);
    const left = pageRenderModel(doc, 0, photos, "en", { extraLayouts: [l] })!;
    const right = pageRenderModel(doc, 1, photos, "en", { extraLayouts: [l] })!;
    expect(left.blocks!.map((b) => [b.fill, b.rect.x])).toEqual([["accent", 80]]);
    expect(right.blocks!.map((b) => [b.fill, b.rect.x])).toEqual([
      ["panel", 20],
      ["accent", -20],
    ]);
  });

  it("print rules: no filter, blur, box-shadow, gradient, blend mode or CSS variable colour", () => {
    const l = pageLayout({
      blocks: [block(), block({ layer: "over", fill: "accent", points: [[0, 0], [100, 0], [0, 100]] })],
      texts: [text({ ink: "accentOnDark" }), text({ bind: "dateLabel", rotate: 90, box: { x: 90, y: 10, w: 5, h: 30 }, ink: "paper" })],
    });
    for (const mode of ["view", "print"] as const) {
      const out = html(l, mode);
      expect(tailwindFilterClasses(out), mode).toEqual([]);
      for (const bad of ["filter:", "box-shadow", "color-mix", "gradient", "mix-blend", "backdrop"]) expect(out, `${mode} ${bad}`).not.toContain(bad);
      for (const el of out.match(/<div[^>]*data-block=[^>]*>/g)!) expect(el).toMatch(/background:#[0-9A-F]{6}/);
    }
  });
});

describe("text ink", () => {
  it("each role resolves to its colour; accent is the deepened one, accentOnDark the vivid one", () => {
    const c = styleColours("magazine", "lime");
    const expected: Record<(typeof TEXT_INKS)[number], string> = {
      ink: STYLE_TOKENS.magazine.palette!.ink,
      muted: STYLE_TOKENS.magazine.palette!.muted,
      accent: LIME.accentOnLight,
      paper: LIME.onPanel,
      accentOnDark: LIME.accent,
    };
    expect(c.accentOnLight).not.toBe(c.accent);
    for (const ink of TEXT_INKS) {
      const l = pageLayout({ texts: [text({ ink })] });
      expect(model(l).texts![0].color, ink).toBe(expected[ink]);
      const p = /<p[^>]*data-testid="text-chapterTitle"[^>]*>/.exec(html(l, "view"))![0];
      expect(p, ink).toContain(`color:${expected[ink]}`);
      expect(p, ink).not.toMatch(/text-neutral-|text-white/);
      expect(p, ink).toContain('dir="auto"');
    }
  });

  it("no ink role → no colour: the page ink class as before", () => {
    const l = pageLayout({ texts: [text()] });
    expect(model(l).texts![0].color).toBeUndefined();
    const p = /<p[^>]*data-testid="text-chapterTitle"[^>]*>/.exec(html(l, "view"))![0];
    expect(p).toContain("text-neutral-900");
    expect(p).not.toContain("color:");
  });

  it("styles without colourways get neutral fallbacks (no layout of theirs uses ink)", () => {
    expect(styleColours("classic")).toEqual({
      ink: "#171717",
      muted: "#525252",
      paper: "#FFFFFF",
      accent: "#171717",
      accentOnLight: "#171717",
      panel: "#171717",
      onPanel: "#FFFFFF",
    });
    expect(styleColours("geometric").accent).toBe(STYLE_TOKENS.geometric.palette!.accent);
  });

  it("the pageCaption panel's ink colours the caption (static and editable)", () => {
    const l = pageLayout({
      caption: { x: 56, y: 70, w: 38, h: 20 },
      texts: [text({ bind: "pageCaption", box: { x: 56, y: 70, w: 38, h: 20 }, font: "caption", ink: "paper" })],
    });
    const m = model(l);
    expect(m.caption!.color).toBe(LIME.onPanel);
    const p = /<p[^>]*data-testid="page-caption"[^>]*>/.exec(html(l, "view"))![0];
    expect(p).toContain(`color:${LIME.onPanel}`);
    expect(p).not.toContain("text-neutral-800");
    const plain = pageLayout({ caption: { x: 56, y: 70, w: 38, h: 20 } });
    expect(model(plain).caption!.color).toBeUndefined();
    expect(html(plain, "view")).toContain("text-neutral-800");
  });
});

describe("quarter-turned text", () => {
  const strip = { x: 86, y: 10, w: 3.5, h: 40 }; // 5.18 × 84 mm as seen
  const turned = (deg: 90 | -90) => pageLayout({ texts: [text({ bind: "dateLabel", box: strip, font: "year", rotate: deg })] });

  it("keeps the layout box as the visual rect and lays the text out in a swapped inner box", () => {
    for (const deg of [90, -90] as const) {
      const t = model(turned(deg)).texts![0];
      expect(t.rect).toEqual(strip);
      expect(t.rotate).toBeUndefined();
      expect(t.quarter!.deg).toBe(deg);
      const wMm = (strip.w / 100) * PAGE.w;
      const hMm = (strip.h / 100) * PAGE.h;
      const { inner } = t.quarter!;
      // Inner box in mm = the strip turned: hMm wide, wMm tall, same centre.
      expect((inner.w / 100) * wMm).toBeCloseTo(hMm, 2);
      expect((inner.h / 100) * hMm).toBeCloseTo(wMm, 2);
      expect(inner.x + inner.w / 2).toBeCloseTo(50, 3);
      expect(inner.y + inner.h / 2).toBeCloseTo(50, 3);
    }
  });

  it("sizes the font against the swapped box: the strip's width is the line height limit", () => {
    const long = "Saturday 3 November 2026";
    const l = turned(90);
    const doc = docWith(l);
    doc.chapters[0].dateLabel = long;
    const t = model(l, doc).texts![0];
    const f = roleFont("magazine", "year", long);
    const wMm = (strip.w / 100) * PAGE.w;
    const hMm = (strip.h / 100) * PAGE.h;
    const expected = panelFontMm(long, "year", hMm, wMm, { charEm: panelCharEm(f), lineGrow: 1 });
    expect(t.fontSizeCqw).toBeCloseTo((expected / PAGE.w) * 100, 3);
    // The strip's 5.18 mm width caps the size (one line of the year role across it) …
    expect(expected).toBeCloseTo(wMm / panelType("year").lineHeight, 1);
    expect(expected * panelType("year").lineHeight).toBeLessThanOrEqual(wMm + 0.01);
    // … and differs from what the unswapped box (5.18 mm wide, 84 mm tall) would give.
    expect(panelFontMm(long, "year", wMm, hMm, { charEm: panelCharEm(f), lineGrow: 1 })).not.toBe(expected);
  });

  it("markup: unrotated outer box, rotated inner box, live text with dir=auto", () => {
    const out = html(turned(-90), "print");
    expect(out).toMatch(/<div[^>]*style="left:86%;top:10%;width:3.5%;height:40%"[^>]*data-text-turn="-90"/);
    expect(out).toMatch(/transform:rotate\(-90deg\)/);
    expect(out).toMatch(/<p dir="auto"[^>]*data-testid="text-dateLabel"[^>]*>3 Nov 2026<\/p>/);
  });

  it("a small tilt still rotates the panel box itself (M10c path)", () => {
    const l = pageLayout({ texts: [text({ rotate: 4 })] });
    const t = model(l).texts![0];
    expect(t.rotate).toBe(4);
    expect(t.quarter).toBeUndefined();
  });
});

describe("bindings", () => {
  it("chapterDescription shows the description of the page's chapter; none → no panel", () => {
    const l = pageLayout({ texts: [text({ bind: "chapterDescription", font: "body", box: { x: 56, y: 30, w: 38, h: 40 } })] });
    const t = model(l).texts![0];
    expect(t.bind).toBe("chapterDescription");
    expect(t.text).toBe(DESCRIPTION);
    expect(t.role).toBe("body");
    expect(model(l, docWith(l, { description: null })).texts).toBeUndefined();
    // A page of another chapter (no description there) shows nothing.
    const doc = docWith(l);
    doc.pages[0].chapterId = "c2";
    expect(model(l, doc).texts).toBeUndefined();
    doc.pages[0].chapterId = null;
    expect(model(l, doc).texts).toBeUndefined();
  });

  it("coverLine n shows the title of chapter n (absent n = 0); a missing chapter hides the panel", () => {
    const line = (n?: number) => text({ bind: "coverLine", ...(n === undefined ? {} : { n }), box: { x: 50, y: 40 + (n ?? 0) * 8, w: 44, h: 7 } });
    const l = coverLayout({ slots: [{ x: 0, y: 0, w: 100, h: 100 }], texts: [line(), line(1), line(2), line(5)] });
    expect(cover(l).panels!.map((p) => p.text)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
    expect(cover(l, docWith(l, { chapters: 2 })).panels!.map((p) => p.text)).toEqual(["Chapter 1", "Chapter 2"]);
    expect(cover(l, docWith(l, { chapters: 0 })).panels).toEqual([]);
    // An empty chapter title is hidden as well.
    const doc = docWith(l);
    doc.chapters[1].title = " ";
    expect(cover(l, doc).panels!.map((p) => p.text)).toEqual(["Chapter 1", "Chapter 3"]);
    const out = html(l, "view", docWith(l, { chapters: 1 }));
    expect(out.match(/data-text-panel="coverLine"/g)).toHaveLength(1);
  });
});

describe("masthead + body roles", () => {
  it("magazine masthead: Archivo Black caps for Latin; Arabic gets Lalezar with no uppercase or tracking", () => {
    const l = coverLayout({ texts: [text({ bind: "coverTitle", font: "masthead", box: { x: 6, y: 8, w: 88, h: 26 } })] });
    const en = cover(l).panels![0];
    expect(en.fontFamily).toContain("--font-archivo-black");
    expect(en.typography.textTransform).toBe("uppercase");
    const ar = cover(l, docWith(l, { title: "عشرة أيام بين قمم جبال الحجر" })).panels![0];
    expect(ar.fontFamily).toContain("--font-lalezar");
    expect(ar.fontFamily.indexOf("--font-lalezar")).toBeLessThan(ar.fontFamily.indexOf("--font-archivo-black") === -1 ? Infinity : ar.fontFamily.indexOf("--font-archivo-black"));
    expect(ar.typography.textTransform).toBeUndefined();
    expect(ar.typography.letterSpacing).toBeUndefined();
    expect(ar.lang).toBe("ar");
    const p = /<p[^>]*data-testid="text-coverTitle"[^>]*>/.exec(html(l, "view", docWith(l, { title: "عشرة أيام بين قمم جبال الحجر" })))![0];
    expect(p).toContain('dir="auto"');
    expect(p).not.toContain("uppercase");
    expect(p).not.toContain("letter-spacing");
  });

  it("tracked roles never track Arabic or mixed text", () => {
    const l = coverLayout({ texts: [text({ bind: "coverSubtitle", font: "year", box: { x: 6, y: 4, w: 88, h: 4 } })] });
    expect(cover(l).panels![0].typography.letterSpacing).toBe("0.14em");
    const doc = docWith(l);
    doc.cover.subtitle = "عُمان · نوفمبر ٢٠٢٦";
    expect(cover(l, doc).panels![0].typography.letterSpacing).toBeUndefined();
    doc.cover.subtitle = "Oman عُمان 2026";
    expect(cover(l, doc).panels![0].typography.letterSpacing).toBeUndefined();
  });

  it("masthead: a short title is one big line; it never breaks inside a word; long titles wrap smaller", () => {
    const f = roleFont("magazine", "masthead", "ROME");
    const face = { charEm: panelCharEm(f), lineGrow: 1 };
    const W = 130; // mm
    const H = 60;
    const t = panelType("masthead");
    const short = panelFontMm("Rome", "masthead", W, H, face);
    expect(short).toBe(t.maxMm);
    // One 9-letter word: shrinks until the whole word fits one line (with slack), not a 2-line break.
    const word = panelFontMm("Adventure", "masthead", W, H, face);
    expect(9 * word * face.charEm * 1.05).toBeLessThanOrEqual(W + 0.5);
    expect(word).toBeGreaterThan(15);
    const mid = panelFontMm("Ten days across the Hajar peaks", "masthead", W, H, face);
    expect(mid).toBeLessThan(word);
    expect(mid).toBeGreaterThan(t.minMm);
    const long = panelFontMm("Our long summer by the sea with grandma, the cousins, three dogs and far too much ice cream", "masthead", W, H, face);
    expect(long).toBeLessThan(mid);
    expect(long).toBeGreaterThanOrEqual(t.minMm);
  });

  it("body: 2.8–3.2 mm with comfortable leading; a 45-word description fits a 56 × 62 mm column at full size", () => {
    const t = panelType("body");
    expect([t.minMm, t.maxMm, t.lineHeight]).toEqual([2.8, 3.2, 1.45]);
    const words = Array.from({ length: 45 }, (_, i) => ["valley", "the", "sunrise", "road", "tea", "golden"][i % 6]).join(" ");
    const f = roleFont("magazine", "body", words);
    expect(panelFontMm(words, "body", 56, 62, { charEm: panelCharEm(f), lineGrow: 1 })).toBe(3.2);
  });

  it("a Poppins caption font resolves through the role path (Tajawal for Arabic text)", () => {
    const l = pageLayout({ caption: { x: 56, y: 70, w: 38, h: 20 } });
    const doc = docWith(l);
    expect(model(l, doc).caption!.fontFamily).toMatch(/^var\(--font-poppins/);
    doc.pages[0].caption!.text = "المنعطف الأخير قبل القرية";
    expect(model(l, doc).caption!.fontFamily).toMatch(/^var\(--font-tajawal\)/);
  });

  it("magazine + editorial panels keep their drawn side for Arabic (start = left)", () => {
    const l = pageLayout({ texts: [text({ align: "start" }), text({ bind: "dateLabel", align: "end", font: "year" })] });
    expect(model(l).texts!.map((t) => t.align)).toEqual(["left", "right"]);
    const ed = pageLayout({ style: "editorial", texts: [text({ align: "start" })] });
    expect(model(ed).texts![0].align).toBe("left");
  });
});

describe("catalogue stubs + dev sheet fixtures", () => {
  it("M30 layouts are the tail of the catalogue and only hold magazine / editorial layouts", () => {
    expect(LAYOUTS.slice(LAYOUTS.length - M30_LAYOUTS.length)).toEqual([...M30_LAYOUTS]);
    for (const l of M30_LAYOUTS) expect(["magazine", "editorial"], l.id).toContain(l.style);
  });

  it("demo layouts are schema-valid, use every primitive and stay out of the catalogue", () => {
    for (const l of M30_DEMO_LAYOUTS) {
      const r = LayoutSchema.safeParse(l);
      expect(r.success ? [] : r.error.issues.map((i) => i.message), l.id).toEqual([]);
      expect(LAYOUTS.some((x) => x.id === l.id), l.id).toBe(false);
    }
    const blocks = M30_DEMO_LAYOUTS.flatMap((l) => l.blocks ?? []);
    const texts = M30_DEMO_LAYOUTS.flatMap((l) => l.texts ?? []);
    expect(new Set(blocks.map((b) => b.fill))).toEqual(new Set(["panel", "accent", "paper", "ink"]));
    expect(new Set(blocks.map((b) => b.layer))).toEqual(new Set(["under", "over"]));
    expect(blocks.some((b) => b.points)).toBe(true);
    expect(blocks.some((b) => b.when)).toBe(true);
    expect(new Set(texts.map((t) => t.ink))).toEqual(new Set(TEXT_INKS));
    expect(new Set(texts.map((t) => t.rotate).filter(Boolean))).toEqual(new Set([90, -90]));
    for (const bind of ["coverLine", "chapterDescription"]) expect(texts.some((t) => t.bind === bind), bind).toBe(true);
    for (const role of ["masthead", "body"]) expect(texts.some((t) => t.font === role), role).toBe(true);
  });

  it("sheet fixture: ~32-char title, 4 chapters, a 45-word description on chapter 0; switches work", () => {
    const [coverL, pageL] = M30_DEMO_LAYOUTS;
    const en = m30SheetItem(pageL);
    expect(Array.from(en.doc.cover.title).length).toBeGreaterThanOrEqual(28);
    expect(Array.from(en.doc.cover.title).length).toBeLessThanOrEqual(36);
    expect(en.doc.chapters).toHaveLength(4);
    expect(en.doc.chapters[0].description!.text.split(/\s+/)).toHaveLength(45);
    expect(en.doc.chapters.slice(1).every((c) => c.description === undefined)).toBe(true);
    expect(en.targets).toEqual([0]);
    expect(m30SheetItem(coverL).targets).toEqual(["cover"]);
    const ar = m30SheetItem(pageL, { arabic: true });
    expect(ar.doc.chapters[0].description!.text.split(/\s+/)).toHaveLength(45);
    expect(ar.doc.style.font).toBe("Tajawal");
    expect(m30SheetItem(pageL, { descriptions: false }).doc.chapters[0].description).toBeUndefined();
    expect(m30SheetItem(pageL, { colourway: "coral" }).doc.style.colourway).toEqual({ id: "coral", source: "user" });
    // An id the style doesn't have is ignored (cobalt is editorial-only).
    expect(m30SheetItem(pageL, { colourway: "cobalt" }).doc.style.colourway).toBeUndefined();
    expect(parseM30Sheet("magazine-landscape")).toEqual({ style: "magazine", format: "A5_LANDSCAPE" });
    expect(parseM30Sheet("demo")).toEqual({ style: null, format: "A5_PORTRAIT" });
    expect(parseM30Sheet("geometric-portrait")).toBeNull();
  });

  it("demo sheet renders in every mode, EN + AR, with and without descriptions", () => {
    for (const l of M30_DEMO_LAYOUTS) {
      for (const opts of [{}, { arabic: true }, { descriptions: false }]) {
        const it = m30SheetItem(l, opts);
        for (const mode of ["edit", "view", "print"] as const) {
          const out = renderToStaticMarkup(
            <BookPage doc={it.doc} page={it.targets[0]} mode={mode} photos={photos} captionLang={opts.arabic ? "ar" : "en"} extraLayouts={M30_DEMO_LAYOUTS} />,
          );
          expect(out, l.id).toContain(`data-layout="${l.id}"`);
          expect(out, l.id).toContain("data-block=");
          for (const p of out.match(/<p[^>]*data-testid="text-[^>]*>/g) ?? []) expect(p).toContain('dir="auto"');
        }
      }
    }
    // desc=0 collapses the description panel and its rule on the panel page.
    const [, pageL] = M30_DEMO_LAYOUTS;
    const none = m30SheetItem(pageL, { descriptions: false });
    const m = pageRenderModel(none.doc, 0, photos, "en", { extraLayouts: M30_DEMO_LAYOUTS })!;
    expect(m.texts!.some((t) => t.bind === "chapterDescription")).toBe(false);
    expect(m.blocks!.map((b) => b.fill)).toEqual(["panel"]);
  });
});
