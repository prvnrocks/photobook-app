// M10b A7 — spread-aware edit ops (D-064): changeLayout to/from spreads (merge / split), spreads
// as one unit in add / delete / move / move-to-chapter, reflow via repairSpreads (splitCount),
// "would_drop_caption" confirm, page limits, repair fallback stays in the book's format + style,
// and a seeded property test over random op sequences. Uses the TEST-ONLY spreads
// (tests/fixtures/test-spread-layouts.ts) plus one test modern spread defined below.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/layouts", async (orig) => {
  const { withTestSpreads } = await import("./fixtures/test-spread-layouts");
  const real = withTestSpreads(await orig<typeof import("@/lib/layouts")>());
  // A modern spread whose twin (test-modern-one) holds 1 photo: a split must overflow onto more
  // MODERN pages, never fall back to a classic layout.
  const modernSpread: import("@/lib/book/types").Layout = {
    id: "test-modern-spread",
    name: "Test modern spread: 3 + 1",
    role: "spread",
    style: "modern",
    format: "A5_PORTRAIT",
    photoCount: 4,
    prefers: ["any", "any", "any", "any"],
    slots: [
      { x: 5, y: 5, w: 90, h: 28 },
      { x: 5, y: 35, w: 90, h: 28 },
      { x: 5, y: 65, w: 90, h: 28 },
      { x: 100, y: 0, w: 100, h: 100 },
    ],
    caption: null,
    twin: ["test-modern-one", "test-modern-one"],
  };
  const all = [...real.LAYOUTS, modernSpread];
  const byId = new Map(all.map((l) => [l.id, l]));
  return { ...real, LAYOUTS: all, LAYOUT_IDS: all.map((l) => l.id), getLayout: (id: string) => byId.get(id) };
});

import {
  addPageResult,
  changeLayout,
  deletePageResult,
  EditOpError,
  type EditOpErrorCode,
  movePageResult,
  movePageToChapterResult,
  pageUnit,
  planChangeLayout,
  setCaption,
  setPageBackground,
} from "@/lib/book/edit-ops";
import { validateBookDoc } from "@/lib/book/schema";
import { isSpreadAligned, layoutsFor, repairSpreads } from "@/lib/book/spreads";
import type { BookDoc, BookPage, Caption, Layout } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";
import { TEST_SPREAD_A, TEST_SPREAD_B, TEST_SPREAD_C } from "./fixtures/test-spread-layouts";

// --- builders ------------------------------------------------------------------------------------

let seq = 0;
const PHOTOS = Array.from({ length: 400 }, (_, i) => `ph${i + 1}`);
const PHOTO_SET = new Set(PHOTOS);
let photoCursor = 0;
const nextPhoto = () => PHOTOS[photoCursor++ % PHOTOS.length];
const userCap = (text: string): Caption => ({ text, font: "Playfair", align: "center", source: "user" });
const aiCap = (text: string): Caption => ({ text, font: "Playfair", align: "center", source: "ai" });

function single(layoutId: string, chapterId = "m1", caption: Caption | null = null): BookPage {
  const l = getLayout(layoutId)!;
  return {
    id: `pg${++seq}`,
    chapterId,
    layout: l.id,
    slots: l.slots.map(() => ({ photoId: nextPhoto(), crop: { x: 0.3, y: 0.5, zoom: 1.2 } })),
    caption: l.caption ? caption : null,
  };
}

function spread(layout: Layout, chapterId = "m1", caption: Caption | null = null): [BookPage, BookPage] {
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
}

function docOf(pages: BookPage[], designStyle: "classic" | "modern" = "classic"): BookDoc {
  const chapterIds = [...new Set(pages.map((p) => p.chapterId).filter((c): c is string => c !== null))];
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "other",
    cover: { layout: "cover", photoId: null, title: "T", subtitle: "" },
    chapters: (chapterIds.length ? chapterIds : ["m1"]).map((id) => ({ id, title: id, dateLabel: "", place: null })),
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle, font: "Playfair" },
  };
}

const placed = (d: BookDoc) => d.pages.flatMap((p) => p.slots.map((s) => s.photoId).filter((x): x is string => !!x));
const valid = (d: BookDoc, maxPages = 100) => validateBookDoc(d, { photoIds: PHOTO_SET, maxPages });
const code = (fn: () => unknown): EditOpErrorCode | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof EditOpError) return e.code;
    throw e;
  }
};
const RED = { kind: "color", hex: "#AA0000" } as const;

// --- changeLayout → spread (merge) -----------------------------------------------------------------

describe("changeLayout to a spread", () => {
  it("merges the left page and the next page: photos in order, leftovers unused, right page keeps id/background", () => {
    const a = single("two-vertical", "m1", userCap("left words"));
    const b = single("three-mixed", "m1", null);
    const c = single("one-portrait");
    let d = docOf([a, b, c]);
    d = setPageBackground(d, 1, RED);
    const before = placed(d);
    const r = changeLayout(d, 0, TEST_SPREAD_A.id);
    const [l, rt] = r.doc.pages;
    expect(l).toMatchObject({ id: a.id, layout: TEST_SPREAD_A.id, side: "left" });
    expect(rt).toMatchObject({ id: b.id, layout: TEST_SPREAD_A.id, side: "right", slots: [], caption: null });
    expect(rt.background).toEqual({ ...RED, source: "user" });
    expect(l.slots.map((s) => s.photoId)).toEqual(before.slice(0, 3));
    expect(l.slots[0].crop).toEqual(a.slots[0].crop);
    expect(r.removedPhotoIds).toEqual(before.slice(3, 5));
    expect(l.caption).toEqual(userCap("left words"));
    expect(r).toMatchObject({ pageIdx: 0, pagesAdded: 0, splitCount: 0, droppedCaptions: [] });
    expect(r.doc.pages[2]).toBe(c);
    expect(valid(r.doc)).toEqual([]);
  });

  it("a user caption on the right page moves to the spread when the left page has none", () => {
    const a = single("two-vertical", "m1", aiCap("ai words"));
    const b = single("one-portrait", "m1", userCap("right words"));
    const r = changeLayout(docOf([a, b]), 0, TEST_SPREAD_A.id, { confirmDropCaptions: false });
    expect(r.doc.pages[0].caption).toEqual(userCap("right words"));
    expect(r.droppedCaptions).toEqual([aiCap("ai words")]); // AI captions may go without asking
  });

  it("refuses to drop a user caption without confirmation; planChangeLayout tells the UI what would go", () => {
    const a = single("two-vertical", "m1", userCap("one"));
    const b = single("one-portrait", "m1", userCap("two"));
    const d = docOf([a, b]);
    expect(code(() => changeLayout(d, 0, TEST_SPREAD_A.id))).toBe("would_drop_caption");
    const plan = planChangeLayout(d, 0, TEST_SPREAD_A.id);
    expect(plan).toMatchObject({ ok: true, needsConfirm: true, droppedUserCaptions: [userCap("two")] });
    const r = changeLayout(d, 0, TEST_SPREAD_A.id, { confirmDropCaptions: true });
    expect(r.doc.pages[0].caption).toEqual(userCap("one"));
    expect(r.droppedCaption).toEqual(userCap("two"));
    // A spread without a caption area would drop both.
    expect(code(() => changeLayout(d, 0, TEST_SPREAD_C.id))).toBe("would_drop_caption");
    expect(planChangeLayout(d, 0, TEST_SPREAD_C.id)).toMatchObject({ needsConfirm: true });
  });

  it("only on a left-hand page; a half of an existing spread re-lays out that spread", () => {
    const d = docOf([single("one-portrait"), single("one-portrait"), ...spread(TEST_SPREAD_A)]);
    expect(code(() => changeLayout(d, 1, TEST_SPREAD_B.id))).toBe("spread_needs_left_page");
    expect(planChangeLayout(d, 1, TEST_SPREAD_B.id)).toEqual({ ok: false, code: "spread_needs_left_page" });
    const photos = placed(d).slice(2);
    const r = changeLayout(d, 3, TEST_SPREAD_B.id); // the right half
    expect(r.pageIdx).toBe(2);
    expect(r.doc.pages[2].layout).toBe(TEST_SPREAD_B.id);
    expect(r.doc.pages[2].slots.slice(0, 3).map((s) => s.photoId)).toEqual(photos);
    expect(r.doc.pages[3]).toMatchObject({ side: "right", layout: TEST_SPREAD_B.id });
    expect(changeLayout(r.doc, 2, TEST_SPREAD_B.id).doc).toBe(r.doc); // same spread → no-op
    expect(valid(r.doc)).toEqual([]);
  });

  it("on the last page adds the right half when the limit allows, else page_limit", () => {
    const d = docOf([single("one-portrait"), single("one-portrait"), single("two-vertical")]);
    const r = changeLayout(d, 2, TEST_SPREAD_A.id, { maxPages: 4 });
    expect(r.pagesAdded).toBe(1);
    expect(r.doc.pages).toHaveLength(4);
    expect(r.doc.pages[3]).toMatchObject({ side: "right", slots: [], caption: null, chapterId: "m1" });
    expect(valid(r.doc, 4)).toEqual([]);
    expect(code(() => changeLayout(d, 2, TEST_SPREAD_A.id, { maxPages: 3 }))).toBe("page_limit");
  });

  it("refuses layouts of another format or style (D-063)", () => {
    const d = docOf([single("one-portrait"), single("one-portrait")]);
    expect(code(() => changeLayout(d, 0, "test-modern-one"))).toBe("layout_not_for_book");
    expect(code(() => changeLayout(d, 0, "test-modern-spread"))).toBe("layout_not_for_book");
    expect(code(() => addPageResult(d, 0, "test-modern-one"))).toBe("layout_not_for_book");
  });
});

// --- changeLayout spread → single (split) --------------------------------------------------------

describe("changeLayout from a spread to a single layout", () => {
  it("splits into twins first (both pages restored, nothing lost), then changes the tapped half", () => {
    const [l, r] = spread(TEST_SPREAD_A, "m1", userCap("spread words"));
    const d = setPageBackground(docOf([l, r]), 1, RED);
    const photos = placed(d);
    // Tap the right half, pick four-grid: right half's 2 photos + caption stay there.
    const res = changeLayout(d, 1, "four-grid");
    expect(res.doc.pages.map((p) => p.layout)).toEqual(["full-page", "four-grid"]);
    expect(res.doc.pages.map((p) => p.id)).toEqual([l.id, r.id]);
    expect(res.doc.pages.every((p) => p.side === undefined)).toBe(true);
    expect(res.doc.pages[1].background).toEqual({ ...RED, source: "user" });
    expect(res.doc.pages[1].caption).toEqual(userCap("spread words"));
    expect(placed(res.doc)).toEqual(photos);
    expect(res).toMatchObject({ pageIdx: 1, removedPhotoIds: [], droppedCaptions: [], splitCount: 0 });
    expect(valid(res.doc)).toEqual([]);
  });

  it("photos beyond the chosen layout become unused (reported), like a single page", () => {
    const d = docOf(spread(TEST_SPREAD_B));
    const photos = placed(d);
    const res = changeLayout(d, 0, "two-vertical"); // left half had 4
    expect(res.removedPhotoIds).toEqual(photos.slice(2, 4));
    expect([...placed(res.doc), ...res.removedPhotoIds].sort()).toEqual([...photos].sort());
  });
});

// --- units: add / delete / move -----------------------------------------------------------------

describe("spreads are one unit", () => {
  const book = () =>
    docOf([single("one-portrait"), single("two-vertical"), ...spread(TEST_SPREAD_A), single("full-page"), single("one-portrait")]);

  it("pageUnit + delete either half removes both (pagesRemoved 2), photos reported", () => {
    const d = book();
    expect(pageUnit(d, 3)).toEqual({ start: 2, count: 2 });
    expect(pageUnit(d, 1)).toEqual({ start: 1, count: 1 });
    const r = deletePageResult(d, 3);
    expect(r.pagesRemoved).toBe(2);
    expect(r.removedPhotoIds).toEqual(d.pages[2].slots.map((s) => s.photoId));
    expect(r.doc.pages.map((p) => p.id)).toEqual([d.pages[0].id, d.pages[1].id, d.pages[4].id, d.pages[5].id]);
    expect(r.splitCount).toBe(0);
  });

  it("deleting a single page before a spread splits it (splitCount) without losing photos", () => {
    const d = book();
    const r = deletePageResult(d, 0);
    expect(r.splitCount).toBe(1);
    expect(isSpreadAligned(r.doc)).toBe(true);
    expect(placed(r.doc).sort()).toEqual(placed(d).slice(1).sort());
    expect(valid(r.doc)).toEqual([]);
  });

  it("add after either half inserts after the whole spread", () => {
    const d = book();
    for (const after of [2, 3]) {
      const r = addPageResult(d, after, "one-portrait");
      expect(r.pageIdx).toBe(4);
      expect(r.splitCount).toBe(0);
      expect(r.doc.pages[2].side).toBe("left");
      expect(r.doc.pages[3].side).toBe("right");
    }
    const atStart = addPageResult(d, -1);
    expect(atStart.splitCount).toBe(1); // the spread got pushed to an odd index
    expect(valid(atStart.doc)).toEqual([]);
  });

  it("move takes the pair and lands it on an even index (never splits it)", () => {
    const d = book();
    const fwd = movePageResult(d, 2, 3); // drag left half one forward → snaps to 4
    expect(fwd.doc.pages.map((p) => p.side ?? "-")).toEqual(["-", "-", "-", "-", "left", "right"]);
    expect(fwd).toMatchObject({ pageIdx: 4, splitCount: 0 });
    const back = movePageResult(d, 3, 1); // right half dragged to index 1 → pair at 0
    expect(back.doc.pages[0]).toMatchObject({ side: "left", id: d.pages[2].id });
    expect(back.splitCount).toBe(0);
    expect(valid(back.doc)).toEqual([]);
  });

  it("a single page never lands between a spread's halves", () => {
    const d = book();
    const r = movePageResult(d, 0, 2); // would sit between halves 2/3 → goes after the spread
    expect(r.doc.pages.findIndex((p) => p.id === d.pages[0].id)).toBe(3);
    expect(isSpreadAligned(r.doc)).toBe(true);
    expect(placed(r.doc).sort()).toEqual(placed(d).sort());
  });

  it("move to chapter moves the pair and keeps it intact", () => {
    const [l, r] = spread(TEST_SPREAD_A, "m1");
    const d = docOf([l, r, single("one-portrait", "m2"), single("one-portrait", "m2"), single("one-portrait", "m3")]);
    const res = movePageToChapterResult(d, 1, "m2");
    expect(res.doc.pages.slice(2, 4).map((p) => p.id)).toEqual([l.id, r.id]);
    expect(res.doc.pages[2].chapterId).toBe("m2");
    expect(res.doc.pages[3].chapterId).toBe("m2");
    expect(res.doc.chapters.map((c) => c.id)).toEqual(["m2", "m3"]);
    expect(res.splitCount).toBe(0);
    expect(valid(res.doc)).toEqual([]);
  });

  it("an op whose reflow would exceed maxPages throws page_limit", () => {
    // C splits 6+6 photos; classic singles hold ≤ 4 → overflow pages.
    const d = docOf([single("one-portrait"), single("one-portrait"), ...spread(TEST_SPREAD_C)]);
    expect(code(() => deletePageResult(d, 0, 4))).toBe("page_limit");
    const ok = deletePageResult(d, 0, 100);
    expect(ok.doc.pages.length).toBeGreaterThan(3);
    expect(placed(ok.doc).sort()).toEqual(placed(d).slice(1).sort());
  });
});

// --- repair fallback stays in format + style ----------------------------------------------------

describe("repairSpreads fallback stays in the doc's format and style", () => {
  it("a misaligned modern spread overflows onto modern pages, never classic ones", () => {
    const pages = [single("test-modern-one", "m1"), ...spread(getLayout("test-modern-spread")!)];
    const d = docOf(pages, "modern");
    const photos = placed(d);
    const r = repairSpreads(d);
    expect(r.splitCount).toBe(1);
    for (const p of r.doc.pages) expect(getLayout(p.layout)?.style).toBe("modern");
    expect(placed(r.doc).sort()).toEqual([...photos].sort());
  });

  it("a classic split never picks the modern page (picker of another style is ignored)", () => {
    const d = docOf([single("one-portrait"), ...spread(TEST_SPREAD_B)]);
    const r = repairSpreads(d, { pickPageLayout: () => "test-modern-one" });
    for (const p of r.doc.pages) expect(getLayout(p.layout)?.style).toBe("classic");
    expect(valid(r.doc)).toEqual([]);
  });
});

// --- property test ----------------------------------------------------------------------------------

describe("random op sequences over docs with spreads (seeded)", () => {
  function rng(seed: number) {
    let x = seed >>> 0;
    return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  }
  const PAGE_IDS = layoutsFor("A5_PORTRAIT", "classic", "page").map((l) => l.id);
  const SPREAD_IDS = [TEST_SPREAD_A.id, TEST_SPREAD_B.id, TEST_SPREAD_C.id];
  const ALLOWED: EditOpErrorCode[] = ["page_limit", "would_drop_caption", "spread_needs_left_page", "no_caption_area"];
  const MAX = 20;
  const stats = { splits: 0, merges: 0 };
  const tally = <T extends { splitCount: number }>(res: T): T => {
    stats.splits += res.splitCount;
    return res;
  };

  function startDoc(r: () => number): BookDoc {
    const pages: BookPage[] = [];
    let cap = 0;
    const chapters = ["m1", "m2", "m3"];
    while (pages.length < 12) {
      const ch = chapters[Math.min(2, Math.floor(pages.length / 5))];
      const caption = r() < 0.5 ? userCap(`u-start-${++cap}`) : r() < 0.5 ? aiCap(`a-start-${++cap}`) : null;
      if (pages.length % 2 === 0 && r() < 0.4) {
        pages.push(...spread(getLayout(SPREAD_IDS[Math.floor(r() * 3)])!, ch, caption));
      } else {
        pages.push(single(PAGE_IDS[Math.floor(r() * PAGE_IDS.length)], ch, caption));
      }
    }
    let d = docOf(pages);
    for (let i = 0; i < d.pages.length; i++) if (r() < 0.3) d = setPageBackground(d, i, { kind: "color", hex: "#00AA00" });
    return d;
  }

  const userCaptions = (d: BookDoc) =>
    d.pages.map((p) => p.caption).filter((c): c is Caption => c?.source === "user").map((c) => c.text);
  const userBackgrounds = (d: BookDoc) =>
    new Map(d.pages.filter((p) => p.background?.source === "user").map((p) => [p.id, JSON.stringify(p.background)]));

  for (const seed of [11, 22, 33, 44, 55, 66, 77, 88, 99, 123]) {
    it(`seed ${seed}: 80 ops keep the doc aligned, valid, within limits, and lose nothing silently`, () => {
      const r = rng(seed);
      let d = startDoc(r);
      expect(valid(d, MAX)).toEqual([]);
      let capN = 0;
      let applied = 0;
      for (let step = 0; step < 80; step++) {
        const n = d.pages.length;
        const pi = Math.floor(r() * n);
        const roll = Math.floor(r() * 7);
        const kind = n === 0 ? 0 : roll; // an empty book can only grow
        const before = d;
        // Each op reports what legitimately left the pages.
        let gone: { photos: string[]; captions: Caption[]; deletedIds: string[] } = { photos: [], captions: [], deletedIds: [] };
        try {
          switch (kind) {
            case 0: {
              const res = tally(addPageResult(d, Math.floor(r() * (n + 1)) - 1, PAGE_IDS[Math.floor(r() * PAGE_IDS.length)], MAX));
              d = res.doc;
              break;
            }
            case 1: {
              const unit = pageUnit(d, pi);
              const removed = d.pages.slice(unit.start, unit.start + unit.count);
              const res = tally(deletePageResult(d, pi, MAX));
              expect(res.pagesRemoved).toBe(unit.count);
              gone = {
                photos: res.removedPhotoIds,
                captions: removed.map((p) => p.caption).filter((c): c is Caption => c !== null),
                deletedIds: removed.map((p) => p.id),
              };
              d = res.doc;
              break;
            }
            case 2:
              d = tally(movePageResult(d, pi, Math.floor(r() * n), MAX)).doc;
              break;
            case 3:
              if (d.chapters.length === 0) continue; // book emptied (chapters pruned) and re-grown without one
              d = tally(movePageToChapterResult(d, pi, d.chapters[Math.floor(r() * d.chapters.length)].id, MAX)).doc;
              break;
            case 4:
            case 5: {
              const toSpread = kind === 4;
              const id = toSpread ? SPREAD_IDS[Math.floor(r() * 3)] : PAGE_IDS[Math.floor(r() * PAGE_IDS.length)];
              const res = tally(changeLayout(d, pi, id, { maxPages: MAX, confirmDropCaptions: r() < 0.5 }));
              if (toSpread && res.doc !== d) stats.merges++;
              gone = { photos: res.removedPhotoIds, captions: res.droppedCaptions, deletedIds: [] };
              if (toSpread) expect(res.doc.pages[res.pageIdx].side).toBe(res.doc === d ? d.pages[res.pageIdx].side : "left");
              d = res.doc;
              break;
            }
            case 6:
              d = setCaption(d, pi, `u-new-${++capN}`);
              // Replaced captions are a user edit, not a loss: count the old one as gone.
              if (d !== before && before.pages[pi].caption) gone.captions = [before.pages[pi].caption!];
              break;
          }
        } catch (e) {
          if (!(e instanceof EditOpError)) throw e;
          expect(ALLOWED, `seed ${seed} step ${step} op ${kind} n ${n}: unexpected ${e.code}`).toContain(e.code);
          d = before;
          continue;
        }
        if (d !== before) applied++;
        const at = `seed ${seed} step ${step} op ${kind}`;
        expect(isSpreadAligned(d), at).toBe(true);
        expect(valid(d, MAX), at).toEqual([]);
        expect(d.pages.length, at).toBeLessThanOrEqual(MAX);

        // Photos: nothing new, no duplicates, and exactly the reported ones left the pages.
        const pb = placed(before);
        const pa = placed(d);
        expect(new Set(pa).size, at).toBe(pa.length);
        const lost = pb.filter((p) => !pa.includes(p)).sort();
        expect(lost, at).toEqual([...gone.photos].sort());
        expect(pa.every((p) => pb.includes(p)), at).toBe(true);

        // User captions: only deleted / explicitly dropped / replaced ones may disappear.
        const ub = userCaptions(before);
        const ua = userCaptions(d);
        const missing = ub.filter((t) => !ua.includes(t)).sort();
        const allowed = gone.captions.filter((c) => c.source === "user").map((c) => c.text);
        expect(missing.every((t) => allowed.includes(t)), `${at}: lost ${missing} allowed ${allowed}`).toBe(true);
        // A spread change without confirm never drops a user caption.

        // User backgrounds: every surviving page keeps its own.
        const ba = userBackgrounds(d);
        for (const [id, bg] of userBackgrounds(before)) {
          if (gone.deletedIds.includes(id)) continue;
          expect(ba.get(id), `${at}: background of ${id}`).toBe(bg);
        }
        // No page vanishes except deleted ones.
        const ids = new Set(d.pages.map((p) => p.id));
        for (const p of before.pages) if (!gone.deletedIds.includes(p.id)) expect(ids.has(p.id), at).toBe(true);
      }
      expect(applied).toBeGreaterThan(20);
    });
  }

  it("the walks exercised reflow splits and spread merges", () => {
    expect(stats.splits).toBeGreaterThan(5);
    expect(stats.merges).toBeGreaterThan(5);
  });
});

describe("addPage default layout follows the book's style", () => {
  it("classic → one-portrait; modern → a modern single page", () => {
    const classic = docOf([single("one-portrait")]);
    expect(addPageResult(classic, 0).doc.pages[1].layout).toBe("one-portrait");
    const modern = docOf([single("test-modern-one")], "modern");
    const added = addPageResult(modern, 0).doc.pages[1].layout;
    expect(getLayout(added)?.style).toBe("modern");
    expect(getLayout(added)?.role).toBe("page");
  });
});
