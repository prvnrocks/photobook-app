// M10c T10: geometric + scrapbook in the rule-based album pipeline — autolayout (rule 10:
// shape-aware fitting, per-style spreads, covers), Update album relayout, fillPages and the photo-
// delete reflow (D-066) for all 4 new (format, style) designs. Classic + modern output is frozen by
// autolayout-classic-golden.test.ts + autolayout-design-golden.test.ts.

import { describe, expect, it } from "vitest";
import { autolayout, fillPages, LARGE_SPREAD_MOMENT, SPREAD_MOMENT_MIN, type AutoPhoto } from "@/lib/autolayout";
import { limitsFor } from "@/lib/ai/limits";
import { ruleAlbum } from "@/lib/ai/fallback";
import type { BookDesign } from "@/lib/book/book-design";
import { markUserEdited } from "@/lib/book/edit-ops";
import { relayoutDoc as relayoutRaw, RelayoutError, type RelayoutPhoto } from "@/lib/book/relayout";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import { isSpreadAligned, spreadIssues } from "@/lib/book/spreads";
import { stripPhotoFromDoc, type StripPhotoDims } from "@/lib/book/strip-photos";
import { photoRectOf } from "@/lib/book/slot-geometry";
import { pageMm } from "@/lib/book/format";
import { layoutsFor } from "@/lib/book/spreads";
import type { BookDoc, Caption, Layout } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";
import {
  bestCoverLayout,
  bestPageLayout,
  coverPhotoOrientation,
  designFitScore,
  fullPageLayout,
  isShapeAware,
  ROUND_STRETCH_MAX,
  shapeMiss,
  slotFit,
} from "@/lib/layouts/fit";
import { momentSet, rng, SET_SIZES } from "./fixtures/autolayout-sets";

const relayoutDoc: typeof relayoutRaw = (...args) => {
  try {
    return relayoutRaw(...args);
  } catch (e) {
    if (e instanceof RelayoutError) throw new Error(`RelayoutError: ${e.issues.join(" | ")}`);
    throw e;
  }
};

const DESIGNS: readonly BookDesign[] = [
  { format: "A5_PORTRAIT", designStyle: "geometric" },
  { format: "A5_LANDSCAPE", designStyle: "geometric" },
  { format: "A5_PORTRAIT", designStyle: "scrapbook" },
  { format: "A5_LANDSCAPE", designStyle: "scrapbook" },
];
const tag = (d: BookDesign) => `${d.format}/${d.designStyle}`;
const BASE = { occasion: "family" as const, title: null, captionLang: "en" as const };
const SIZES = [...SET_SIZES, 200];

// --- helpers -----------------------------------------------------------------------------------------

const keptIds = (photos: readonly { id: string; status: string }[]) => new Set(photos.filter((p) => p.status === "kept").map((p) => p.id));
const placedIds = (doc: BookDoc) => doc.pages.flatMap((p) => p.slots.map((s) => s.photoId).filter((id): id is string => id !== null));

function dedupedCount(photos: AutoPhoto[]): number {
  const groups = new Set<number>();
  const seen = new Set<string>();
  let n = 0;
  for (const p of photos) {
    if (p.status !== "kept" || seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.dupGroup === null) n++;
    else groups.add(p.dupGroup);
  }
  return n + groups.size;
}

function expectInDesign(doc: BookDoc, d: BookDesign, label = "") {
  expect(doc.format, label).toBe(d.format);
  expect(doc.style.designStyle, label).toBe(d.designStyle);
  const cover = getLayout(doc.cover.layout);
  expect(cover?.role, label).toBe("cover");
  expect(cover?.format, label).toBe(d.format);
  expect(cover?.style, label).toBe(d.designStyle);
  for (const p of doc.pages) {
    const l = getLayout(p.layout);
    expect(l?.format, `${label} ${p.layout}`).toBe(d.format);
    expect(l?.style, `${label} ${p.layout}`).toBe(d.designStyle);
    expect(l?.role, label).not.toBe("cover");
  }
}

function expectValidDoc(doc: BookDoc, kept: Set<string>, maxPages: number, label = "", backgroundPhotoIds?: Set<string>) {
  expect(parseBookDoc(doc).ok, label).toBe(true);
  expect(validateBookDoc(doc, { photoIds: kept, maxPages, backgroundPhotoIds }), label).toEqual([]);
  expect(isSpreadAligned(doc), label).toBe(true);
  expect(doc.pages.length, label).toBeLessThanOrEqual(maxPages);
  const ids = placedIds(doc);
  expect(new Set(ids).size, label).toBe(ids.length);
}

function reviewed(photos: AutoPhoto[], seed: number): RelayoutPhoto[] {
  const r = rng(seed * 31 + 7);
  const changed = photos.map((p) => ({
    ...p,
    status: (p.status === "kept" ? (r() < 0.2 ? "dropped" : "kept") : r() < 0.5 ? "kept" : "dropped") as "kept" | "dropped",
  }));
  const extra = momentSet(Math.max(1, Math.floor(photos.length / 8)), seed + 7000).map((p) => ({
    ...p,
    id: `x-${p.id}`,
    status: "kept" as const,
  }));
  return [...changed, ...extra];
}

const dimsOf = (photos: readonly AutoPhoto[]): StripPhotoDims[] =>
  photos.map((p) => ({ id: p.id, width: p.width, height: p.height, takenAt: p.takenAt }));

/** Photo of a given size taken `min` minutes after a fixed start (one chapter when close together). */
function shot(id: string, w: number, h: number, min: number, blur = 100): AutoPhoto {
  return {
    id,
    width: w,
    height: h,
    takenAt: new Date(Date.parse("2026-11-01T10:00:00+04:00") + min * 60_000).toISOString(),
    dateSource: "exif",
    place: null,
    status: "kept",
    dupGroup: null,
    blurScore: blur,
  };
}
const L = [4000, 3000] as const;
const P = [3000, 4000] as const;
/** Landscape (4:3) or portrait (3:4) shot. */
const shotLP = (id: string, landscape: boolean, min: number) => (landscape ? shot(id, ...L, min) : shot(id, ...P, min));

/** Every round slot of `doc` holds a square-ish photo (rule 10). */
function expectRoundSlotsSquareish(doc: BookDoc, photos: readonly AutoPhoto[], label: string) {
  const byId = new Map(photos.map((p) => [p.id, p]));
  for (const page of doc.pages) {
    const layout = getLayout(page.layout);
    if (!layout) continue;
    page.slots.forEach((s, i) => {
      if (s.photoId === null) return;
      const f = slotFit(layout, i);
      const ph = byId.get(s.photoId);
      if (!f?.round || !ph) return;
      const ratio = ph.width > 0 && ph.height > 0 ? ph.width / ph.height : 1; // unknown size = square (autolayout)
      const stretch = Math.abs(Math.log(ratio / f.aspect));
      expect(stretch, `${label} ${page.layout} slot ${i} photo ${ph.width}×${ph.height}`).toBeLessThanOrEqual(Math.log(ROUND_STRETCH_MAX) + 1e-9);
    });
  }
}

// --- property tests per design --------------------------------------------------------------------------

describe.each(DESIGNS)("rule-built album for %o", (design) => {
  it("seeded mixed-aspect sets 1–200 photos: valid, aligned, in design, ≤ maxPages; relayout + delete reflow keep it so", () => {
    for (const n of SIZES) {
      for (const seed of [21, 22]) {
        const photos = momentSet(n, seed * 1000 + n);
        const kept = keptIds(photos);
        for (const isPaid of [false, true]) {
          const maxPages = limitsFor(isPaid).maxPages;
          const label = `${tag(design)} n=${n} seed=${seed} paid=${isPaid}`;
          const doc = autolayout(photos, { ...BASE, isPaid, design });
          expectInDesign(doc, design, label);
          expectValidDoc(doc, kept, maxPages, label);
          expect(doc.meta?.generator, label).toBe("rule");
          if (kept.size > 0) {
            expect(doc.chapters.length, label).toBeGreaterThan(0); // not the minimal safety net
            expect(doc.cover.photoId, label).not.toBeNull();
          }
          const placed = placedIds(doc);
          if (isPaid && n <= 48) expect(placed.length, label).toBe(dedupedCount(photos));
          for (const id of placed) expect(kept.has(id), label).toBe(true);
          expectRoundSlotsSquareish(doc, photos, label);

          // Update album after review changes.
          const rv = reviewed(photos, seed + n);
          const r = relayoutDoc(doc, rv, { isPaid, maxPages, captionLang: "en" });
          expectInDesign(r.doc, design, `${label} relayout`);
          expectValidDoc(r.doc, keptIds(rv), maxPages, `${label} relayout`);

          // Photo delete (D-066): first placed photo + one on a spread when there is one.
          const spreadPhoto = doc.pages.find((p) => p.side === "left")?.slots[0]?.photoId ?? null;
          for (const gone of [placed[0], spreadPhoto].filter((x): x is string => !!x)) {
            const s = stripPhotoFromDoc(doc, gone, dimsOf(photos));
            const sl = `${label} strip ${gone}`;
            expect(s.changed, sl).toBe(true);
            expectInDesign(s.doc, design, sl);
            const rest = new Set([...kept].filter((id) => id !== gone));
            expectValidDoc(s.doc, rest, maxPages, sl);
            expect(new Set(placedIds(s.doc)), sl).toEqual(new Set(placed.filter((id) => id !== gone)));
          }
        }
      }
    }
  }, 30_000); // heavy property walk (~2.5 s alone, >5 s under the full parallel suite since the M10c look-ahead)

  it("special sets: all panoramas, all tall portraits, all squares, unknown sizes, all undated", () => {
    const sets: Record<string, AutoPhoto[]> = {
      panoramas: Array.from({ length: 30 }, (_, i) => shot(`pa${i}`, 6000, 2000, i)),
      tall: Array.from({ length: 30 }, (_, i) => shot(`ta${i}`, 1080, 1920, i)),
      squares: Array.from({ length: 30 }, (_, i) => shot(`sq${i}`, 3000, 3000, i)),
      unknown: Array.from({ length: 30 }, (_, i) => shot(`un${i}`, 0, 0, i)),
      undated: Array.from({ length: 30 }, (_, i) => ({ ...shot(`ud${i}`, i % 2 ? 4000 : 3000, i % 2 ? 3000 : 4000, i), takenAt: null })),
    };
    for (const [name, photos] of Object.entries(sets)) {
      for (const isPaid of [false, true]) {
        const label = `${tag(design)} ${name} paid=${isPaid}`;
        const maxPages = limitsFor(isPaid).maxPages;
        const doc = autolayout(photos, { ...BASE, isPaid, design });
        expectInDesign(doc, design, label);
        expectValidDoc(doc, keptIds(photos), maxPages, label);
        expect(doc.chapters.length, label).toBeGreaterThan(0);
        if (isPaid) expect(placedIds(doc).length, label).toBe(30);
        expectRoundSlotsSquareish(doc, photos, label);
      }
    }
  });

  it("ruleAlbum (AI fallback) builds the design", () => {
    const photos = momentSet(60, 99);
    const doc = ruleAlbum(photos, { ...BASE, isPaid: true, design }, null);
    expectInDesign(doc, design);
    expectValidDoc(doc, keptIds(photos), 100);
  });

  it("is deterministic (input order does not matter)", () => {
    const photos = momentSet(120, 8);
    expect(autolayout(photos, { ...BASE, isPaid: true, design })).toEqual(autolayout([...photos].reverse(), { ...BASE, isPaid: true, design }));
  });

  it("fillPages: single pages of the design, every slot filled", () => {
    const photos = momentSet(40, 3).map((p) => ({ ...p, status: "kept" as const }));
    for (const pg of fillPages(photos, { opener: true, design })) {
      const l = getLayout(pg.layout);
      expect(l?.role).toBe("page");
      expect(l?.style).toBe(design.designStyle);
      expect(l?.format).toBe(design.format);
      expect(pg.photoIds.length).toBe(l?.photoCount);
    }
  });

  it("cover + full-page picks stay in the design", () => {
    for (const o of [null, "portrait", "landscape", "square"] as const) {
      const c = getLayout(bestCoverLayout(design, o));
      expect(c).toMatchObject({ role: "cover", format: design.format, style: design.designStyle });
    }
    expect(getLayout(fullPageLayout(design))).toMatchObject({ role: "page", photoCount: 1, style: design.designStyle });
  });
});

// --- shape-aware fit ----------------------------------------------------------------------------------

describe("shape-aware fit (visible photo area)", () => {
  it("only geometric + scrapbook are shape-aware", () => {
    expect(isShapeAware({ designStyle: "geometric" })).toBe(true);
    expect(isShapeAware({ designStyle: "scrapbook" })).toBe(true);
    expect(isShapeAware({ designStyle: "classic" })).toBe(false);
    expect(isShapeAware({ designStyle: "modern" })).toBe(false);
  });

  it("framed slots fit the photo rect (frame inset removed), not the outer frame", () => {
    const l = getLayout("s-p-one-polaroid")!;
    const r = photoRectOf(l, 0)!;
    const page = pageMm(l.format);
    const f = slotFit(l, 0)!;
    expect(f.aspect).toBeCloseTo((r.w * page.w) / (r.h * page.h), 6);
    expect(f.fill).toBe(1);
    expect(f.round).toBe(false);
    const outer = (l.slots[0].w * page.w) / (l.slots[0].h * page.h);
    expect(Math.abs(f.aspect - outer)).toBeGreaterThan(0.01); // the polaroid's thick bottom matters
  });

  it("circle, hexagon, diamond and petal slots are round with a square-ish visible aspect", () => {
    const circle = slotFit(getLayout("g-p-two-circle")!, 1)!;
    expect(circle).toMatchObject({ round: true });
    expect(circle.aspect).toBeCloseTo(1, 2);
    expect(circle.fill).toBeCloseTo(Math.PI / 4, 6);
    const hex = slotFit(getLayout("g-p-five-hex")!, 0)!;
    expect(hex.round).toBe(true);
    expect(hex.aspect).toBeCloseTo(1, 2); // regular hexagon: isotropic, though its box is 1.15 wide
    const diamond = slotFit(getLayout("g-l-three-diamond")!, 0)!;
    expect(diamond.round).toBe(true);
    expect(diamond.aspect).toBeCloseTo(1, 2);
    expect(diamond.fill).toBeCloseTo(0.5, 2);
    const petal = slotFit(getLayout("g-p-four-petals")!, 0)!;
    expect(petal.round).toBe(true);
    expect(petal.fill).toBeLessThan(1);
  });

  it("diagonal-cut and notched slots score on what stays visible, not the bounding box", () => {
    const page = pageMm("A5_PORTRAIT");
    const box = (id: string, i: number) => {
      const s = getLayout(id)!.slots[i];
      return (s.w * page.w) / (s.h * page.h);
    };
    // The notch bites the bottom of the top photo → what's visible is wider than the box.
    const notched = slotFit(getLayout("g-p-two-circle")!, 0)!;
    expect(notched.round).toBe(false);
    expect(notched.fill).toBeLessThan(1);
    expect(notched.aspect).toBeGreaterThan(box("g-p-two-circle", 0));
    // The diagonal cuts a wedge off → visible aspect differs from the box.
    const band = slotFit(getLayout("g-p-two-diag")!, 0)!;
    expect(band.round).toBe(false);
    expect(band.fill).toBeLessThan(0.95);
    expect(Math.abs(band.aspect - box("g-p-two-diag", 0))).toBeGreaterThan(0.05);
  });

  it("bestPageLayout prefers the slot shape that shows the photo best; a panorama never goes in a circle", () => {
    const design: BookDesign = { format: "A5_PORTRAIT", designStyle: "geometric" };
    // landscape + square: both 2-photo pages fit by orientation; the circle shows the square whole.
    expect(bestPageLayout(["landscape", "square"], { design })).toBe("g-p-two-circle");
    // landscape + panorama: the circle would lose most of the panorama → diagonal split.
    expect(bestPageLayout(["landscape", "landscape"], { design, ratios: [4 / 3, 2.5] })).toBe("g-p-two-diag");
    // Three portraits fit diamonds; three 9:16 phone shots miss them (still the only 3-slot page).
    const diamonds = getLayout("g-p-three-diamond")!;
    expect(designFitScore(diamonds, ["portrait", "portrait", "portrait"], design, [0.75, 0.75, 0.75])).toBe(3);
    expect(designFitScore(diamonds, ["portrait", "portrait", "portrait"], design, [0.5625, 0.5625, 0.5625])).toBe(0);
  });

  it("classic / modern scores ignore shapes and ratios", () => {
    const modern: BookDesign = { format: "A5_PORTRAIT", designStyle: "modern" };
    const l = getLayout("g-p-three-diamond")!;
    // designFitScore with a non-shape-aware design = plain orientation fitScore.
    expect(designFitScore(l, ["portrait", "portrait", "portrait"], modern, [0.2, 0.2, 0.2])).toBe(3);
  });

  it("cover photo follows the style's cover slot (geometric landscape cover is portrait)", () => {
    expect(coverPhotoOrientation({ format: "A5_LANDSCAPE", designStyle: "geometric" })).toBe("portrait");
    expect(coverPhotoOrientation({ format: "A5_PORTRAIT", designStyle: "modern" })).toBeNull();
    // A sharper landscape photo exists, but the cover takes the portrait one.
    const photos = [shot("land", ...L, 0, 900), shot("port", ...P, 5, 100), shot("land2", ...L, 10, 800)];
    const doc = autolayout(photos, { ...BASE, isPaid: true, design: { format: "A5_LANDSCAPE", designStyle: "geometric" } });
    expect(doc.cover.layout).toBe("g-l-cover");
    expect(doc.cover.photoId).toBe("port");
    // Scrapbook landscape cover is square-ish "any" → the format's orientation (landscape) wins.
    const s = autolayout(photos, { ...BASE, isPaid: true, design: { format: "A5_LANDSCAPE", designStyle: "scrapbook" } });
    expect(s.cover.photoId).toBe("land");
  });
});

// --- spreads per style --------------------------------------------------------------------------------

describe("spread rules per style (rule 10)", () => {
  const spreadsOf = (doc: BookDoc) =>
    doc.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.side === "left").map(({ p, i }) => ({ i, layout: p.layout, n: p.slots.length }));

  it("scrapbook: a large moment opens with the photo wall, then alternates to the hero spread", () => {
    const photos = Array.from({ length: 30 }, (_, i) => shotLP(`w${i}`, i % 3 === 0, i));
    for (const format of ["A5_PORTRAIT", "A5_LANDSCAPE"] as const) {
      const prefix = format === "A5_PORTRAIT" ? "s-p" : "s-l";
      const doc = autolayout(photos, { ...BASE, isPaid: true, design: { format, designStyle: "scrapbook" } });
      const spreads = spreadsOf(doc);
      expect(spreads.map((s) => s.layout), format).toEqual([`${prefix}-spread-wall`, `${prefix}-spread-hero`]);
      expect(spreads[0].i).toBe(0); // the chapter opener
      for (const s of spreads) expect(s.i % 2).toBe(0);
      expect(spreads[1].i - spreads[0].i).toBeGreaterThan(2); // never two in a row
      expect(placedIds(doc).length).toBe(30);
    }
  });

  it("scrapbook: a mid-size moment gets only the hero spread; a small one none", () => {
    const mid = Array.from({ length: LARGE_SPREAD_MOMENT - 2 }, (_, i) => shotLP(`m${i}`, i % 4 === 1, i));
    const doc = autolayout(mid, { ...BASE, isPaid: true, design: { format: "A5_PORTRAIT", designStyle: "scrapbook" } });
    expect(spreadsOf(doc).map((s) => s.layout)).toEqual(["s-p-spread-hero"]);
    const small = mid.slice(0, SPREAD_MOMENT_MIN - 1);
    const d2 = autolayout(small, { ...BASE, isPaid: true, design: { format: "A5_PORTRAIT", designStyle: "scrapbook" } });
    expect(spreadsOf(d2)).toEqual([]);
  });

  it("geometric: the diagonal band spread takes three photos that fit it (0 misses), looking a little ahead", () => {
    // Portrait book: the band wants landscapes. Portraits in between are skipped and stay queued.
    const photos = [shot("a", ...L, 0), shot("b", ...P, 1), shot("c", ...L, 2), shot("d", ...L, 3), ...Array.from({ length: 8 }, (_, i) => shot(`e${i}`, ...P, 4 + i))];
    const doc = autolayout(photos, { ...BASE, isPaid: true, design: { format: "A5_PORTRAIT", designStyle: "geometric" } });
    const spreads = spreadsOf(doc);
    expect(spreads.map((s) => s.layout)).toEqual(["g-p-spread-band"]);
    const band = doc.pages[spreads[0].i];
    expect(new Set(band.slots.map((s) => s.photoId))).toEqual(new Set(["a", "c", "d"]));
    expect(placedIds(doc).length).toBe(photos.length);
    // A moment of portraits only: no band spread (it would crop every photo hard).
    const portraits = Array.from({ length: 12 }, (_, i) => shot(`p${i}`, ...P, i));
    const d2 = autolayout(portraits, { ...BASE, isPaid: true, design: { format: "A5_PORTRAIT", designStyle: "geometric" } });
    expect(spreadsOf(d2)).toEqual([]);
    // Landscape book: the band wants portraits.
    const d3 = autolayout(portraits, { ...BASE, isPaid: true, design: { format: "A5_LANDSCAPE", designStyle: "geometric" } });
    expect(spreadsOf(d3).map((s) => s.layout)).toEqual(["g-l-spread-band"]);
  });

  it("geometric: phone shots in the book's own orientation pair up (g-l-two-stack / g-p-two-pair), not one one-band page each", () => {
    // 7 × 16:9 landscapes in a landscape book gave 7 one-band pages before the pair layouts existed.
    for (const [format, w, h, pair] of [
      ["A5_LANDSCAPE", 1920, 1080, "g-l-two-stack"],
      ["A5_PORTRAIT", 1080, 1920, "g-p-two-pair"],
    ] as const) {
      const photos = Array.from({ length: 7 }, (_, i) => shot(`o${i}`, w, h, i));
      const doc = autolayout(photos, { ...BASE, isPaid: true, design: { format, designStyle: "geometric" } });
      const layouts = doc.pages.map((p) => p.layout);
      expect(layouts, format).toContain(pair);
      expect(layouts.filter((id) => id.endsWith("-one-band")).length, format).toBe(1); // the chapter opener only
      expectValidDoc(doc, keptIds(photos), 100, format);
    }
  });

  it("spreads count 2 pages toward the free cap", () => {
    for (const design of DESIGNS) {
      const photos = Array.from({ length: 120 }, (_, i) => shotLP(`f${i}`, !(i % 3), i * 2));
      const doc = autolayout(photos, { ...BASE, isPaid: false, design });
      expectValidDoc(doc, keptIds(photos), 20, tag(design));
    }
  });
});

// --- relayout + delete reflow on style spreads ---------------------------------------------------------

describe("relayout and photo-delete reflow on scrapbook / geometric spreads", () => {
  const userCap = (text: string): Caption => ({ text, font: "Cormorant", align: "center", source: "user" });
  const wallBook = () => {
    const photos = Array.from({ length: 30 }, (_, i) => shotLP(`w${i}`, i % 3 === 0, i));
    const doc = autolayout(photos, { ...BASE, isPaid: true, design: { format: "A5_PORTRAIT", designStyle: "scrapbook" } });
    expect(doc.pages[0].layout).toBe("s-p-spread-wall");
    return { photos, doc };
  };

  it("deleting a photo of the scrapbook wall spread reflows it in style, keeps every other photo and the user caption", () => {
    const { photos, doc: base } = wallBook();
    const doc: BookDoc = { ...base, pages: base.pages.map((p, i) => (i === 0 ? { ...p, caption: userCap("Eid at Teta's") } : p)) };
    const gone = doc.pages[0].slots[3].photoId as string;
    const r = stripPhotoFromDoc(doc, gone, dimsOf(photos));
    expect(r.reflowed).toBe(true);
    expect(spreadIssues(r.doc)).toEqual([]);
    expectInDesign(r.doc, { format: "A5_PORTRAIT", designStyle: "scrapbook" });
    const rest = new Set(placedIds(doc).filter((id) => id !== gone));
    expect(new Set(placedIds(r.doc))).toEqual(rest);
    expectValidDoc(r.doc, rest, 100);
    // No 5-photo scrapbook spread → the wall splits into its halves (no empty slot left behind).
    expect(r.doc.pages[0].layout).not.toBe("s-p-spread-wall");
    expect(r.doc.pages.every((p) => p.slots.every((s) => s.photoId !== null))).toBe(true);
    expect(r.doc.pages.filter((p) => p.caption?.source === "user").map((p) => p.caption?.text)).toEqual(["Eid at Teta's"]);
  });

  it("deleting a photo of the hero spread in a user-edited album keeps photos, caption and chapters", () => {
    const { photos, doc: base } = wallBook();
    const heroIdx = base.pages.findIndex((p) => p.layout === "s-p-spread-hero" && p.side === "left");
    expect(heroIdx).toBeGreaterThan(0);
    const doc = markUserEdited({
      ...base,
      pages: base.pages.map((p, i) => (i === heroIdx ? { ...p, caption: userCap("Picnic") } : p)),
    });
    const gone = doc.pages[heroIdx].slots[0].photoId as string;
    const r = stripPhotoFromDoc(doc, gone, dimsOf(photos));
    expect(r.changed).toBe(true);
    expect(r.doc.chapters).toEqual(doc.chapters);
    expect(new Set(placedIds(r.doc))).toEqual(new Set(placedIds(doc).filter((id) => id !== gone)));
    expect(r.doc.pages.filter((p) => p.caption?.source === "user").map((p) => p.caption?.text)).toEqual(["Picnic"]);
    expectValidDoc(r.doc, new Set(photos.map((p) => p.id).filter((id) => id !== gone)), 100);
  });

  it("Update album: a wall spread losing two photos splits into scrapbook pages; a band losing one splits into geometric pages", () => {
    const { photos, doc } = wallBook();
    const lost = new Set(doc.pages[0].slots.slice(0, 2).map((s) => s.photoId as string));
    const rv: RelayoutPhoto[] = photos.map((p) => ({ ...p, status: lost.has(p.id) ? "dropped" : "kept" }));
    const r = relayoutDoc(doc, rv, { isPaid: true, maxPages: 100, captionLang: "en" });
    expect(r.changed).toBe(true);
    expectInDesign(r.doc, { format: "A5_PORTRAIT", designStyle: "scrapbook" });
    expectValidDoc(r.doc, keptIds(rv), 100);
    expect(new Set(placedIds(r.doc))).toEqual(new Set(placedIds(doc).filter((id) => !lost.has(id))));

    const g = Array.from({ length: 12 }, (_, i) => shot(`g${i}`, ...L, i));
    const gd = autolayout(g, { ...BASE, isPaid: true, design: { format: "A5_PORTRAIT", designStyle: "geometric" } });
    const bandIdx = gd.pages.findIndex((p) => p.layout === "g-p-spread-band" && p.side === "left");
    expect(bandIdx).toBeGreaterThanOrEqual(0);
    const drop = gd.pages[bandIdx].slots[1].photoId as string;
    const grv: RelayoutPhoto[] = g.map((p) => ({ ...p, status: p.id === drop ? "dropped" : "kept" }));
    const gr = relayoutDoc(gd, grv, { isPaid: true, maxPages: 100, captionLang: "en" });
    expectInDesign(gr.doc, { format: "A5_PORTRAIT", designStyle: "geometric" });
    expectValidDoc(gr.doc, keptIds(grv), 100);
    expect(new Set(placedIds(gr.doc))).toEqual(new Set(placedIds(gd).filter((id) => id !== drop)));
  });
});

// --- no cloned-looking consecutive pages (M10c polish) ---------------------------------------------------

describe("consecutive pages don't repeat a layout when an alternative exists (rule 10 look-ahead)", () => {
  type FP = { orient: "portrait" | "landscape" | "square"; ratio: number };
  const fp = (p: AutoPhoto): FP => {
    const r = p.width > 0 && p.height > 0 ? p.width / p.height : 1;
    return { ratio: r, orient: r >= 1.1 ? "landscape" : r <= 1 / 1.1 ? "portrait" : "square" };
  };
  const perms = <T,>(a: T[]): T[][] =>
    a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r]));
  /** Some assignment of `ps` to the layout's slots has no shape-aware miss. */
  const fits = (l: Layout, ps: FP[]) =>
    l.photoCount === ps.length && perms(ps).some((o) => o.every((p, i) => !shapeMiss(l, i, p, l.format)));
  const byTime = (a: AutoPhoto, b: AutoPhoto) => (a.takenAt ?? "~").localeCompare(b.takenAt ?? "~") || a.id.localeCompare(b.id);

  /**
   * Independent check: two consecutive multi-photo pages of one chapter with the same layout are a
   * defect when their photos also fit two different zero-miss page layouts (head k photos + rest,
   * or the q0 + q2 skip pair + rest — the splits the filler can make) that don't repeat the
   * neighbouring pages either. Short chapters never take all-"any" grids (rule 9).
   */
  function avoidableRepeats(doc: BookDoc, photos: readonly AutoPhoto[], d: BookDesign): string[] {
    const byId = new Map(photos.map((p) => [p.id, p]));
    const pageLayouts = layoutsFor(d.format, d.designStyle, "page");
    const owners = doc.pages.filter((p) => p.side !== "right");
    const out: string[] = [];
    for (let i = 0; i + 1 < owners.length; i++) {
      const a = owners[i];
      const b = owners[i + 1];
      if (a.layout !== b.layout || a.chapterId !== b.chapterId || a.slots.length < 2) continue;
      const chapterSize = doc.pages.filter((p) => p.chapterId === a.chapterId).reduce((n, p) => n + p.slots.length, 0);
      const S = [...a.slots, ...b.slots].map((x) => byId.get(x.photoId as string) as AutoPhoto).sort(byTime);
      const before = owners[i - 1]?.layout;
      const after = owners[i + 2]?.layout;
      const allowed = (l: Layout) => !(l.photoCount > 3 && chapterSize < 10 && l.prefers.every((p) => p === "any"));
      const splits: [AutoPhoto[], AutoPhoto[]][] = [];
      for (let k = 2; k <= S.length - 2; k++) splits.push([S.slice(0, k), S.slice(k)]);
      if (S.length >= 4) splits.push([[S[0], S[2]], [S[1], ...S.slice(3)]]);
      for (const [x, y] of splits) {
        for (const l1 of pageLayouts) {
          for (const l2 of pageLayouts) {
            if (l1.id === l2.id || l1.id === before || l2.id === after || !allowed(l1) || !allowed(l2)) continue;
            if (fits(l1, x.map(fp)) && fits(l2, y.map(fp))) out.push(`p${i + 1}–${i + 2} ${a.layout}×2 → ${l1.id} + ${l2.id}`);
          }
        }
      }
    }
    return out;
  }

  it.each(DESIGNS)("T10 photo-set matrix %o: no avoidable repeat, albums valid", (design) => {
    for (const n of SIZES) {
      for (const seed of [21, 22]) {
        const photos = momentSet(n, seed * 1000 + n);
        for (const isPaid of [false, true]) {
          const label = `${tag(design)} n=${n} seed=${seed} paid=${isPaid}`;
          const doc = autolayout(photos, { ...BASE, isPaid, design });
          expectValidDoc(doc, keptIds(photos), limitsFor(isPaid).maxPages, label);
          expect(avoidableRepeats(doc, photos, design), label).toEqual([]);
        }
      }
    }
  });

  it("the checker catches the repeats the greedy filler used to make (2+2 of one layout)", () => {
    const d: BookDesign = { format: "A5_PORTRAIT", designStyle: "scrapbook" };
    // Square + portrait twice: the greedy filler put both pairs on s-p-two-overlap; the squares
    // also fit s-p-two-land together (skip pair) and the portraits s-p-two-overlap.
    const P2 = [shot("a", 3000, 3000, 0), shot("b", ...P, 1)];
    const P3 = [shot("c", 3000, 3000, 2), shot("d", ...P, 3)];
    const doc = autolayout([...P2, ...P3], { ...BASE, isPaid: true, design: d });
    const fake: BookDoc = {
      ...doc,
      pages: [
        { id: "p1", chapterId: "c1", layout: "s-p-two-overlap", slots: P2.map((p) => ({ photoId: p.id, crop: { x: 0.5, y: 0.5, zoom: 1 } })), caption: null },
        { id: "p2", chapterId: "c1", layout: "s-p-two-overlap", slots: P3.map((p) => ({ photoId: p.id, crop: { x: 0.5, y: 0.5, zoom: 1 } })), caption: null },
      ],
    };
    expect(avoidableRepeats(fake, [...P2, ...P3], d).length).toBeGreaterThan(0);
  });

  it("scrapbook: 4 portrait-ish photos become 3 + 1 (or two different pairs), never two-overlap twice", () => {
    const d: BookDesign = { format: "A5_PORTRAIT", designStyle: "scrapbook" };
    const seq = (s: string) => [...s].map((c, i) => (c === "P" ? shot(`${s}${i}`, ...P, i) : shot(`${s}${i}`, 3000, 3000, i)));
    // Before: s-p-two-overlap, s-p-two-overlap (same stickers, looked cloned).
    expect(fillPages(seq("PPSP"), { design: d }).map((p) => [p.layout, p.photoIds.length])).toEqual([
      ["s-p-three-pile", 3],
      ["s-p-one-polaroid", 1],
    ]);
    expect(fillPages(seq("SPSP"), { design: d }).map((p) => p.layout)).toEqual(["s-p-two-land", "s-p-two-overlap"]);
    // The previous page's layout (relayout appends to a chapter) counts too.
    const after = ["s-p-two-land", ...fillPages(seq("SPSP"), { design: d, prevLayout: "s-p-two-land" }).map((p) => p.layout)];
    expect(after.slice(1).length).toBe(2);
    after.slice(1).forEach((id, i) => expect(id, after.join(" ")).not.toBe(after[i]));
  });

  it("geometric: 7 × 4:3 in a landscape book is one-band + three-diamond × 2 (was 1+2+3+1 with two one-band pages)", () => {
    const photos = Array.from({ length: 7 }, (_, i) => shot(`f${i}`, ...L, i));
    const doc = autolayout(photos, { ...BASE, isPaid: true, design: { format: "A5_LANDSCAPE", designStyle: "geometric" } });
    // No 2-page split of the last 6 avoids the repeat without another one-photo page (only the
    // diamond and the stack take 4:3 landscapes in a landscape book), so fewer pages wins.
    expect(doc.pages.map((p) => p.layout)).toEqual(["g-l-one-band", "g-l-three-diamond", "g-l-three-diamond"]);
    expectValidDoc(doc, keptIds(photos), 100);
  });

  it("bestPageLayout avoid: an equally fitting layout within tolerance replaces the page before's; never a worse fit; classic ignores it", () => {
    const design: BookDesign = { format: "A5_PORTRAIT", designStyle: "geometric" };
    const LL = ["landscape", "landscape"] as const;
    expect(bestPageLayout([...LL], { design, ratios: [4 / 3, 4 / 3] })).toBe("g-p-two-circle");
    expect(bestPageLayout([...LL], { design, ratios: [4 / 3, 4 / 3], avoid: "g-p-two-circle" })).toBe("g-p-two-diag");
    // A panorama would miss the circle → the diagonal stays even when it repeats.
    expect(bestPageLayout([...LL], { design, ratios: [4 / 3, 2.5], avoid: "g-p-two-diag" })).toBe("g-p-two-diag");
    const classic = bestPageLayout(["portrait", "portrait"]);
    expect(bestPageLayout(["portrait", "portrait"], { avoid: classic })).toBe(classic);
  });
});
