// Fix (user feedback on a magazine A5 portrait storybook): lookalike photos paired on one page, and
// empty space under story text. Contrasting photo sets (compose/contrast.ts) and fitted variants of
// the storytelling templates (layouts/story STORY_VARIANT_STEPS, compose/select.ts, compose/refit.ts).
import { describe, expect, it } from "vitest";
import { setPageText } from "@/lib/book/edit-ops";
import { pageMm } from "@/lib/book/format";
import { BOOK_FORMATS, DESIGN_STYLES } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { getLayout, STORY_LAYOUTS } from "@/lib/layouts";
import { isStoryVariantId, STORY_BODY_SIZE, STORY_MIN_TEXT_SHARE, storyBaseId, storyTemplateId, storyVariantsOf } from "@/lib/layouts/story";
import { approvedTemplateIds, getPageTemplate, templatesFor } from "@/lib/layouts/templates";
import { composeStoryDoc, selectPageTemplate, textFits, validatePageLayout, type ComposePhoto } from "@/lib/storybook/compose";
import { composeSignalsOf, contrastPhotos, LOOKALIKE, photoSimilarity, type ContrastUnit } from "@/lib/storybook/compose/contrast";
import { fixturePhotoId, maxText, storyFixture } from "@/lib/storybook/compose/dev-fixture";
import { refitStoryText } from "@/lib/storybook/compose/refit";
import { applyStoryText } from "@/lib/storybook/compose/regenerate-page";

const words = (n: number, lang: "en" | "ar" = "en") => maxText("paragraph", lang, 3).split(" ").concat(maxText("intro", lang, 7).split(" ")).slice(0, n).join(" ");
const MG_P = { format: "A5_PORTRAIT" as const, designStyle: "magazine" as const };
const P = (n: number, over: Partial<ComposePhoto> = {}): ComposePhoto => ({ id: fixturePhotoId(700 + n), width: 4000, height: 3000, ...over });

describe("fitted variants (data)", () => {
  it("variants are registered layouts but not templates: catalogue, approved ids and the AI list are unchanged", () => {
    const variants = STORY_LAYOUTS.filter((l) => isStoryVariantId(l.id));
    expect(variants.length).toBeGreaterThan(100);
    const approved = new Set(Object.values(approvedTemplateIds()).flatMap((f) => Object.values(f).flatMap((fam) => Object.values(fam).flat())));
    for (const l of variants) {
      expect(getLayout(l.id)).toBe(l);
      const t = getPageTemplate(l.id)!;
      expect(t.family).toBe("storytelling");
      expect(t.baseId).toBe(storyBaseId(l.id));
      expect(t.baseId).not.toBe(l.id);
      expect(approved.has(l.id)).toBe(false);
      expect(storyVariantsOf(t.baseId)).toContain(l.id);
    }
    for (const style of DESIGN_STYLES) for (const format of BOOK_FORMATS) expect(templatesFor(style, format).some((t) => isStoryVariantId(t.id))).toBe(false);
  });

  it("only tell-* kinds with photos directly above / below the paragraph get variants (openers, closings, text pages, side columns: none)", () => {
    for (const style of DESIGN_STYLES) {
      for (const kind of ["open-a", "open-b", "open-c", "close-0", "close-1", "tell-0", "tell-0q", "hero-small"] as const) {
        for (const format of BOOK_FORMATS) expect(storyVariantsOf(storyTemplateId(style, format, kind)), `${style} ${kind}`).toEqual([]);
      }
      expect(storyVariantsOf(storyTemplateId(style, "A5_LANDSCAPE", "tell-1a"))).toEqual([]);
      expect(storyVariantsOf(storyTemplateId(style, "A5_LANDSCAPE", "tell-1b"))).toEqual([]);
      for (const kind of ["tell-1a", "tell-1b", "tell-1c", "tell-2", "tell-2b", "tell-2c", "tell-3", "tell-3b"] as const) expect(storyVariantsOf(storyTemplateId(style, "A5_PORTRAIT", kind)).length, `${style} ${kind}`).toBeGreaterThan(0);
    }
  });

  it("each variant: same slots count + orientations, a shorter paragraph box (same width, same size range, top-aligned), bigger photos, ≥ 20 % of the page for the text", () => {
    for (const l of STORY_LAYOUTS.filter((x) => isStoryVariantId(x.id))) {
      const base = getLayout(storyBaseId(l.id))!;
      expect(l.photoCount).toBe(base.photoCount);
      expect(l.prefers).toEqual(base.prefers);
      const main = l.texts!.find((t) => t.bind === "pageText" && (t.n ?? 0) === 0)!;
      const bmain = base.texts!.find((t) => t.bind === "pageText" && (t.n ?? 0) === 0)!;
      expect(main.box.w).toBeCloseTo(bmain.box.w, 3);
      expect(main.box.h).toBeLessThan(bmain.box.h);
      expect(main.size).toEqual(STORY_BODY_SIZE);
      expect(main.valign).toBe("start");
      const area = (r: { w: number; h: number }) => r.w * r.h;
      expect(l.slots.reduce((s, r) => s + area(r), 0), l.id).toBeGreaterThan(base.slots.reduce((s, r) => s + area(r), 0));
      expect(area(main.area!) / 10000, l.id).toBeGreaterThanOrEqual(STORY_MIN_TEXT_SHARE - 1e-9);
    }
  });

  it("photo gaps stay 2.5 mm and photos never overlap each other", () => {
    for (const l of STORY_LAYOUTS.filter((x) => isStoryVariantId(x.id))) {
      const page = pageMm(l.format);
      const mm = l.slots.map((s) => ({ x0: (s.x / 100) * page.w, y0: (s.y / 100) * page.h, x1: ((s.x + s.w) / 100) * page.w, y1: ((s.y + s.h) / 100) * page.h }));
      for (let i = 0; i < mm.length; i++) {
        for (let j = i + 1; j < mm.length; j++) {
          const a = mm[i]!;
          const b = mm[j]!;
          const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          expect(ox > 0.01 && oy > 0.01, `${l.id} slots ${i}/${j} overlap`).toBe(false);
          // vertically stacked neighbours keep the 2.5 mm gap (inset styles keep it too)
          if (ox > 0.01) expect(Math.min(Math.abs(b.y0 - a.y1), Math.abs(a.y0 - b.y1)), `${l.id} gap ${i}/${j}`).toBeGreaterThanOrEqual(2.5 - 0.01);
        }
      }
    }
  });
});

describe("fitted variants (selection, no overflow EN / AR)", () => {
  const photo = { ...P(1), width: 4000, height: 3000 };
  const tells = (n: number) => [photo, P(2), P(3, { width: 3000, height: 4000 })].slice(0, n);

  it("short and longest paragraphs: a variant only at full size with the margin; text never overflows", () => {
    for (const style of DESIGN_STYLES) {
      for (const format of BOOK_FORMATS) {
        for (const lang of ["en", "ar"] as const) {
          for (const n of [1, 2, 3]) {
            const short = selectPageTemplate({ family: "storytelling", design: { format, designStyle: style }, lang, relax: true }, tells(n), { texts: [{ key: "t", role: "paragraph", text: words(30, lang) }] });
            const long = selectPageTemplate({ family: "storytelling", design: { format, designStyle: style }, lang, relax: true }, tells(n), { texts: [{ key: "t", role: "paragraph", text: maxText("paragraph", lang, 3) }] });
            expect(short.ok && long.ok).toBe(true);
            if (!short.ok || !long.ok) continue;
            for (const r of [short, long]) {
              const v = validatePageLayout({ id: "p", chapterId: null, layout: r.templateId, slots: r.slots, caption: null, texts: [{ id: "t", panel: 0, role: "paragraph", text: r === short ? words(30, lang) : maxText("paragraph", lang, 3), source: "ai" }] }, { design: { format, designStyle: style }, lang });
              expect(v.errors.filter((e) => e.code === "text_overflow"), `${r.templateId} ${lang}`).toEqual([]);
            }
            // a variant is only ever chosen with the paragraph at its full size + the 8 % margin
            for (const [r, text] of [[short, words(30, lang)], [long, maxText("paragraph", lang, 3)]] as const) {
              const t = getPageTemplate(r.templateId)!;
              if (isStoryVariantId(r.templateId)) expect(textFits(t, t.panels.find((p) => p.n === 0)!, text, lang, 0.92, true), `${r.templateId} ${lang}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it("magazine A5 portrait: a 40-word paragraph fills ≥ 70 % of its box (was ~ 45–60 %) at the full 11.5 pt", () => {
    const text = words(40);
    for (const n of [1, 2, 3]) {
      const r = selectPageTemplate({ family: "storytelling", design: MG_P, lang: "en" }, tells(n), { texts: [{ key: "t", role: "paragraph", text }] });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(isStoryVariantId(r.templateId), r.templateId).toBe(true);
      const t = getPageTemplate(r.templateId)!;
      const main = t.panels.find((p) => p.n === 0)!;
      expect(textFits(t, main, text, "en", 0.92, true)).toBe(true);
      expect(textFits(t, main, text, "en", 0.7, true), `${r.templateId} too roomy`).toBe(false);
    }
  });

  it("refitStoryText: typing more moves to a taller form, then the base; shortening moves back; a page without variants is untouched", () => {
    const f = storyFixture({ photos: 24, design: MG_P, lowRes: [5] });
    const doc = composeStoryDoc({ storybook: f.storybook, photos: f.photos, design: MG_P, lang: "en", occasion: "travel", bookTitle: null, maxPages: 20 }).doc;
    const idx = doc.pages.findIndex((p) => isStoryVariantId(p.layout));
    expect(idx).toBeGreaterThanOrEqual(0);
    const sizes = new Map(f.photos.map((p) => [p.id, p]));
    const base = storyBaseId(doc.pages[idx]!.layout);
    const type = (d: BookDoc, text: string) => refitStoryText(setPageText(d, idx, 0, text), idx, { lang: "en", photos: sizes });
    const long = type(doc, maxText("paragraph", "en", 3));
    expect(long.pages[idx]!.layout).toBe(base);
    const longer = type(doc, `${maxText("intro", "en", 5)} ${maxText("intro", "en", 6)}`);
    expect(longer.pages[idx]!.layout, "past the base's room: the base, flagged, never a variant").toBe(base);
    const back = type(long, words(30));
    expect(isStoryVariantId(back.pages[idx]!.layout)).toBe(true);
    expect(storyBaseId(back.pages[idx]!.layout)).toBe(base);
    expect(back.pages[idx]!.slots).toEqual(doc.pages[idx]!.slots);
    // never overflow on the way: every length from 10 to 70 words fits whatever form it gets
    let d = doc;
    for (let n = 10; n <= 70; n += 5) {
      d = type(d, words(n));
      const v = validatePageLayout(d.pages[idx]!, { design: MG_P, lang: "en", photos: sizes });
      expect(v.errors.filter((e) => e.code === "text_overflow"), `${n} words on ${d.pages[idx]!.layout}`).toEqual([]);
    }
    // an opener has no variants: same doc object back
    const opener = doc.pages.findIndex((p) => getPageTemplate(p.layout)?.family === "chapter_opening");
    expect(refitStoryText(doc, opener, { lang: "en", photos: sizes })).toBe(doc);
    // the AI rewrite path re-fits too
    const rewritten = applyStoryText(doc, idx, 0, maxText("paragraph", "en", 3), "ai", { lang: "en", photos: sizes });
    expect(rewritten.pages[idx]!.layout).toBe(base);
  });

  it("Arabic: refit keeps every length inside its box", () => {
    const f = storyFixture({ photos: 24, design: MG_P, lowRes: [5], lang: "ar" });
    const doc = composeStoryDoc({ storybook: f.storybook, photos: f.photos, design: MG_P, lang: "ar", occasion: "travel", bookTitle: null, maxPages: 20 }).doc;
    const sizes = new Map(f.photos.map((p) => [p.id, p]));
    const idx = doc.pages.findIndex((p) => isStoryVariantId(p.layout));
    let d = doc;
    for (let n = 10; n <= 60; n += 5) {
      d = refitStoryText(setPageText(d, idx, 0, words(n, "ar")), idx, { lang: "ar", photos: sizes });
      expect(validatePageLayout(d.pages[idx]!, { design: MG_P, lang: "ar", photos: sizes }).errors.filter((e) => e.code === "text_overflow"), `${n}`).toEqual([]);
    }
  });
});

describe("contrasting photo sets", () => {
  const cup = (n: number, over: Partial<ComposePhoto> = {}) => P(n, { phash: "a1b2c3d4e5f60718", takenAt: "2026-10-12T09:00:00.000Z", scene: "food", people: 0, color: "#b0764a", ...over });

  it("photoSimilarity: near-identical shots read as lookalikes, different scenes / times do not, no signals = 0", () => {
    expect(photoSimilarity(cup(1), cup(2, { phash: "a1b2c3d4e5f6071b", takenAt: "2026-10-12T09:00:08.000Z" }))).toBeGreaterThanOrEqual(LOOKALIKE);
    const pose = (n: number, t: string, h: string) => P(n, { width: 3000, height: 4000, phash: h, takenAt: t, scene: "portrait", people: 1, color: "#5b7fa6" });
    expect(photoSimilarity(pose(3, "2026-10-12T10:00:00.000Z", "0f0f0f0f0f0f0f0f"), pose(4, "2026-10-12T10:00:20.000Z", "0f0f0f0f0f0f00ff"))).toBeGreaterThanOrEqual(LOOKALIKE);
    expect(photoSimilarity(cup(5), P(6, { phash: "5e4d3c2b1a09f8e7", takenAt: "2026-10-12T11:30:00.000Z", scene: "landscape", people: 0, color: "#6f9a5b" }))).toBeLessThan(0.45);
    expect(photoSimilarity(P(7), P(8))).toBe(0);
    expect(photoSimilarity(P(9, { group: "g1" }), P(10, { group: "g1" }))).toBe(1);
  });

  it("a page never pairs lookalikes when the chapter has contrasting partners; pinned photos stay; sizes stay", () => {
    const a = cup(1);
    const b = cup(2, { phash: "a1b2c3d4e5f6071b", takenAt: "2026-10-12T09:00:08.000Z" });
    const c = P(3, { phash: "0f0f0f0f0f0f0f0f", takenAt: "2026-10-12T09:05:00.000Z", scene: "portrait", people: 1, color: "#5b7fa6" });
    const d = P(4, { phash: "0f0f0f0f0f0f00ff", takenAt: "2026-10-12T09:05:10.000Z", scene: "portrait", people: 1, color: "#5b7fa6" });
    const units: ContrastUnit[] = [
      { id: "u1", chapterId: "c", momentId: "m", family: "collage", photos: [a, b], pinned: new Set([a.id]), capacity: 6 },
      { id: "u2", chapterId: "c", momentId: "m", family: "collage", photos: [c, d], pinned: new Set(), capacity: 6 },
    ];
    const r = contrastPhotos(units);
    expect(r.swaps).toBeGreaterThan(0);
    expect(units[0]!.photos.map((p) => p.id)).toContain(a.id);
    for (const u of units) {
      expect(u.photos).toHaveLength(2);
      expect(photoSimilarity(u.photos[0]!, u.photos[1]!)).toBeLessThan(LOOKALIKE);
    }
  });

  it("two photos of one similar group never share a page: moved to a page with room, else set aside", () => {
    const g = (n: number) => P(n, { group: "burst-1" });
    const units: ContrastUnit[] = [
      { id: "u1", chapterId: "c", momentId: "m", family: "storytelling", photos: [g(1), g(2)], pinned: new Set([fixturePhotoId(701)]), capacity: 3 },
      // the hero's photo is pinned: no swap can help, so the second burst shot moves there
      { id: "u2", chapterId: "c", momentId: "m", family: "hero", photos: [P(3)], pinned: new Set([fixturePhotoId(703)]), capacity: 6 },
    ];
    const moved = contrastPhotos(units);
    expect(moved.moved).toEqual([fixturePhotoId(702)]);
    expect(units[1]!.photos.map((p) => p.id)).toContain(fixturePhotoId(702));
    const alone: ContrastUnit[] = [{ id: "u1", chapterId: "c", momentId: "m", family: "collage", photos: [g(1), g(2), P(3)], pinned: new Set(), capacity: 6 }];
    const aside = contrastPhotos(alone);
    expect(aside.setAside).toHaveLength(1);
    expect(alone[0]!.photos.filter((p) => p.group === "burst-1")).toHaveLength(1);
  });

  it("composed fixture with lookalike pairs: no page pairs lookalikes (24 photos, every style × format), twice byte-identical; no signals = the photo plan untouched", () => {
    for (const style of DESIGN_STYLES) {
      for (const format of BOOK_FORMATS) {
        const design = { format, designStyle: style };
        const f = storyFixture({ photos: 24, design, lowRes: [5], lookalikes: true });
        const run = () => composeStoryDoc({ storybook: f.storybook, photos: f.photos, design, lang: "en", occasion: "travel", bookTitle: null, maxPages: 20 });
        const r = run();
        expect(JSON.stringify(run().doc)).toBe(JSON.stringify(r.doc));
        const byId = new Map(f.photos.map((p) => [p.id, p]));
        for (const p of r.doc.pages) {
          const ids = p.slots.map((s) => s.photoId).filter((x): x is string => !!x);
          for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(photoSimilarity(byId.get(ids[i]!)!, byId.get(ids[j]!)!), `${style}/${format} ${p.id}`).toBeLessThan(LOOKALIKE);
        }
        expect(r.report.warnings.some((w) => w.code === "lookalikes_separated")).toBe(true);
        // every photo is still in the book (swaps only)
        expect(new Set(r.doc.pages.flatMap((p) => p.slots.map((s) => s.photoId))).size).toBe(f.photos.length);
      }
    }
    const plain = storyFixture({ photos: 24, design: MG_P, lowRes: [5] });
    const r = composeStoryDoc({ storybook: plain.storybook, photos: plain.photos, design: MG_P, lang: "en", occasion: "travel", bookTitle: null, maxPages: 20 });
    expect(r.report.warnings.some((w) => w.code.startsWith("lookalike"))).toBe(false);
  });

  it("composeSignalsOf: reads the photos row (file dates dropped, bad values null)", () => {
    const none = { objects: null, activities: null, storyRole: null };
    expect(composeSignalsOf({ phash: "A1B2C3D4E5F60718", taken_at: "2026-10-12T09:00:00Z", date_source: "exif", color: "#B0764A", ai: { scene: "food", peopleCount: 0 } }, 3)).toEqual({ phash: "a1b2c3d4e5f60718", takenAt: "2026-10-12T09:00:00Z", scene: "food", people: 0, color: "#b0764a", group: "3", ...none });
    expect(composeSignalsOf({ phash: null, taken_at: "2026-10-12T09:00:00Z", date_source: "file", color: "red", ai: null })).toEqual({ phash: null, takenAt: null, scene: null, people: null, color: null, group: null, ...none });
  });

  it("story v4: storybook photos without a Curator note take scene / people / objects / activities / role from the Task 3 analysis", () => {
    const vision = { scene: "portrait", peopleCount: 1, objects: ["Wall", "palm tree"], activities: ["posing by a wall"], storyRole: "portrait" };
    expect(composeSignalsOf({ phash: null, taken_at: null, ai: null }, null, vision)).toMatchObject({ scene: "portrait", people: 1, objects: ["wall", "palm tree"], activities: ["posing by a wall"], storyRole: "portrait" });
  });
});

describe("story v4: 'alike' uses the analysis — same subject, same setting, same pose, minutes apart", () => {
  const cup = (n: number, minute: number, phash: string): ComposePhoto =>
    P(n, { phash, takenAt: new Date(Date.UTC(2026, 4, 30, 13, minute)).toISOString(), scene: "food", people: 0, objects: ["iced coffee cup", "shop sign"], activities: ["holding a cup"], storyRole: "detail", color: "#a07850" });
  const pose = (n: number, minute: number, phash: string): ComposePhoto =>
    P(n, { width: 3000, height: 4000, phash, takenAt: new Date(Date.UTC(2026, 4, 30, 14, minute)).toISOString(), scene: "portrait", people: 1, objects: ["stone wall", "palm tree"], activities: ["standing against a wall"], storyRole: "portrait", color: "#c8b08a" });

  it("two close-ups of one cup in front of one sign, 4 minutes apart and dHash 14 bits apart, read as lookalikes", () => {
    expect(photoSimilarity(cup(1, 0, "ffff0000ffff0000"), cup(2, 4, "ffff0000ffff3fff"))).toBeGreaterThanOrEqual(LOOKALIKE);
  });
  it("the same person in the same pose at the same wall, minutes apart, reads as lookalikes", () => {
    expect(photoSimilarity(pose(1, 0, "0f0f0f0f0f0f0f0f"), pose(2, 6, "0f0f0f0f0f0fffff"))).toBeGreaterThanOrEqual(LOOKALIKE);
  });
  it("a cup close-up and a wide street view are not alike", () => {
    const wide = P(9, { scene: "landscape", people: 3, objects: ["street", "cars"], activities: ["walking"], storyRole: "establishing", takenAt: new Date(Date.UTC(2026, 4, 30, 13, 2)).toISOString(), phash: "0000ffff0000ffff", color: "#5b7fa6" });
    expect(photoSimilarity(cup(1, 0, "ffff0000ffff0000"), wide)).toBeLessThan(0.45);
  });
  it("the re-dealer separates such pairs: lookalike pairs per page drop to zero when the chapter has other photos", () => {
    const others = [
      P(9, { scene: "landscape", people: 3, objects: ["street", "cars"], activities: ["walking"], storyRole: "establishing", phash: "0000ffff0000ffff", color: "#5b7fa6" }),
      P(10, { scene: "group", people: 4, objects: ["fountain", "benches"], activities: ["sitting"], storyRole: "action", phash: "00ff00ff00ff00ff", color: "#6f9a5b" }),
    ];
    const units: ContrastUnit[] = [
      { id: "a", chapterId: "c1", momentId: "m1", family: "collage", photos: [cup(1, 0, "ffff0000ffff0000"), cup(2, 4, "ffff0000ffff3fff")], pinned: new Set(), capacity: 6 },
      { id: "b", chapterId: "c1", momentId: "m1", family: "collage", photos: [pose(3, 0, "0f0f0f0f0f0f0f0f"), pose(4, 6, "0f0f0f0f0f0fffff")], pinned: new Set(), capacity: 6 },
      { id: "c", chapterId: "c1", momentId: "m1", family: "collage", photos: others, pinned: new Set(), capacity: 6 },
    ];
    const pairs = () => units.reduce((n, u) => n + u.photos.filter((x, i) => u.photos.some((y, j) => j > i && photoSimilarity(x, y) >= LOOKALIKE)).length, 0);
    expect(pairs()).toBe(2);
    contrastPhotos(units);
    expect(pairs()).toBe(0);
  });
});
