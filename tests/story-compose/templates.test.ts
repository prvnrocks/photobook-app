// Task 7: storybook page templates — catalogue validity, family coverage, approved ids, capacities.
import { describe, expect, it } from "vitest";
import { BOOK_FORMATS, DESIGN_STYLES, makeLayoutSchema } from "@/lib/book/schema";
import { pageMm } from "@/lib/book/format";
import { STICKERS } from "@/lib/design/stickers";
import { getLayout, LAYOUTS, STORY_LAYOUTS, isStoryLayoutId } from "@/lib/layouts";
import { layoutsFor } from "@/lib/book/spreads";
import { STORY_PHOTO_GAPS, STORY_PHOTO_KINDS, STORY_TEMPLATE_KINDS, storyTemplateId } from "@/lib/layouts/story";
import { approvedTemplateIds, getPageTemplate, isApprovedTemplate, pageTemplates, panelCapacityWords, templateCapacity, templateFamilyOf, TEMPLATE_FAMILIES, templatesFor } from "@/lib/layouts/templates";
import { WORD_BOUNDS } from "@/lib/ai/story/grounding";

const schema = makeLayoutSchema({ stickerIds: new Set(Object.keys(STICKERS)), stickerKinds: new Map(Object.values(STICKERS).map((s) => [s.id, s.kind])) });

describe("story layouts (data)", () => {
  it("every story layout passes the layout schema incl. sticker ids and M10c geometry", () => {
    for (const l of STORY_LAYOUTS) {
      const r = schema.safeParse(l);
      expect(r.success, `${l.id}: ${r.success ? "" : r.error.issues.map((i) => i.message).join("; ")}`).toBe(true);
    }
  });

  it("ids are unique, registered with getLayout, and NOT part of LAYOUTS (album pipeline unchanged)", () => {
    const ids = STORY_LAYOUTS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    const catalogue = new Set(LAYOUTS.map((l) => l.id));
    for (const l of STORY_LAYOUTS) {
      expect(getLayout(l.id)).toBe(l);
      expect(catalogue.has(l.id)).toBe(false);
      expect(isStoryLayoutId(l.id)).toBe(true);
    }
    for (const style of DESIGN_STYLES) for (const format of BOOK_FORMATS) expect(layoutsFor(format, style, "page").some((l) => isStoryLayoutId(l.id))).toBe(false);
  });

  it("text panels keep ≥ 10 mm from the side trims and ≥ 8 mm from top / bottom", () => {
    for (const l of STORY_LAYOUTS) {
      const page = pageMm(l.format);
      for (const t of l.texts ?? []) {
        const x0 = (t.box.x / 100) * page.w;
        const x1 = ((t.box.x + t.box.w) / 100) * page.w;
        const y0 = (t.box.y / 100) * page.h;
        const y1 = ((t.box.y + t.box.h) / 100) * page.h;
        expect(x0, `${l.id} ${t.bind}`).toBeGreaterThanOrEqual(10 - 1e-3);
        expect(page.w - x1, `${l.id} ${t.bind}`).toBeGreaterThanOrEqual(10 - 1e-3);
        expect(y0, `${l.id} ${t.bind}`).toBeGreaterThanOrEqual(8 - 1e-3);
        expect(page.h - y1, `${l.id} ${t.bind}`).toBeGreaterThanOrEqual(8 - 1e-3);
      }
    }
  });

  it("text panels never overlap a photo slot", () => {
    for (const l of STORY_LAYOUTS) {
      for (const t of l.texts ?? []) {
        for (const s of l.slots) {
          const ox = Math.min(t.box.x + t.box.w, s.x + s.w) - Math.max(t.box.x, s.x);
          const oy = Math.min(t.box.y + t.box.h, s.y + s.h) - Math.max(t.box.y, s.y);
          expect(ox > 0.01 && oy > 0.01, `${l.id}: ${t.bind} over a photo`).toBe(false);
        }
      }
    }
  });

  it("STORY_PHOTO_GAPS is exactly what the existing catalogue cannot cover", () => {
    for (const style of DESIGN_STYLES) {
      for (const format of BOOK_FORMATS) {
        const tagged = LAYOUTS.filter((l) => l.style === style && l.format === format && templateFamilyOf(l) !== null);
        const count = (n: number, caption?: boolean) => tagged.filter((l) => l.photoCount === n && (caption === undefined || (l.caption !== null) === caption)).length;
        const gaps = STORY_PHOTO_KINDS.filter((k) => {
          if (k === "hero-full") return count(1, false) === 0;
          if (k === "hero-cap") return count(1, true) === 0;
          const n = Number(k.slice(5, 6));
          return k.endsWith("b") ? count(n) === 0 : count(n) < 2;
        });
        expect(STORY_PHOTO_GAPS[`${style}/${format}`], `${style}/${format}`).toEqual(gaps);
      }
    }
  });
});

describe("template registry", () => {
  it("every style × format has every family, hero/collage for 1–6 photos, ≥ 2 chapter openings", () => {
    for (const style of DESIGN_STYLES) {
      for (const format of BOOK_FORMATS) {
        for (const f of TEMPLATE_FAMILIES) expect(templatesFor(style, format, f).length, `${style}/${format}/${f}`).toBeGreaterThan(0);
        // ≥ 2 per photo count, so two neighbouring pages never have to share a template.
        for (let n = 1; n <= 6; n++) expect(templatesFor(style, format).filter((t) => (t.family === "hero" || t.family === "collage") && t.photoCount === n).length, `${style}/${format} ${n}`).toBeGreaterThanOrEqual(2);
        for (let n = 1; n <= 3; n++) expect(templatesFor(style, format, "storytelling").filter((t) => t.photoCount === n).length, `${style}/${format} story ${n}`).toBeGreaterThanOrEqual(2);
        expect(templatesFor(style, format, "chapter_opening").length).toBeGreaterThanOrEqual(2);
        for (const kind of STORY_TEMPLATE_KINDS) expect(getPageTemplate(storyTemplateId(style, format, kind))).toBeDefined();
      }
    }
  });

  it("approved ids = the registry, frozen, family-correct", () => {
    const a = approvedTemplateIds();
    expect(Object.isFrozen(a)).toBe(true);
    for (const style of DESIGN_STYLES) for (const format of BOOK_FORMATS) for (const f of TEMPLATE_FAMILIES) {
      for (const id of a[style][format][f]) {
        expect(isApprovedTemplate(id, style, format, f)).toBe(true);
        expect(getPageTemplate(id)?.family).toBe(f);
      }
    }
    expect(isApprovedTemplate("full-page", "modern", "A5_PORTRAIT")).toBe(false);
    expect(isApprovedTemplate("nope", "classic", "A5_PORTRAIT")).toBe(false);
  });

  it("narrative shares come from geometry: text-only = 1, hero without caption = 0", () => {
    for (const t of pageTemplates()) {
      expect(t.narrativeShare).toBeGreaterThanOrEqual(0);
      expect(t.narrativeShare).toBeLessThanOrEqual(1);
      if (t.photoCount === 0) expect(t.narrativeShare).toBe(1);
      if (t.family === "hero" && t.panels.length === 0 && !t.chapterTitle) expect(t.narrativeShare).toBe(0);
    }
  });

  it("main text panels hold the longest AI block (70 words) in EN and AR with an 8 % margin", () => {
    for (const t of pageTemplates().filter((x) => x.isNew)) {
      for (const p of t.panels.filter((x) => x.n === 0)) {
        for (const lang of ["en", "ar"] as const) expect(panelCapacityWords(t, p, lang, 0.92), `${t.id} ${lang}`).toBeGreaterThanOrEqual(WORD_BOUNDS.intro.max);
      }
      for (const p of t.panels.filter((x) => x.n !== 0)) {
        for (const lang of ["en", "ar"] as const) expect(panelCapacityWords(t, p, lang, 0.92), `${t.id} quote ${lang}`).toBeGreaterThanOrEqual(WORD_BOUNDS.pull_quote.max);
      }
    }
  });

  it("templateCapacity lists every panel with EN + AR words", () => {
    const cap = templateCapacity(storyTemplateId("classic", "A5_PORTRAIT", "tell-0q"));
    expect(cap.map((c) => c.n)).toEqual([0, 1]);
    for (const c of cap) {
      expect(c.en).toBeGreaterThan(0);
      expect(c.ar).toBeGreaterThan(0);
    }
  });
});
