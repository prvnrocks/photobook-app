// M10b A2 — spread storage model + D-064 repair (src/lib/book/spreads.ts), spread / format checks
// in validateBookDoc, usesV2Features for spreads / non-classic layouts / v2 fonts. Uses TEST-ONLY
// spread layouts (tests/fixtures/test-spread-layouts.ts) mocked into the catalogue.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/layouts", async (orig) => {
  const { withTestSpreads } = await import("./fixtures/test-spread-layouts");
  return withTestSpreads(await orig<typeof import("@/lib/layouts")>());
});

import { serializeDoc, usesV2Features } from "@/lib/book/doc-version";
import { V2_CAPTION_FONTS } from "@/lib/book/fonts-v2";
import { LayoutSchema, parseBookDoc, TEXT_FONT_ROLES, validateBookDoc } from "@/lib/book/schema";
import { TEXT_ROLES } from "@/lib/design/styles";
import {
  isSpreadAligned,
  layoutsFor,
  rectHalf,
  repairSpreads,
  spreadIssues,
  spreadStartOf,
  toPageRect,
} from "@/lib/book/spreads";
import type { BookDoc, BookPage, Caption, Layout } from "@/lib/book/types";
import { getLayout, LAYOUTS } from "@/lib/layouts";
import { pagesOfSpread, spreadOfPage } from "@/lib/editor/spreads";
import { TEST_MODERN_PAGE, TEST_SPREAD_A, TEST_SPREAD_B, TEST_SPREAD_C, TEST_SPREADS } from "./fixtures/test-spread-layouts";

// --- builders ------------------------------------------------------------------------------------

let seq = 0;
const fresh = (prefix: string) => `${prefix}${++seq}`;
const crop = (n: number) => ({ x: (n % 10) / 10, y: 0.5, zoom: 1 + (n % 3) / 10 });
const caption = (text: string): Caption => ({ text, font: "Playfair", align: "center", source: "user" });

const SINGLE_CYCLE = ["one-portrait", "two-vertical", "full-page", "three-mixed", "four-grid", "two-horizontal"];

function single(layoutId = SINGLE_CYCLE[seq % SINGLE_CYCLE.length]): BookPage {
  const l = getLayout(layoutId)!;
  const id = fresh("pg");
  return {
    id,
    chapterId: "m1",
    layout: l.id,
    slots: l.slots.map(() => {
      const n = ++seq;
      return { photoId: `ph${n}`, crop: crop(n) };
    }),
    caption: l.caption ? caption(`cap ${id}`) : null,
  };
}

function spread(layout: Layout): [BookPage, BookPage] {
  const id = fresh("sp");
  const left: BookPage = {
    id,
    chapterId: "m1",
    layout: layout.id,
    side: "left",
    slots: layout.slots.map(() => {
      const n = ++seq;
      return { photoId: `ph${n}`, crop: crop(n) };
    }),
    caption: layout.caption ? caption(`cap ${id}`) : null,
  };
  const right: BookPage = { id: `${id}r`, chapterId: "m1", layout: layout.id, side: "right", slots: [], caption: null };
  return [left, right];
}

function docOf(pages: BookPage[]): BookDoc {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "other",
    cover: { layout: "cover", photoId: null, title: "T", subtitle: "" },
    chapters: [{ id: "m1", title: "Moment", dateLabel: "", place: null }],
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "classic", font: "Playfair" },
  };
}

/** Aligned doc of exactly `length` pages: tokens S (single) / A,B,C (spreads), padded with singles. */
function alignedDoc(length: number, tokens = ["S", "A", "S", "B", "S", "S", "C", "A", "S", "B"]): BookDoc {
  const pages: BookPage[] = [];
  const spreads: Record<string, Layout> = { A: TEST_SPREAD_A, B: TEST_SPREAD_B, C: TEST_SPREAD_C };
  for (const t of tokens) {
    if (t === "S") {
      if (pages.length + 1 > length) break;
      pages.push(single());
      continue;
    }
    if (pages.length % 2 === 1) {
      if (pages.length + 1 > length) break;
      pages.push(single());
    }
    if (pages.length + 2 > length) break;
    pages.push(...spread(spreads[t]));
  }
  while (pages.length < length) pages.push(single());
  const doc = docOf(pages);
  expect(isSpreadAligned(doc)).toBe(true);
  return doc;
}

const photosOf = (pages: readonly BookPage[]) =>
  pages.flatMap((p) => p.slots.map((s) => s.photoId).filter((x): x is string => x !== null)).sort();
const captionsOf = (pages: readonly BookPage[]) =>
  pages.flatMap((p) => (p.caption ? [p.caption.text] : [])).sort();
const leftHalves = (pages: readonly BookPage[]) =>
  pages.filter((p) => p.side === "left" && getLayout(p.layout)?.role === "spread").length;
const isRightHalf = (p: BookPage) => p.side === "right" && getLayout(p.layout)?.role === "spread";
/** Shallow copy without `key`. */
function omit<T extends object, K extends keyof T>(o: T, key: K): Omit<T, K> {
  const c = { ...o };
  delete c[key];
  return c;
}
const cropOf = (pages: readonly BookPage[]) =>
  new Map(pages.flatMap((p) => p.slots.flatMap((s) => (s.photoId ? [[s.photoId, s.crop] as const] : []))));

/** Unit-aware ops (a spread moves/deletes as one unit, D-064); insert is raw (any index). */
function insertAt(doc: BookDoc, k: number): BookDoc {
  const pages = doc.pages.slice();
  pages.splice(k, 0, single("one-portrait"));
  return { ...doc, pages };
}
function unitAt(doc: BookDoc, k: number): [number, number] {
  const start = spreadStartOf(doc, k);
  return start === null ? [k, 1] : [start, 2];
}
function deleteAt(doc: BookDoc, k: number): BookDoc {
  const [start, n] = unitAt(doc, k);
  const pages = doc.pages.slice();
  pages.splice(start, n);
  return { ...doc, pages };
}
function moveUnit(doc: BookDoc, from: number, to: number): BookDoc {
  const [start, n] = unitAt(doc, from);
  const pages = doc.pages.slice();
  const unit = pages.splice(start, n);
  pages.splice(Math.min(to, pages.length), 0, ...unit);
  return { ...doc, pages };
}

/** Every invariant of D-064 on repairSpreads(opDoc). */
function checkRepair(opDoc: BookDoc) {
  const r = repairSpreads(opDoc);
  const out = r.doc.pages;
  expect(isSpreadAligned(r.doc)).toBe(true);
  const allPhotos = new Set(photosOf(opDoc.pages));
  expect(validateBookDoc(r.doc, { photoIds: allPhotos, maxPages: 1000 })).toEqual([]);
  // never drops photos or captions, crops travel with their photo
  expect(photosOf(out)).toEqual(photosOf(opDoc.pages));
  expect(captionsOf(out)).toEqual(captionsOf(opDoc.pages));
  const before = cropOf(opDoc.pages);
  for (const [id, c] of cropOf(out)) expect(c).toEqual(before.get(id));
  // no blank pages: every page has content, except the right half of an aligned spread
  for (const p of out) {
    if (!isRightHalf(p)) expect(p.slots.some((s) => s.photoId !== null) || p.caption !== null).toBe(true);
  }
  // every spread is kept or split; none vanishes or appears
  expect(leftHalves(out) + r.splitCount).toBe(leftHalves(opDoc.pages));
  expect(out.length).toBeGreaterThanOrEqual(opDoc.pages.length - r.droppedHalves);
  // the same pairing the editor + viewer show: a left half is the left page of its open spread
  out.forEach((p, i) => {
    if (p.side === "left") expect(pagesOfSpread(spreadOfPage(i), out.length)).toEqual([i, i + 1]);
  });
  // unique page ids; already aligned → untouched (same object)
  expect(new Set(out.map((p) => p.id)).size).toBe(out.length);
  if (isSpreadAligned(opDoc)) {
    expect(r.doc).toBe(opDoc);
    expect(r.splitCount).toBe(0);
  }
  // idempotent
  expect(repairSpreads(r.doc).doc).toBe(r.doc);
  return r;
}

// --- catalogue + schema --------------------------------------------------------------------------

describe("layout schema v2", () => {
  it("the 7 shipping layouts are classic A5 portrait, ids unchanged, no spreads", async () => {
    const real = await vi.importActual<typeof import("@/lib/layouts")>("@/lib/layouts");
    expect(real.LAYOUTS.map((l) => l.id)).toEqual([
      "cover",
      "full-page",
      "one-portrait",
      "two-vertical",
      "two-horizontal",
      "three-mixed",
      "four-grid",
    ]);
    for (const l of real.LAYOUTS) {
      expect(l.style).toBe("classic");
      expect(l.format).toBe("A5_PORTRAIT");
      expect(l.twin).toBeUndefined();
      expect(LayoutSchema.safeParse(l).success).toBe(true);
    }
  });

  it.each(TEST_SPREADS.map((l) => [l.id, l] as const))("test layout %s is a valid v2 layout", (_id, l) => {
    expect(LayoutSchema.safeParse(l).success).toBe(true);
    expect(l.slots.length).toBe(l.photoCount);
    expect(l.prefers.length).toBe(l.photoCount);
    if (l.role === "spread") {
      for (const id of l.twin!) {
        const t = getLayout(id)!;
        expect(t.role).toBe("page");
        expect(t.format).toBe(l.format);
        expect(t.style).toBe(l.style);
      }
    }
  });

  it("rejects spreads without twin, twins on singles, rects outside the role's area, >12 slots", () => {
    const noTwin = omit(TEST_SPREAD_A, "twin");
    expect(LayoutSchema.safeParse(noTwin).success).toBe(false);
    expect(LayoutSchema.safeParse({ ...getLayout("full-page")!, twin: ["full-page", "full-page"] }).success).toBe(false);
    expect(LayoutSchema.safeParse({ ...getLayout("full-page")!, slots: [{ x: 50, y: 0, w: 60, h: 100 }] }).success).toBe(false);
    expect(LayoutSchema.safeParse({ ...TEST_SPREAD_A, caption: { x: 150, y: 0, w: 60, h: 10 } }).success).toBe(false);
    expect(LayoutSchema.safeParse({ ...TEST_SPREAD_A, style: "baroque" }).success).toBe(false);
    expect(LayoutSchema.safeParse({ ...TEST_SPREAD_A, format: "A4" }).success).toBe(false);
    expect(LayoutSchema.safeParse({ ...TEST_SPREAD_C, photoCount: 13 }).success).toBe(false);
    const badText = { ...TEST_SPREAD_A, texts: [{ bind: "photoDescription", box: { x: 0, y: 0, w: 10, h: 10 }, align: "start", font: "caption" }] };
    expect(LayoutSchema.safeParse(badText).success).toBe(false);
    const extraKey = { ...TEST_SPREAD_A, texts: [{ ...TEST_SPREAD_A.texts![0], text: "hello" }] };
    expect(LayoutSchema.safeParse(extraKey).success).toBe(false);
  });

  it("text panel font roles are the design-style text roles (A3 styles.ts)", () => {
    expect([...TEXT_FONT_ROLES]).toEqual([...TEXT_ROLES]);
    expect(LayoutSchema.safeParse({ ...TEST_SPREAD_A, texts: [{ ...TEST_SPREAD_A.texts![0], font: "display" }] }).success).toBe(false);
  });

  it("layoutsFor filters by format, style (null = any) and role, in catalogue order", () => {
    expect(layoutsFor("A5_PORTRAIT", "classic", "page").map((l) => l.id)).toEqual(
      LAYOUTS.filter((l) => l.role === "page" && l.style === "classic").map((l) => l.id),
    );
    expect(layoutsFor("A5_PORTRAIT", "classic", "spread").map((l) => l.id)).toEqual(["test-spread-a", "test-spread-b", "test-spread-c"]);
    expect(layoutsFor("A5_PORTRAIT", "classic", "cover").map((l) => l.id)).toEqual(["cover"]);
    expect(layoutsFor("A5_PORTRAIT", "modern", "page").map((l) => l.id)).toEqual(["test-modern-one"]);
    expect(layoutsFor("A5_PORTRAIT", null, "page")).toHaveLength(7);
    expect(layoutsFor("A5_LANDSCAPE", null, "page")).toEqual([]);
  });

  it("rectHalf / toPageRect split by the rect centre", () => {
    expect(rectHalf({ x: 0, w: 100 })).toBe("left");
    expect(rectHalf({ x: 60, w: 79 })).toBe("left"); // centre 99.5
    expect(rectHalf({ x: 60, w: 80 })).toBe("right"); // centre 100
    expect(toPageRect({ x: 105, y: 5, w: 90, h: 39 })).toEqual({ x: 5, y: 5, w: 90, h: 39 });
    expect(toPageRect({ x: 5, y: 5, w: 90, h: 39 })).toEqual({ x: 5, y: 5, w: 90, h: 39 });
  });
});

// --- alignment + validation ----------------------------------------------------------------------

describe("isSpreadAligned / spreadIssues / validateBookDoc", () => {
  it("aligned: spread at an even index followed by its right half", () => {
    const doc = docOf([single(), single(), ...spread(TEST_SPREAD_A), single()]);
    expect(spreadIssues(doc)).toEqual([]);
    expect(validateBookDoc(doc, { photoIds: new Set(photosOf(doc.pages)), maxPages: 20 })).toEqual([]);
    expect(spreadStartOf(doc, 2)).toBe(2);
    expect(spreadStartOf(doc, 3)).toBe(2);
    expect(spreadStartOf(doc, 1)).toBeNull();
  });

  const v = (pages: BookPage[]) => validateBookDoc(docOf(pages), { photoIds: new Set(photosOf(pages)), maxPages: 20 });

  it("misaligned spread (left half on an odd index)", () => {
    const [l, r] = spread(TEST_SPREAD_A);
    const pages = [single(), l, r];
    expect(spreadIssues(docOf(pages))).toEqual([{ index: 1, kind: "misaligned", layout: "test-spread-a" }]);
    expect(v(pages)).toEqual(['pages[1]: spread "test-spread-a" starts on a right-hand page']);
  });

  it("right half without left half", () => {
    const [l, r] = spread(TEST_SPREAD_A);
    expect(v([single(), single(), r])).toEqual(['pages[2]: right half of spread "test-spread-a" without its left half']);
    // right before left: both halves orphaned
    expect(v([r, l])).toEqual([
      'pages[0]: right half of spread "test-spread-a" without its left half',
      'pages[1]: spread "test-spread-a" starts on a right-hand page',
      'pages[1]: spread "test-spread-a" has no right half',
    ]);
  });

  it("spread on the last page with no right half", () => {
    const [l] = spread(TEST_SPREAD_B);
    expect(v([single(), single(), l])).toEqual(['pages[2]: spread "test-spread-b" has no right half']);
    // followed by another spread's right half → still missing its own
    const [, r2] = spread(TEST_SPREAD_A);
    expect(v([l, r2])).toEqual([
      'pages[0]: spread "test-spread-b" has no right half',
      'pages[1]: right half of spread "test-spread-a" without its left half',
    ]);
  });

  it("missing side, side on a single page, slots/caption on the right half", () => {
    const [l, r] = spread(TEST_SPREAD_A);
    const noSide = omit(l, "side");
    expect(v([noSide, r])).toEqual([
      'pages[0]: spread "test-spread-a" page has no side',
      'pages[1]: right half of spread "test-spread-a" without its left half',
    ]);
    expect(v([{ ...single("full-page"), side: "left" }])).toEqual(['pages[0]: layout "full-page" is not a spread but has a side']);
    const withSlot = { ...r, slots: [{ photoId: null, crop: { x: 0.5, y: 0.5, zoom: 1 } }] };
    expect(v([l, withSlot])).toEqual(['pages[1]: layout "test-spread-a" needs 0 slots, got 1']);
    expect(v([l, { ...r, caption: caption("x") }])).toEqual(['pages[1]: layout "test-spread-a" has no caption area']);
    expect(v([{ ...l, slots: l.slots.slice(1) }, r])).toEqual(['pages[0]: layout "test-spread-a" needs 3 slots, got 2']);
  });

  it("layout format must match doc.format (cover and pages); cover layout on a page", () => {
    const page = single("full-page");
    const doc = { ...docOf([page, { ...single("one-portrait"), layout: "cover" }]), format: "A5_LANDSCAPE" as const };
    expect(validateBookDoc(doc, { photoIds: new Set(photosOf(doc.pages)), maxPages: 20 })).toEqual([
      'cover: layout "cover" is for A5_PORTRAIT, book is A5_LANDSCAPE',
      'pages[0]: layout "full-page" is for A5_PORTRAIT, book is A5_LANDSCAPE',
      'pages[1]: layout "cover" is not a page layout',
    ]);
  });

  it("a spread counts as 2 pages toward maxPages", () => {
    const pages = [...spread(TEST_SPREAD_A), ...spread(TEST_SPREAD_B)];
    expect(validateBookDoc(docOf(pages), { photoIds: new Set(photosOf(pages)), maxPages: 3 })).toEqual([
      "pages: 4 pages exceeds limit of 3",
    ]);
  });
});

// --- repair: exact outputs -----------------------------------------------------------------------

describe("repairSpreads — split into twins", () => {
  it("misaligned spread → twin layouts, slots by half, caption on its half, crops + ids + backgrounds kept", () => {
    const s = single("full-page");
    const [l, r] = spread(TEST_SPREAD_A);
    const bgL = { kind: "color" as const, hex: "#112233", source: "user" as const };
    const bgR = { kind: "texture" as const, textureId: "kraft" as const, source: "ai" as const };
    const doc = docOf([s, { ...l, background: bgL }, { ...r, background: bgR, chapterId: null }]);
    const res = repairSpreads(doc);
    expect(res.splitCount).toBe(1);
    expect(res.droppedHalves).toBe(0);
    const [p0, p1, p2] = res.doc.pages;
    expect(p0).toBe(s);
    expect(p1).toEqual({ id: l.id, chapterId: "m1", layout: "full-page", slots: [l.slots[0]], caption: null, background: bgL });
    expect(p2).toEqual({ id: r.id, chapterId: null, layout: "two-horizontal", slots: [l.slots[1], l.slots[2]], caption: l.caption, background: bgR });
    expect(p1.side).toBeUndefined();
    expect(res.doc.pages).toHaveLength(3);
    expect(doc.pages[1].side).toBe("left"); // input not mutated
  });

  it("twin too small → smallest bigger single layout of the style (with caption area for the caption)", () => {
    const [l, r] = spread(TEST_SPREAD_B);
    const res = repairSpreads(docOf([single(), l, r]));
    const [, left, right] = res.doc.pages;
    expect(left.layout).toBe("four-grid"); // twin one-portrait holds 1, 4 photos + caption
    expect(left.slots.map((x) => x.photoId)).toEqual(l.slots.slice(0, 4).map((x) => x.photoId));
    expect(left.caption).toEqual(l.caption);
    expect(right.layout).toBe("two-vertical");
    expect(right.slots).toEqual(l.slots.slice(4));
  });

  it("the pickPageLayout callback chooses the bigger layout (ignored if it doesn't fit)", () => {
    const [l, r] = spread(TEST_SPREAD_B);
    const calls: unknown[] = [];
    const res = repairSpreads(docOf([single(), l, r]), {
      pickPageLayout: (req) => {
        calls.push({ ...req, twin: req.twin.id });
        return "four-grid";
      },
    });
    expect(calls).toEqual([{ format: "A5_PORTRAIT", style: "classic", photoCount: 4, needsCaption: true, twin: "one-portrait" }]);
    expect(res.doc.pages[1].layout).toBe("four-grid");
    const bad = repairSpreads(docOf([single(), l, r]), { pickPageLayout: () => "full-page" });
    expect(bad.doc.pages[1].layout).toBe("four-grid"); // full-page can't hold 4 → default
  });

  it("no single layout holds a half → continues on extra pages (never drops photos)", () => {
    const [l, r] = spread(TEST_SPREAD_C);
    const res = repairSpreads(docOf([single(), l, r]));
    expect(res.doc.pages.map((p) => p.layout)).toEqual([res.doc.pages[0].layout, "four-grid", "two-vertical", "four-grid", "two-vertical"]);
    expect(photosOf(res.doc.pages)).toEqual(photosOf([l]).concat(photosOf([res.doc.pages[0]])).sort());
    expect(res.doc.pages.map((p) => p.id)).toEqual([res.doc.pages[0].id, l.id, expect.stringMatching(/^p\d+$/), r.id, expect.stringMatching(/^p\d+$/)]);
  });

  it("exact twin fit keeps empty slots in place; extra empty slots are not kept when compacting", () => {
    const [l, r] = spread(TEST_SPREAD_A);
    const holes = { ...l, slots: l.slots.map((s, i) => (i === 1 ? { ...s, photoId: null } : s)) };
    const res = repairSpreads(docOf([single(), holes, r]));
    expect(res.doc.pages[2].slots.map((s) => s.photoId)).toEqual([null, l.slots[2].photoId]);
  });

  it("spread on the last page with no right half: splits, no blank page for an empty half", () => {
    const [l] = spread(TEST_SPREAD_A);
    const leftOnly = { ...l, slots: l.slots.map((s, i) => (i === 0 ? s : { ...s, photoId: null })), caption: null };
    const res = repairSpreads(docOf([leftOnly]));
    expect(res.doc.pages.map((p) => p.layout)).toEqual(["full-page"]);
    // with content on its right half: both twins, the second gets a new id
    const res2 = repairSpreads(docOf([single(), single(), l]));
    expect(res2.doc.pages.slice(2).map((p) => [p.layout, p.id])).toEqual([
      ["full-page", l.id],
      ["two-horizontal", expect.stringMatching(/^p\d+$/)],
    ]);
    // only the right half has content → one page, the left page's id
    const rightOnly = { ...l, slots: l.slots.map((s, i) => (i === 0 ? { ...s, photoId: null } : s)) };
    const res3 = repairSpreads(docOf([rightOnly]));
    expect(res3.doc.pages.map((p) => [p.layout, p.id])).toEqual([["two-horizontal", l.id]]);
  });

  it("empty orphan right half is removed; side on a single page is cleared", () => {
    const [, r] = spread(TEST_SPREAD_A);
    const a = single();
    const b = { ...single("full-page"), side: "right" as const };
    const res = repairSpreads(docOf([a, r, b]));
    expect(res.droppedHalves).toBe(1);
    expect(res.clearedSides).toBe(1);
    expect(res.doc.pages.map((p) => p.id)).toEqual([a.id, b.id]);
    expect("side" in res.doc.pages[1]).toBe(false);
  });

  it("orphan right half that (wrongly) holds photos/caption is split, not dropped", () => {
    const [, r] = spread(TEST_SPREAD_A);
    const bad = { ...r, slots: [{ photoId: "phX", crop: crop(1) }], caption: caption("keep me") };
    const res = repairSpreads(docOf([bad]));
    expect(photosOf(res.doc.pages)).toEqual(["phX"]);
    expect(captionsOf(res.doc.pages)).toEqual(["keep me"]);
    expect(isSpreadAligned(res.doc)).toBe(true);
  });
});

// --- repair: every op at every index -------------------------------------------------------------

describe("repairSpreads after insert / delete / move at every index 0..21", () => {
  const LENGTHS = [5, 6, 20, 21, 22];
  for (const len of LENGTHS) {
    describe(`${len} pages (${len % 2 ? "odd" : "even"})`, () => {
      it("insert a single page at every index", () => {
        for (let k = 0; k <= Math.min(21, len); k++) checkRepair(insertAt(alignedDoc(len), k));
      });

      it("delete the page (or the spread unit) at every index", () => {
        for (let k = 0; k < Math.min(22, len); k++) checkRepair(deleteAt(alignedDoc(len), k));
      });

      it("move the page / spread unit from every index to every index", () => {
        const n = Math.min(22, len);
        for (let from = 0; from < n; from++) for (let to = 0; to < n; to++) checkRepair(moveUnit(alignedDoc(len), from, to));
      });

      it("an odd shift splits exactly the spreads after it; an even shift keeps them all", () => {
        const doc = alignedDoc(len);
        const spreadsAfter = (k: number) => doc.pages.filter((p, i) => i >= k && p.side === "left").length;
        for (let k = 0; k <= Math.min(21, len); k++) {
          if (spreadStartOf(doc, k) === k - 1) continue; // between two halves: covered above
          const one = repairSpreads(insertAt(doc, k));
          expect(one.splitCount).toBe(spreadsAfter(k));
          const two = repairSpreads(insertAt(insertAt(doc, k), k));
          expect(two.splitCount).toBe(0);
        }
      });
    });
  }
});

// --- doc versions --------------------------------------------------------------------------------

describe("usesV2Features (M10b additions)", () => {
  const classic = () => docOf([single("two-vertical"), single("one-portrait")]);

  it("a classic doc stays v1 and serializes byte-identically", () => {
    const doc = classic();
    expect(usesV2Features(doc)).toBe(false);
    const v1 = serializeDoc(doc);
    expect(v1.version).toBe(1);
    const reparsed = parseBookDoc(JSON.parse(JSON.stringify(v1)));
    expect(reparsed.ok && JSON.stringify(serializeDoc(reparsed.doc))).toBe(JSON.stringify(v1));
  });

  it("spreads (side or spread layout) are v2", () => {
    const doc = docOf([...spread(TEST_SPREAD_A)]);
    expect(usesV2Features(doc)).toBe(true);
    expect(serializeDoc(doc).version).toBe(2);
    const noSide = omit(doc.pages[0], "side");
    expect(usesV2Features(docOf([noSide]))).toBe(true);
  });

  it("a non-classic layout is v2", () => {
    const p = single(TEST_MODERN_PAGE.id);
    expect(usesV2Features(docOf([p]))).toBe(true);
  });

  it.each(V2_CAPTION_FONTS)("caption or book font %s is v2 (and FontSchema accepts it)", (font) => {
    const doc = classic();
    const onPage: BookDoc = { ...doc, pages: doc.pages.map((p, i) => (i === 0 ? { ...p, caption: { ...p.caption!, font } } : p)) };
    expect(usesV2Features(onPage)).toBe(true);
    expect(parseBookDoc(serializeDoc(onPage)).ok).toBe(true);
    const asBook: BookDoc = { ...doc, style: { ...doc.style, font } };
    expect(usesV2Features(asBook)).toBe(true);
    expect(parseBookDoc(serializeDoc(asBook)).ok).toBe(true);
  });

  it("the M9 fonts stay v1", () => {
    for (const font of ["Inter", "Playfair", "Cairo", "Tajawal"]) {
      const doc = classic();
      expect(usesV2Features({ ...doc, style: { ...doc.style, font } })).toBe(false);
    }
  });
});
