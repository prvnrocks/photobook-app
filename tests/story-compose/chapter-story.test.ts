// Story v4: the chapter story page template family (layouts/story chap-a / chap-b), its panels,
// capacities, render (generated chapter label, italic closing line), the composer's choice for v4
// chapter pages, older storybooks composing as before, and soft photos never printed large.
import { describe, expect, it } from "vitest";
import { chapterLabel } from "@/lib/book/chapter-label";
import { pageRenderModel } from "@/lib/book/render";
import { BOOK_FORMATS, DESIGN_STYLES, parseBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";
import { CHAPTER_STORY_PANELS, STORY_CHAPTER_KINDS, chapterStoryKindOf, storyTemplateId } from "@/lib/layouts/story";
import { getPageTemplate, panelCapacityWords, templatesFor } from "@/lib/layouts/templates";
import { composeStoryDoc, selectPageTemplate, type ComposePhoto } from "@/lib/storybook/compose";
import { fixturePhotoId, maxText, storyFixture } from "@/lib/storybook/compose/dev-fixture";
import { bookSoftIds } from "@/lib/photos/quality";
import { laplacianVariance } from "@/lib/image/blur";
import { WORD_BOUNDS } from "@/lib/ai/story/grounding";

const ids = DESIGN_STYLES.flatMap((style) => BOOK_FORMATS.flatMap((format) => STORY_CHAPTER_KINDS.map((kind) => storyTemplateId(style, format, kind))));

describe("chapter story templates (data)", () => {
  it("every style × format has both arrangements, as chapter_opening templates with the four chapter story panels", () => {
    expect(ids).toHaveLength(DESIGN_STYLES.length * BOOK_FORMATS.length * STORY_CHAPTER_KINDS.length);
    for (const id of ids) {
      const t = getPageTemplate(id)!;
      expect(t, id).toBeDefined();
      expect(t.family).toBe("chapter_opening");
      expect(t.chapterStory).toBe(true);
      expect(t.photoCount).toBe(1);
      expect(chapterStoryKindOf(id)).not.toBeNull();
      expect(Object.fromEntries(t.panels.map((p) => [p.n, p.roles]))).toEqual({ 0: ["intro"], 1: ["subtitle"], 2: ["headline"], 3: ["closing_line"] });
      const layout = getLayout(id)!;
      expect(layout.texts!.map((x) => x.bind).sort()).toEqual(["chapterLabel", "chapterTitle", "pageText", "pageText", "pageText", "pageText"]);
      // header band + the divider that hides with the closing line
      expect(layout.blocks!.find((b) => b.when === "pageText" && b.n === CHAPTER_STORY_PANELS.closing_line)).toBeDefined();
      // closing line and subtitle in italics; the paragraph at body-copy size (10–11.5 pt), headline larger
      const closing = layout.texts!.find((x) => x.bind === "pageText" && x.n === 3)!;
      const subtitle = layout.texts!.find((x) => x.bind === "pageText" && x.n === 1)!;
      const body = layout.texts!.find((x) => x.bind === "pageText" && x.n === 0)!;
      const headline = layout.texts!.find((x) => x.bind === "pageText" && x.n === 2)!;
      expect(closing.italic).toBe(true);
      expect(subtitle.italic).toBe(true);
      expect(body.size).toEqual({ maxMm: 4.05, minMm: 3.5 });
      expect(headline.size!.minMm).toBeGreaterThan(body.size!.maxMm);
    }
  });

  it("each panel holds the longest line the writer may return, in EN and AR, with the 8 % margin", () => {
    for (const id of ids) {
      const t = getPageTemplate(id)!;
      const cap = (n: number, lang: "en" | "ar") => panelCapacityWords(t, t.panels.find((p) => p.n === n)!, lang, 0.92);
      for (const lang of ["en", "ar"] as const) {
        expect(cap(0, lang), `${id} intro ${lang}`).toBeGreaterThanOrEqual(WORD_BOUNDS.intro.max);
        // subtitle: a place of up to 28 characters (≈ 4 words) + " · " + the phrase
        expect(cap(1, lang), `${id} subtitle ${lang}`).toBeGreaterThanOrEqual(WORD_BOUNDS.subtitle.max + 4);
        expect(cap(2, lang), `${id} headline ${lang}`).toBeGreaterThanOrEqual(WORD_BOUNDS.headline.max);
        expect(cap(3, lang), `${id} closing ${lang}`).toBeGreaterThanOrEqual(WORD_BOUNDS.closing_line.max);
      }
    }
  });

  it("the chapter page is the text-heavier page (50–76 % narrative by area) — the photo-led pages balance it", () => {
    for (const id of ids) {
      const share = getPageTemplate(id)!.narrativeShare;
      expect(share, id).toBeGreaterThanOrEqual(0.5);
      expect(share, id).toBeLessThanOrEqual(0.76);
    }
  });

  it("both photo orientations (and tall 9:16 phone photos) find an arrangement without a refused crop", () => {
    for (const style of DESIGN_STYLES) {
      for (const format of BOOK_FORMATS) {
        const content = { texts: [{ key: "a", role: "intro" as const, text: maxText("intro", "en", 3) }, { key: "b", role: "headline" as const, text: "One more walk through the garden." }] };
        for (const [w, h] of [[3000, 4000], [4000, 3000], [2268, 4032]]) {
          const r = selectPageTemplate({ family: "chapter_opening", design: { format, designStyle: style }, lang: "en" }, [{ id: fixturePhotoId(1), width: w, height: h }], content);
          expect(r.ok, `${style}/${format} ${w}x${h}`).toBe(true);
          if (r.ok) expect(chapterStoryKindOf(r.templateId)).not.toBeNull();
        }
      }
    }
  });
});

describe("chapter label + italic closing line (render)", () => {
  it("label: CHAPTER ONE … in English, الفصل الأول … in Arabic, digits past the word list", () => {
    expect(chapterLabel(0, "en")).toBe("CHAPTER ONE");
    expect(chapterLabel(2, "en")).toBe("CHAPTER THREE");
    expect(chapterLabel(24, "en")).toBe("CHAPTER 25");
    expect(chapterLabel(0, "ar")).toBe("الفصل الأول");
    expect(chapterLabel(11, "ar")).toBe("الفصل 12");
  });

  const docWith = (title: string, closing: string): BookDoc => ({
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "family",
    cover: { layout: "mg-p-cover-a", photoId: null, title: "Book", subtitle: "" },
    chapters: [
      { id: "ch-c0", title: "Before", dateLabel: "", place: null },
      { id: "ch-c1", title, dateLabel: "", place: null },
    ],
    pages: [
      {
        id: "sp-pg1",
        chapterId: "ch-c1",
        layout: storyTemplateId("magazine", "A5_PORTRAIT", "chap-a"),
        slots: [{ photoId: fixturePhotoId(1), crop: { x: 0.5, y: 0.5, zoom: 1 } }],
        caption: null,
        texts: [
          { id: "tx-b1", panel: 0, role: "intro", text: maxText("intro", "en", 2), source: "ai", blockRef: "b1" },
          { id: "tx-b2", panel: 1, role: "subtitle", text: "Al Ain · A quiet morning", source: "ai", blockRef: "b2" },
          { id: "tx-b3", panel: 2, role: "headline", text: "One more walk through the garden.", source: "ai", blockRef: "b3" },
          { id: "tx-b4", panel: 3, role: "closing_line", text: closing, source: "ai", blockRef: "b4" },
        ],
      },
    ],
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "magazine", font: "Poppins" },
  });

  it("the page renders the generated label for its chapter position, every line, and an italic Latin closing line", () => {
    const d = docWith("Together in the garden", "We left with soil on our hands.");
    expect(parseBookDoc(d).ok).toBe(true);
    const m = pageRenderModel(d, 0, {}, "en")!;
    const texts = (m.kind === "page" ? m.texts : undefined) ?? [];
    expect(texts.find((t) => t.bind === "chapterLabel")?.text).toBe("CHAPTER TWO");
    expect(texts.find((t) => t.bind === "chapterTitle")?.text).toBe("Together in the garden");
    expect(texts.filter((t) => t.bind === "pageText")).toHaveLength(4);
    const closing = texts.find((t) => t.bind === "pageText" && t.textId === "tx-b4")!;
    expect(closing.typography.fontStyle).toBe("italic");
  });

  it("Arabic: the label follows the chapter title's script and an Arabic closing line never slants", () => {
    const d = docWith("في الحديقة معًا", "غادرنا والتراب على أيدينا.");
    const m = pageRenderModel(d, 0, {}, "ar")!;
    const texts = (m.kind === "page" ? m.texts : undefined) ?? [];
    expect(texts.find((t) => t.bind === "chapterLabel")?.text).toBe("الفصل الثاني");
    expect(texts.find((t) => t.bind === "pageText" && t.textId === "tx-b4")!.typography.fontStyle).toBe("normal");
  });
});

describe("composer: v4 chapter pages, older storybooks unchanged", () => {
  it("a v4 storybook opens every chapter on a chapter story page with all four lines, no paragraph pages and no overflow", () => {
    for (const style of DESIGN_STYLES) {
      for (const format of BOOK_FORMATS) {
        const { storybook, photos } = storyFixture({ photos: 24, design: { format, designStyle: style }, skeleton: "v4" });
        const { doc, report } = composeStoryDoc({ storybook, photos, design: { format, designStyle: style }, lang: "en", occasion: "travel", bookTitle: null, maxPages: 20 });
        const chapterPages = doc.pages.filter((p) => chapterStoryKindOf(p.layout) !== null);
        expect(chapterPages.length, `${style}/${format}`).toBe(storybook.chapters.length);
        for (const p of chapterPages) expect(p.texts!.map((t) => t.role).sort()).toEqual(["closing_line", "headline", "intro", "subtitle"]);
        expect(doc.pages.some((p) => p.texts?.some((t) => t.role === "paragraph"))).toBe(false);
        // no overflow anywhere; nothing unplaced on a chapter page (an optional caption may find no caption area on a photo page)
        expect(report.warnings.filter((w) => w.code === "text_overflow")).toEqual([]);
        const chapterIds = new Set(chapterPages.map((p) => p.id));
        expect(report.warnings.filter((w) => w.code === "text_unplaced" && chapterIds.has(w.pageId))).toEqual([]);
        expect(parseBookDoc(doc).ok).toBe(true);
      }
    }
  });

  it("Arabic v4 chapter pages compose without overflow", () => {
    const design = { format: "A5_PORTRAIT" as const, designStyle: "magazine" as const };
    const { storybook, photos } = storyFixture({ photos: 16, design, lang: "ar", skeleton: "v4" });
    const { report } = composeStoryDoc({ storybook, photos, design, lang: "ar", occasion: "travel", bookTitle: null, maxPages: 20 });
    expect(report.warnings.filter((w) => w.code === "text_overflow")).toEqual([]);
  });

  it("an older (intro-only) storybook keeps its open-* chapter openings — chapter story templates need a chapter story line", () => {
    const design = { format: "A5_PORTRAIT" as const, designStyle: "classic" as const };
    const { storybook, photos } = storyFixture({ photos: 24, design });
    const { doc } = composeStoryDoc({ storybook, photos, design, lang: "en", occasion: "travel", bookTitle: null, maxPages: 20 });
    expect(doc.pages.some((p) => chapterStoryKindOf(p.layout) !== null)).toBe(false);
    expect(doc.pages.some((p) => /-open-[abc]$/.test(p.layout))).toBe(true);
  });
});

/** A deterministic textured 128 × 128 luma image, and the same image box-blurred `passes` times. */
function texture(passes: number): Float32Array {
  const w = 128;
  let img = new Float32Array(w * w);
  let x = 12345;
  for (let i = 0; i < img.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    img[i] = ((x >>> 16) & 0xff) * 0.6 + ((i % w) % 16 < 8 ? 60 : 0);
  }
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(img.length);
    for (let y = 0; y < w; y++)
      for (let c = 0; c < w; c++) {
        let s = 0;
        let n = 0;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const yy = y + dy;
            const xx = c + dx;
            if (yy < 0 || xx < 0 || yy >= w || xx >= w) continue;
            s += img[yy * w + xx]!;
            n++;
          }
        out[y * w + c] = s / n;
      }
    img = out;
  }
  return img;
}

describe("soft photos (user test: an out-of-focus photo printed large)", () => {
  it("a uniformly blurred photo is soft against the book's own sharpness (and never mistaken when the book is all sharp)", () => {
    const sharp = laplacianVariance(texture(0), 128, 128);
    const blurred = laplacianVariance(texture(3), 128, 128);
    expect(blurred).toBeLessThan(sharp / 3);
    const book = [...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, variance: sharp * (0.8 + i * 0.05), flat: false })), { id: "soft", variance: blurred, flat: false }];
    expect([...bookSoftIds(book)]).toEqual(["soft"]);
    // the analysis' own "out of focus" note or a soft quality flag also marks it
    expect(bookSoftIds([{ id: "a", variance: null, flat: false, visionBlurry: true }]).has("a")).toBe(true);
    expect(bookSoftIds([{ id: "b", variance: null, flat: false, flags: ["soft"] }]).has("b")).toBe(true);
  });

  it("a soft photo never gets a hero-size slot: alone it is framed small, a sharp one fills the page", () => {
    const design = { format: "A5_PORTRAIT" as const, designStyle: "modern" as const };
    const soft: ComposePhoto = { id: fixturePhotoId(31), width: 3000, height: 4000, soft: true };
    const sharp: ComposePhoto = { id: fixturePhotoId(32), width: 3000, height: 4000 };
    const area = (id: string) => {
      const s = getLayout(id)!.slots[0]!;
      return (s.w * s.h) / 10000;
    };
    const a = selectPageTemplate({ family: "hero", design, lang: "en" }, [soft], { texts: [] });
    const b = selectPageTemplate({ family: "hero", design, lang: "en" }, [sharp], { texts: [] });
    expect(a.ok && area(a.templateId)).toBeLessThanOrEqual(0.3);
    expect(b.ok && area(b.templateId)).toBeGreaterThan(0.5);
    // every hero template but the small framed one refuses it
    const refusing = templatesFor("modern", "A5_PORTRAIT", "hero").filter((t) => area(t.id) > 0.3);
    expect(refusing.length).toBeGreaterThan(0);
  });
});
