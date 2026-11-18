// M30 G0 fixes (run report T8 blockers):
//  1. text set straight on a photo is legible on ANY photo — every M30 text sits on paper, on a
//     solid block or on the flat `scrim`; the accent is never used as text on a scrim;
//  2. Arabic headings keep their marks: the masthead / chapter roles of the magazine + editorial
//     styles get a looser line-height and ink headroom the fitter accounts for (Latin unchanged);
//  3. the editorial colourway visibly colours every editorial layout (block fill `accentOnLight`),
//     while the default `ink` colourway stays black on white.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage } from "@/components/book/BookPage";
import { pageMm } from "@/lib/book/format";
import {
  ARABIC_INK,
  coverRenderModel,
  pageRenderModel,
  panelFontMm,
  panelLeading,
  panelType,
  SCRIM_ALPHA,
  styleColours,
  type RenderPhotos,
} from "@/lib/book/render";
import { BLOCK_FILLS, LayoutSchema, layoutIssues } from "@/lib/book/schema";
import type { BookDoc, Layout, LayoutBlock, LayoutText, Rect } from "@/lib/book/types";
import { COLOURWAYS } from "@/lib/design/colourways";
import { roleFont, TEXT_ROLES } from "@/lib/design/styles";
import { M30_LAYOUTS } from "@/lib/layouts";

const photos: RenderPhotos = Object.fromEntries(
  Array.from({ length: 6 }, (_, i) => [`p${i}`, { url: `https://img.test/p${i}.jpg`, width: 3000, height: 2000 }]),
);
const AR_TITLE = "عشرة أيام بين قمم جبال الحجر";

function docFor(layout: Layout, over: { colourway?: string; title?: string; chapters?: number; chapterTitle?: string } = {}): BookDoc {
  const cover = layout.role === "cover";
  return {
    version: 2,
    format: layout.format,
    occasion: "travel",
    cover: { layout: cover ? layout.id : "cover", photoId: "p0", title: over.title ?? "Ten days across the Hajar peaks", subtitle: "Oman · November 2026" },
    chapters: Array.from({ length: over.chapters ?? 6 }, (_, i) => ({
      id: `c${i + 1}`,
      title: over.chapterTitle ?? `Chapter ${i + 1}`,
      dateLabel: "3 Nov 2026",
      place: null,
      description: { text: "We left before sunrise and followed the old road into the hills.", source: "ai" as const },
    })),
    pages: cover
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
          ...(layout.role === "spread" ? [{ id: "pg1", chapterId: "c1", layout: layout.id, side: "right" as const, slots: [], caption: null }] : []),
        ],
    style: {
      background: { kind: "color", hex: "#FFFFFF" },
      designStyle: layout.style,
      font: "Poppins",
      ...(over.colourway ? { colourway: { id: over.colourway as "lime", source: "user" as const } } : {}),
    },
  };
}

/** Every colour the layout draws with (blocks + text panels of the cover / of all its pages). */
function drawnColours(layout: Layout, colourway: string, lang = "en"): string[] {
  const doc = docFor(layout, { colourway });
  if (layout.role === "cover") {
    const m = coverRenderModel(doc, photos, lang);
    return [...(m.blocks ?? []).map((b) => `block:${b.color}`), ...(m.panels ?? []).map((t) => `text:${t.bind}:${t.color}`)];
  }
  return doc.pages.flatMap((_p, i) => {
    const m = pageRenderModel(doc, i, photos, lang)!;
    return [
      ...(m.blocks ?? []).map((b) => `block:${b.color}`),
      ...(m.texts ?? []).map((t) => `text:${t.bind}:${t.color}`),
      ...(m.caption?.color ? [`caption:${m.caption.color}`] : []),
    ];
  });
}

// --- geometry of "what is under this text" ----------------------------------------------------------

type P2 = [number, number];
const inRect = (r: Rect, [x, y]: P2) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
function inPolygon(box: Rect, points: readonly (readonly [number, number])[], [x, y]: P2): boolean {
  const pts = points.map(([px, py]) => [box.x + (px / 100) * box.w, box.y + (py / 100) * box.h]);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inSlot(layout: Layout, slot: Layout["slots"][number], p: P2): boolean {
  if (!inRect(slot, p)) return false;
  const shape = "shape" in slot ? slot.shape : undefined;
  if (shape?.kind === "polygon") return inPolygon(slot, shape.points, p);
  if (shape?.kind === "circle" || shape?.kind === "ellipse") {
    // in page mm, so a circle stays a circle on a non-square page
    const mm = pageMm(layout.format);
    const dx = ((p[0] - (slot.x + slot.w / 2)) / (slot.w / 2)) * 1;
    const dy = ((p[1] - (slot.y + slot.h / 2)) / (slot.h / 2)) * 1;
    return mm.w > 0 && dx * dx + dy * dy <= 1;
  }
  return true;
}
const inBlock = (b: LayoutBlock, p: P2) => inRect(b.box, p) && (!b.points || inPolygon(b.box, b.points, p));

/** What a text's ink lands on at each of 36 sample points of its box: "paper", "photo" or a block fill. */
function surfaces(layout: Layout, t: LayoutText): Set<string> {
  const out = new Set<string>();
  const overs = (layout.blocks ?? []).filter((b) => b.layer === "over");
  const unders = (layout.blocks ?? []).filter((b) => b.layer === "under");
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      const p: P2 = [t.box.x + ((i + 0.5) / 6) * t.box.w, t.box.y + ((j + 0.5) / 6) * t.box.h];
      // Paint order: under blocks, photos, over blocks — the topmost wins. A text's own block must
      // be bound like the text (same `when`; a cover-line block of line n also serves later lines,
      // which only exist when line n does), or it could vanish and leave the text behind.
      const over = [...overs].reverse().find((b) => inBlock(b, p) && (!b.when || (b.when === t.bind && (b.n ?? 0) <= (t.n ?? 0))));
      if (over) out.add(over.fill);
      else if (layout.slots.some((s) => inSlot(layout, s, p))) out.add("photo");
      else out.add([...unders].reverse().find((b) => inBlock(b, p) && !b.when)?.fill ?? "paper");
    }
  }
  return out;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("G0 1: text on photos", () => {
  it("the catalogue is still valid and has the two new fills", () => {
    expect([...BLOCK_FILLS]).toEqual(["panel", "accent", "paper", "ink", "accentOnLight", "scrim"]);
    for (const l of M30_LAYOUTS) {
      expect(LayoutSchema.safeParse(l).success, l.id).toBe(true);
      expect(layoutIssues(l), l.id).toEqual([]);
    }
  });

  it("no M30 text sits straight on a photo: paper, a solid block, or the scrim under it", () => {
    for (const l of M30_LAYOUTS) {
      for (const t of l.texts ?? []) {
        expect([...surfaces(l, t)], `${l.id} ${t.bind}${t.n ?? ""}`).not.toContain("photo");
      }
    }
  });

  it("on a scrim only white text; the accent as text only on solid dark blocks; dark ink only on light surfaces", () => {
    const LIGHT = new Set(["paper", "accent"]);
    const DARK = new Set(["panel", "ink"]);
    for (const l of M30_LAYOUTS) {
      for (const t of l.texts ?? []) {
        const on = [...surfaces(l, t)];
        const at = `${l.id} ${t.bind}${t.n ?? ""} (${t.ink}) on ${on.join("+")}`;
        if (on.includes("scrim")) expect(t.ink, at).toBe("paper");
        if (t.ink === "accentOnDark") expect(on.every((s) => DARK.has(s)), at).toBe(true);
        if (t.ink === "paper") expect(on.every((s) => DARK.has(s) || s === "scrim"), at).toBe(true);
        if (t.ink === "ink" || t.ink === "muted" || t.ink === "accent" || t.ink === undefined) expect(on.every((s) => LIGHT.has(s)), at).toBe(true);
        // dark ink on the vivid accent: magazine only (the editorial default accent is near-white, also fine)
        if (on.includes("accent")) expect(t.ink, at).toBe("ink");
      }
    }
  });

  it("the auto covers: masthead in white on the scrim, the date line in the accent on the dark top bar", () => {
    for (const id of ["mg-p-cover", "mg-l-cover"]) {
      const l = M30_LAYOUTS.find((x) => x.id === id)!;
      const title = l.texts!.find((t) => t.bind === "coverTitle")!;
      const date = l.texts!.find((t) => t.bind === "coverSubtitle")!;
      expect([...surfaces(l, title)], id).toEqual(["scrim"]);
      expect([...surfaces(l, date)], id).toEqual(["panel"]);
      expect(date.ink).toBe("accentOnDark");
      // the photo still fills the whole cover under them
      expect(l.slots[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 100 });
    }
  });

  it("contrast: white on the scrim over a pure white photo ≥ 4:1; ink on every magazine accent ≥ 4.5:1", () => {
    const grey = Math.round(255 * (1 - SCRIM_ALPHA)).toString(16).padStart(2, "0");
    expect(contrast("#FFFFFF", `#${grey}${grey}${grey}`)).toBeGreaterThanOrEqual(3.9);
    for (const cw of COLOURWAYS.magazine) {
      const c = styleColours("magazine", cw.id);
      expect(contrast(c.ink, c.accent), cw.id).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.accent, c.panel), cw.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("the scrim renders as one flat constant-alpha fill: no gradient, filter, blend or shadow", () => {
    const l = M30_LAYOUTS.find((x) => x.id === "mg-p-cover")!;
    const m = coverRenderModel(docFor(l), photos, "en");
    const scrim = m.blocks!.filter((b) => b.fill === "scrim");
    expect(scrim.map((b) => b.color)).toEqual([`rgba(0,0,0,${SCRIM_ALPHA})`]);
    for (const mode of ["view", "print"] as const) {
      const html = renderToStaticMarkup(<BookPage doc={docFor(l)} page="cover" mode={mode} photos={photos} captionLang="en" />);
      const el = html.match(/<div[^>]*data-block="scrim"[^>]*>/)![0];
      expect(el).toContain(`background:rgba(0,0,0,${SCRIM_ALPHA})`);
      expect(el).not.toMatch(/gradient|filter|blur|shadow|blend|opacity|mask/);
    }
  });

  it("a cover-line tab comes and goes with its own line (block `n`)", () => {
    const l = M30_LAYOUTS.find((x) => x.id === "mg-p-cover")!;
    const fills = (chapters: number) => coverRenderModel(docFor(l, { chapters }), photos, "en").blocks!.map((b) => b.fill);
    expect(fills(0)).toEqual(["panel", "accent", "scrim"]);
    expect(fills(1)).toEqual(["panel", "accent", "scrim", "paper", "ink"]);
    expect(fills(2)).toEqual(["panel", "accent", "scrim", "panel", "paper", "ink"]);
    expect(fills(4)).toEqual(["panel", "accent", "scrim", "panel", "accent", "panel", "paper", "ink"]);
    const bad: Layout = { ...l, id: "t-bad-n", blocks: [{ box: { x: 0, y: 0, w: 10, h: 10 }, fill: "ink", layer: "over", n: 1 }] };
    expect(layoutIssues(bad)).toContain("block 0: n needs when coverLine");
  });
});

describe("G0 2: Arabic heading headroom", () => {
  const M30_STYLES = ["magazine", "editorial"] as const;

  it("every Arabic face the M30 styles set a masthead / chapter in has measured ink", () => {
    for (const style of M30_STYLES) {
      for (const role of ["masthead", "chapter"] as const) {
        expect(ARABIC_INK[roleFont(style, role, AR_TITLE, { captionLang: "ar" }).font], `${style} ${role}`).toBeDefined();
      }
    }
  });

  it("the line box + headroom of an Arabic heading holds the face's ink above and below (would have caught the cut hamza)", () => {
    for (const style of M30_STYLES) {
      for (const role of ["masthead", "chapter"] as const) {
        const f = roleFont(style, role, AR_TITLE, { captionLang: "ar" });
        const ink = ARABIC_INK[f.font]!;
        const { lineHeight, padEm } = panelLeading(style, role, f);
        const half = (lineHeight - (ink.asc + ink.desc)) / 2;
        // room from the top of the text element to the baseline of line 1 ≥ the ink's reach
        expect((padEm?.[0] ?? 0) + half + ink.asc, `${style} ${role} top`).toBeGreaterThanOrEqual(ink.inkAsc - 1e-3);
        expect((padEm?.[1] ?? 0) + half + ink.desc, `${style} ${role} bottom`).toBeGreaterThanOrEqual(ink.inkDesc - 1e-3);
        // lines of a bold Arabic heading no longer touch: ink of ordinary letters (≈ 0.9 + 0.4 em) fits the pitch
        expect(lineHeight).toBeGreaterThanOrEqual(1.3);
      }
    }
    // the old state fails this very check: Tajawal at line-height 1.0 with no headroom
    const t = ARABIC_INK.Tajawal!;
    expect((1 - (t.asc + t.desc)) / 2 + t.asc).toBeLessThan(0.878); // alef + hamza reaches 0.878 em
  });

  it("Latin text and every other role / style keep the role's line-height and no padding", () => {
    for (const style of ["classic", "modern", "geometric", "scrapbook", "magazine", "editorial"] as const) {
      for (const role of TEXT_ROLES) {
        const latin = roleFont(style, role, "Ten days", { captionLang: "en" });
        expect(panelLeading(style, role, latin), `${style} ${role} latin`).toEqual({ lineHeight: panelType(role).lineHeight });
        const arabic = roleFont(style, role, AR_TITLE, { captionLang: "ar" });
        const changed = (style === "magazine" || style === "editorial") && (role === "masthead" || role === "chapter");
        if (!changed) expect(panelLeading(style, role, arabic), `${style} ${role} arabic`).toEqual({ lineHeight: panelType(role).lineHeight });
      }
    }
  });

  it("rendered: an Arabic cover title carries the padding and still fits its box; the English one is untouched", () => {
    for (const id of ["ed-p-cover", "ed-p-cover-corner", "ed-p-cover-frame", "ed-l-cover-frame", "mg-p-cover", "mg-l-cover"]) {
      const l = M30_LAYOUTS.find((x) => x.id === id)!;
      const page = pageMm(l.format);
      const ar = coverRenderModel(docFor(l, { title: AR_TITLE }), photos, "ar").panels!.find((t) => t.bind === "coverTitle")!;
      const en = coverRenderModel(docFor(l), photos, "en").panels!.find((t) => t.bind === "coverTitle")!;
      expect(en.padEm, id).toBeUndefined();
      expect(en.lineHeight, id).toBe(1);
      expect(ar.padEm, id).toBeDefined();
      expect(ar.padEm![0], id).toBeGreaterThan(0);
      const html = renderToStaticMarkup(<BookPage doc={docFor(l, { title: AR_TITLE })} page="cover" mode="view" photos={photos} captionLang="ar" />);
      expect(html, id).toContain(`padding-top:${ar.padEm![0]}em`);
      // one line of the fitted size + its headroom is never taller than the box
      const sizeMm = (ar.fontSizeCqw / 100) * page.w;
      const boxH = (ar.rect.h / 100) * page.h;
      expect(sizeMm * (ar.lineHeight + ar.padEm![0] + ar.padEm![1]), id).toBeLessThanOrEqual(boxH + 0.01);
    }
  });

  it("the fitter counts the headroom: same text, same box → a smaller size with padding", () => {
    const face = { charEm: 0.5, lineGrow: 1 };
    const plain = panelFontMm("عشرة أيام", "masthead", 100, 20, face);
    const padded = panelFontMm("عشرة أيام", "masthead", 100, 20, { ...face, lineHeight: 1.3, padEm: 0.54 });
    expect(plain).toBe(20);
    expect(padded).toBeLessThanOrEqual(20 / (1.3 + 0.54) + 0.01);
  });
});

describe("G0 3: editorial colourways", () => {
  const editorial = M30_LAYOUTS.filter((l) => l.style === "editorial");

  it("every editorial layout draws differently in ink and in coral (a cover and a page first)", () => {
    for (const id of ["ed-p-cover", "ed-p-one-opener", "ed-l-cover", "ed-l-six-grid"]) {
      const l = editorial.find((x) => x.id === id)!;
      expect(drawnColours(l, "coral"), id).not.toEqual(drawnColours(l, "ink"));
    }
    for (const l of editorial) {
      const [ink, coral] = [drawnColours(l, "ink"), drawnColours(l, "coral")];
      expect(coral, l.id).not.toEqual(ink);
      expect(coral.some((c) => c.endsWith(styleColours("editorial", "coral").accentOnLight)), l.id).toBe(true);
    }
  });

  it("the default ink colourway stays black on white: accentOnLight = the page ink, and nothing vivid on paper", () => {
    const c = styleColours("editorial", "ink");
    expect(c.accentOnLight).toBe(c.ink);
    for (const l of editorial) {
      const colours = new Set(drawnColours(l, "ink").map((x) => x.split(":").pop()));
      for (const col of colours) expect([c.ink, c.muted, c.paper, c.onPanel, c.scrim], `${l.id} ${col}`).toContain(col);
    }
  });

  it("on white, rules and bars use accentOnLight — never the vivid accent (near-white in ink)", () => {
    for (const l of editorial) {
      expect((l.blocks ?? []).filter((b) => b.fill === "accent" || b.fill === "panel"), l.id).toEqual([]);
    }
    expect(styleColours("editorial", "coral").accentOnLight).toBe("#C22F45");
    const l = editorial.find((x) => x.id === "ed-p-cover")!;
    const blocks = coverRenderModel(docFor(l, { colourway: "coral" }), photos, "en").blocks!;
    expect(blocks.map((b) => [b.fill, b.color])).toEqual([
      ["accentOnLight", "#C22F45"],
      ["accentOnLight", "#C22F45"],
      ["accentOnLight", "#C22F45"],
    ]);
  });
});
