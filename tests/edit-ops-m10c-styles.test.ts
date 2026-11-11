// M10c T10: the spread-aware edit ops (D-064: change layout to / from spreads, add / delete / move /
// move-to-chapter with spreads as one unit, reflow via repairSpreads) on geometric + scrapbook books,
// with the REAL catalogue (no test layouts). Seeded property walk as tests/edit-ops-spreads.test.ts,
// plus: every page stays in the book's format + style, no photo or user caption is lost silently.

import { describe, expect, it } from "vitest";
import type { BookDesign } from "@/lib/book/book-design";
import {
  addPageResult,
  changeLayout,
  defaultNewPageLayout,
  deletePageResult,
  EditOpError,
  type EditOpErrorCode,
  movePageResult,
  movePageToChapterResult,
  pageUnit,
  setCaption,
  setPageBackground,
} from "@/lib/book/edit-ops";
import { validateBookDoc } from "@/lib/book/schema";
import { isSpreadAligned, layoutsFor, repairSpreads } from "@/lib/book/spreads";
import type { BookDoc, BookPage, Caption, Layout } from "@/lib/book/types";
import { styleCaptionFont } from "@/lib/design/styles";
import { getLayout } from "@/lib/layouts";
import { bestCoverLayout } from "@/lib/layouts/fit";

const DESIGNS: readonly BookDesign[] = [
  { format: "A5_PORTRAIT", designStyle: "geometric" },
  { format: "A5_LANDSCAPE", designStyle: "geometric" },
  { format: "A5_PORTRAIT", designStyle: "scrapbook" },
  { format: "A5_LANDSCAPE", designStyle: "scrapbook" },
];
const tag = (d: BookDesign) => `${d.format}/${d.designStyle}`;

const PHOTOS = Array.from({ length: 600 }, (_, i) => `ph${i + 1}`);
const PHOTO_SET = new Set(PHOTOS);

function rng(seed: number) {
  let x = seed >>> 0;
  return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function builders(design: BookDesign) {
  let seq = 0;
  let cursor = 0;
  const font = styleCaptionFont(design.designStyle, "en");
  const nextPhoto = () => PHOTOS[cursor++ % PHOTOS.length];
  const userCap = (text: string): Caption => ({ text, font, align: "center", source: "user" });
  const aiCap = (text: string): Caption => ({ text, font, align: "center", source: "ai" });
  const single = (layout: Layout, chapterId: string, caption: Caption | null): BookPage => ({
    id: `pg${++seq}`,
    chapterId,
    layout: layout.id,
    slots: layout.slots.map(() => ({ photoId: nextPhoto(), crop: { x: 0.4, y: 0.5, zoom: 1.1 } })),
    caption: layout.caption ? caption : null,
  });
  const spread = (layout: Layout, chapterId: string, caption: Caption | null): BookPage[] => {
    const id = `sp${++seq}`;
    return [
      {
        id,
        chapterId,
        layout: layout.id,
        side: "left",
        slots: layout.slots.map(() => ({ photoId: nextPhoto(), crop: { x: 0.5, y: 0.4, zoom: 1 } })),
        caption: layout.caption ? caption : null,
      },
      { id: `${id}r`, chapterId, layout: layout.id, side: "right", slots: [], caption: null },
    ];
  };
  const docOf = (pages: BookPage[]): BookDoc => {
    const chapterIds = [...new Set(pages.map((p) => p.chapterId).filter((c): c is string => c !== null))];
    return {
      version: 2,
      format: design.format,
      occasion: "family",
      cover: { layout: bestCoverLayout(design), photoId: null, title: "T", subtitle: "" },
      chapters: (chapterIds.length ? chapterIds : ["m1"]).map((id) => ({ id, title: id, dateLabel: "", place: null })),
      pages,
      style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: design.designStyle, font },
    };
  };
  return { userCap, aiCap, single, spread, docOf };
}

const placed = (d: BookDoc) => d.pages.flatMap((p) => p.slots.map((s) => s.photoId).filter((x): x is string => !!x));
const userCaptions = (d: BookDoc) =>
  d.pages.map((p) => p.caption).filter((c): c is Caption => c?.source === "user").map((c) => c.text);
const userBackgrounds = (d: BookDoc) =>
  new Map(d.pages.filter((p) => p.background?.source === "user").map((p) => [p.id, JSON.stringify(p.background)]));

describe.each(DESIGNS)("edit ops on %o (seeded walks, real catalogue)", (design) => {
  const PAGES = layoutsFor(design.format, design.designStyle, "page");
  const SPREADS = layoutsFor(design.format, design.designStyle, "spread");
  const ALLOWED: EditOpErrorCode[] = ["page_limit", "would_drop_caption", "spread_needs_left_page", "no_caption_area"];
  const MAX = 20;
  const stats = { splits: 0, merges: 0 };

  it("the design has page and spread layouts with twins in style", () => {
    expect(PAGES.length).toBeGreaterThan(0);
    expect(SPREADS.length).toBeGreaterThan(0);
    for (const s of SPREADS) {
      for (const id of s.twin ?? []) expect(getLayout(id)).toMatchObject({ role: "page", format: design.format, style: design.designStyle });
    }
  });

  function startDoc(r: () => number, b: ReturnType<typeof builders>): BookDoc {
    const pages: BookPage[] = [];
    let cap = 0;
    const chapters = ["m1", "m2", "m3"];
    while (pages.length < 12) {
      const ch = chapters[Math.min(2, Math.floor(pages.length / 5))];
      const caption = r() < 0.5 ? b.userCap(`u-start-${++cap}`) : r() < 0.5 ? b.aiCap(`a-start-${++cap}`) : null;
      if (pages.length % 2 === 0 && r() < 0.4) pages.push(...b.spread(SPREADS[Math.floor(r() * SPREADS.length)], ch, caption));
      else pages.push(b.single(PAGES[Math.floor(r() * PAGES.length)], ch, caption));
    }
    let d = b.docOf(pages);
    for (let i = 0; i < d.pages.length; i++) if (r() < 0.3) d = setPageBackground(d, i, { kind: "color", hex: "#00AA00" });
    return d;
  }

  for (const seed of [11, 22, 33, 44, 55, 66, 77, 88]) {
    it(`seed ${seed}: 80 ops keep the doc aligned, valid, in style, within limits, losing nothing silently`, () => {
      const r = rng(seed + design.format.length * 1000 + design.designStyle.length);
      const b = builders(design);
      let d = startDoc(r, b);
      const valid = (x: BookDoc) => validateBookDoc(x, { photoIds: PHOTO_SET, maxPages: MAX });
      expect(valid(d)).toEqual([]);
      let capN = 0;
      let applied = 0;
      for (let step = 0; step < 80; step++) {
        const n = d.pages.length;
        const pi = Math.floor(r() * n);
        const kind = n === 0 ? 0 : Math.floor(r() * 7);
        const before = d;
        let gone: { photos: string[]; captions: Caption[]; deletedIds: string[] } = { photos: [], captions: [], deletedIds: [] };
        try {
          switch (kind) {
            case 0: {
              const res = addPageResult(d, Math.floor(r() * (n + 1)) - 1, PAGES[Math.floor(r() * PAGES.length)].id, MAX);
              stats.splits += res.splitCount;
              d = res.doc;
              break;
            }
            case 1: {
              const unit = pageUnit(d, pi);
              const removed = d.pages.slice(unit.start, unit.start + unit.count);
              const res = deletePageResult(d, pi, MAX);
              stats.splits += res.splitCount;
              expect(res.pagesRemoved).toBe(unit.count);
              gone = {
                photos: res.removedPhotoIds,
                captions: removed.map((p) => p.caption).filter((c): c is Caption => c !== null),
                deletedIds: removed.map((p) => p.id),
              };
              d = res.doc;
              break;
            }
            case 2: {
              const res = movePageResult(d, pi, Math.floor(r() * n), MAX);
              stats.splits += res.splitCount;
              d = res.doc;
              break;
            }
            case 3: {
              if (d.chapters.length === 0) continue;
              const res = movePageToChapterResult(d, pi, d.chapters[Math.floor(r() * d.chapters.length)].id, MAX);
              stats.splits += res.splitCount;
              d = res.doc;
              break;
            }
            case 4:
            case 5: {
              const toSpread = kind === 4;
              const id = toSpread ? SPREADS[Math.floor(r() * SPREADS.length)].id : PAGES[Math.floor(r() * PAGES.length)].id;
              const res = changeLayout(d, pi, id, { maxPages: MAX, confirmDropCaptions: r() < 0.5 });
              stats.splits += res.splitCount;
              if (toSpread && res.doc !== d) stats.merges++;
              gone = { photos: res.removedPhotoIds, captions: res.droppedCaptions, deletedIds: [] };
              d = res.doc;
              break;
            }
            case 6:
              d = setCaption(d, pi, `u-new-${++capN}`);
              if (d !== before && before.pages[pi].caption) gone.captions = [before.pages[pi].caption!];
              break;
          }
        } catch (e) {
          if (!(e instanceof EditOpError)) throw e;
          expect(ALLOWED, `${tag(design)} seed ${seed} step ${step} op ${kind}: unexpected ${e.code}`).toContain(e.code);
          d = before;
          continue;
        }
        if (d !== before) applied++;
        const at = `${tag(design)} seed ${seed} step ${step} op ${kind}`;
        expect(isSpreadAligned(d), at).toBe(true);
        expect(valid(d), at).toEqual([]);
        expect(d.pages.length, at).toBeLessThanOrEqual(MAX);
        for (const p of d.pages) {
          expect(getLayout(p.layout), `${at} ${p.layout}`).toMatchObject({ format: design.format, style: design.designStyle });
        }

        const pb = placed(before);
        const pa = placed(d);
        expect(new Set(pa).size, at).toBe(pa.length);
        expect(pb.filter((p) => !pa.includes(p)).sort(), at).toEqual([...gone.photos].sort());
        expect(pa.every((p) => pb.includes(p)), at).toBe(true);

        const missing = userCaptions(before).filter((t) => !userCaptions(d).includes(t));
        const allowed = gone.captions.filter((c) => c.source === "user").map((c) => c.text);
        expect(missing.every((t) => allowed.includes(t)), `${at}: lost ${missing} allowed ${allowed}`).toBe(true);

        const ba = userBackgrounds(d);
        for (const [id, bg] of userBackgrounds(before)) {
          if (gone.deletedIds.includes(id)) continue;
          expect(ba.get(id), `${at}: background of ${id}`).toBe(bg);
        }
        const ids = new Set(d.pages.map((p) => p.id));
        for (const p of before.pages) if (!gone.deletedIds.includes(p.id)) expect(ids.has(p.id), at).toBe(true);
      }
      expect(applied).toBeGreaterThan(20);
    });
  }

  it("the walks exercised reflow splits and spread merges", () => {
    expect(stats.splits).toBeGreaterThan(3);
    expect(stats.merges).toBeGreaterThan(3);
  });

  it("addPage default layout is a single page of the style with a caption area", () => {
    const b = builders(design);
    const d = b.docOf([b.single(PAGES[0], "m1", null)]);
    const id = defaultNewPageLayout(d);
    expect(getLayout(id)).toMatchObject({ role: "page", photoCount: 1, format: design.format, style: design.designStyle });
    expect(getLayout(id)?.caption).not.toBeNull();
    expect(getLayout(addPageResult(d, 0).doc.pages[1].layout)?.style).toBe(design.designStyle);
  });

  it("repairSpreads splits every misaligned spread of the style into in-style pages, photos + captions kept", () => {
    for (const s of SPREADS) {
      const b = builders(design);
      const pages = [b.single(PAGES[0], "m1", null), ...b.spread(s, "m1", b.userCap("keep me"))];
      const d = b.docOf(pages);
      const rep = repairSpreads(d);
      expect(rep.splitCount, s.id).toBe(1);
      expect(isSpreadAligned(rep.doc)).toBe(true);
      for (const p of rep.doc.pages) expect(getLayout(p.layout)).toMatchObject({ role: "page", format: design.format, style: design.designStyle });
      expect(new Set(placed(rep.doc))).toEqual(new Set(placed(d)));
      expect(userCaptions(rep.doc)).toEqual(["keep me"]);
      expect(validateBookDoc(rep.doc, { photoIds: PHOTO_SET, maxPages: 100 })).toEqual([]);
    }
  });
});
