// M10b A10: rule-based autolayout, fitting and Update album relayout per book format + design
// style. Property tests over seeded photo sets for every (format, style), plus targeted spread
// cases. Classic A5 portrait output is frozen separately (autolayout-classic-golden.test.ts).

import { describe, expect, it } from "vitest";
import { autolayout, fillPages, PANORAMA_RATIO, type AutoPhoto } from "@/lib/autolayout";
import { limitsFor } from "@/lib/ai/limits";
import { ruleAlbum } from "@/lib/ai/fallback";
import type { BookDesign } from "@/lib/book/book-design";
import { relayoutDoc as relayoutRaw, RelayoutError, type RelayoutPhoto } from "@/lib/book/relayout";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import { isSpreadAligned } from "@/lib/book/spreads";
import type { BookDoc, BookPage } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";
import { bestCoverLayout, bestPageLayout, fullPageLayout } from "@/lib/layouts/fit";
import { momentSet, rng, SET_SIZES } from "./fixtures/autolayout-sets";

/** relayoutDoc with the validation issues in the error message (test diagnostics). */
const relayoutDoc: typeof relayoutRaw = (...args) => {
  try {
    return relayoutRaw(...args);
  } catch (e) {
    if (e instanceof RelayoutError) throw new Error(`RelayoutError: ${e.issues.join(" | ")}`);
    throw e;
  }
};

const DESIGNS: readonly BookDesign[] = [
  { format: "A5_PORTRAIT", designStyle: "classic" },
  { format: "A5_PORTRAIT", designStyle: "modern" },
  { format: "A5_LANDSCAPE", designStyle: "classic" },
  { format: "A5_LANDSCAPE", designStyle: "modern" },
];
const tag = (d: BookDesign) => `${d.format}/${d.designStyle}`;
const BASE = { occasion: "travel" as const, title: null, captionLang: "en" as const };

function keptIds(photos: readonly { id: string; status: string }[]): Set<string> {
  return new Set(photos.filter((p) => p.status === "kept").map((p) => p.id));
}

/** Kept photos after the autolayout duplicate rule (one per group): what an unconstrained album places. */
function dedupedCount(photos: AutoPhoto[]): number {
  const groups = new Set<number>();
  let n = 0;
  const seen = new Set<string>();
  for (const p of photos) {
    if (p.status !== "kept" || seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.dupGroup === null) n++;
    else groups.add(p.dupGroup);
  }
  return n + groups.size;
}

function placedIds(doc: BookDoc): string[] {
  return doc.pages.flatMap((p) => p.slots.map((s) => s.photoId).filter((id): id is string => id !== null));
}

function expectInDesign(doc: BookDoc, d: BookDesign) {
  expect(doc.format).toBe(d.format);
  expect(doc.style.designStyle).toBe(d.designStyle);
  const cover = getLayout(doc.cover.layout);
  expect(cover?.role).toBe("cover");
  expect(cover?.format).toBe(d.format);
  expect(cover?.style).toBe(d.designStyle);
  for (const p of doc.pages) {
    const l = getLayout(p.layout);
    expect(l, p.layout).toBeDefined();
    expect(l?.format).toBe(d.format);
    expect(l?.style).toBe(d.designStyle);
    expect(l?.role).not.toBe("cover");
  }
}

function expectValidDoc(doc: BookDoc, kept: Set<string>, maxPages: number, backgroundIds?: Set<string>) {
  const parsed = parseBookDoc(doc);
  expect(parsed.ok).toBe(true);
  expect(validateBookDoc(doc, { photoIds: kept, maxPages, backgroundPhotoIds: backgroundIds })).toEqual([]);
  expect(isSpreadAligned(doc)).toBe(true);
  expect(doc.pages.length).toBeLessThanOrEqual(maxPages);
  const ids = placedIds(doc);
  expect(new Set(ids).size).toBe(ids.length);
}

function reviewed(photos: AutoPhoto[], seed: number): RelayoutPhoto[] {
  const r = rng(seed * 13 + 5);
  const changed = photos.map((p) => ({
    ...p,
    status: (p.status === "kept" ? (r() < 0.2 ? "dropped" : "kept") : r() < 0.5 ? "kept" : "dropped") as "kept" | "dropped",
  }));
  const extra = momentSet(Math.max(1, Math.floor(photos.length / 8)), seed + 5000).map((p) => ({
    ...p,
    id: `x-${p.id}`,
    status: "kept" as const,
  }));
  return [...changed, ...extra];
}

describe.each(DESIGNS)("autolayout + relayout for %o", (design) => {
  it("seeded sets 1–150 photos: valid, aligned, in format+style, ≤ maxPages, photos placed", () => {
    for (const n of SET_SIZES) {
      for (const seed of [11, 12, 13]) {
        const photos = momentSet(n, seed * 1000 + n);
        const kept = keptIds(photos);
        for (const isPaid of [false, true]) {
          const maxPages = limitsFor(isPaid).maxPages;
          const doc = autolayout(photos, { ...BASE, isPaid, design });
          const label = `${tag(design)} n=${n} seed=${seed} paid=${isPaid}`;
          expectInDesign(doc, design);
          expectValidDoc(doc, kept, maxPages);
          expect(doc.meta?.generator, label).toBe("rule");
          if (kept.size > 0) {
            // Not the minimal safety-net album.
            expect(doc.chapters.length, label).toBeGreaterThan(0);
            expect(doc.cover.photoId, label).not.toBeNull();
          }
          const placed = placedIds(doc).length;
          if (isPaid && n <= 48) expect(placed, label).toBe(dedupedCount(photos));
          else expect(placed, label).toBeLessThanOrEqual(dedupedCount(photos));
          for (const id of placedIds(doc)) expect(kept.has(id)).toBe(true);

          // Update album after review changes keeps the design and all invariants.
          const r = relayoutDoc(doc, reviewed(photos, seed + n), { isPaid, maxPages, captionLang: "en" });
          const rKept = keptIds(reviewed(photos, seed + n));
          expectInDesign(r.doc, design);
          expectValidDoc(r.doc, rKept, maxPages);
        }
      }
    }
  });

  it("ruleAlbum (AI fallback) passes the design through", () => {
    const photos = momentSet(40, 77);
    const doc = ruleAlbum(photos, { ...BASE, isPaid: true, design }, null);
    expectInDesign(doc, design);
    expectValidDoc(doc, keptIds(photos), 100);
  });

  it("is deterministic", () => {
    const photos = momentSet(90, 5);
    expect(autolayout(photos, { ...BASE, isPaid: true, design })).toEqual(
      autolayout([...photos].reverse(), { ...BASE, isPaid: true, design }),
    );
  });

  it("fillPages stays in the design and makes single pages only", () => {
    const photos = momentSet(30, 9).map((p) => ({ ...p, status: "kept" as const }));
    for (const pg of fillPages(photos, { opener: true, design })) {
      const l = getLayout(pg.layout);
      expect(l?.role).toBe("page");
      expect(l?.format).toBe(design.format);
      expect(l?.style).toBe(design.designStyle);
      expect(pg.photoIds.length).toBe(l?.photoCount);
    }
  });
});

describe("modern spreads", () => {
  const modern = DESIGNS.filter((d) => d.designStyle === "modern");

  it.each(modern)("large moments get grid / mosaic spreads (%o)", (design) => {
    let big = 0;
    for (const n of [48, 64, 90, 120, 150]) {
      for (const seed of [1, 2, 3]) {
        const doc = autolayout(momentSet(n, seed * 31 + n), { ...BASE, isPaid: true, design });
        big += doc.pages.filter((p) => p.side === "left" && (getLayout(p.layout)?.photoCount ?? 0) > 1).length;
      }
    }
    expect(big).toBeGreaterThan(5);
  });

  it.each(modern)("a panorama becomes a panorama spread on a left page (%o)", (design) => {
    const photos: AutoPhoto[] = [
      { id: "pano", width: 6000, height: 2000, takenAt: "2026-10-12T09:00:00+04:00", dateSource: "exif", place: null, status: "kept", dupGroup: null, blurScore: 100 },
      { id: "b", width: 3000, height: 4000, takenAt: "2026-10-12T10:00:00+04:00", dateSource: "exif", place: null, status: "kept", dupGroup: null, blurScore: 100 },
    ];
    const doc = autolayout(photos, { ...BASE, isPaid: false, design });
    const i = doc.pages.findIndex((p) => p.slots.some((s) => s.photoId === "pano"));
    expect(i % 2).toBe(0);
    expect(doc.pages[i].side).toBe("left");
    expect(getLayout(doc.pages[i].layout)?.role).toBe("spread");
    expect(doc.pages[i + 1].side).toBe("right");
    expect(6000 / 2000).toBeGreaterThanOrEqual(PANORAMA_RATIO);
  });

  it("classic designs never get spreads", () => {
    for (const design of DESIGNS.filter((d) => d.designStyle === "classic")) {
      const doc = autolayout(momentSet(150, 4), { ...BASE, isPaid: true, design });
      expect(doc.pages.every((p) => p.side === undefined)).toBe(true);
    }
  });

  it("spreads respect the free page cap (2 pages each)", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (const design of modern) {
        const photos = momentSet(150, seed);
        const doc = autolayout(photos, { ...BASE, isPaid: false, design });
        expect(doc.pages.length).toBeLessThanOrEqual(20);
        expectValidDoc(doc, keptIds(photos), 20);
      }
    }
  });

  it("all-panorama sets on a tiny cap still fit (rebuild without spreads if needed)", () => {
    const photos: AutoPhoto[] = Array.from({ length: 60 }, (_, i) => ({
      id: `pz${i}`,
      width: 6000,
      height: 2000,
      takenAt: new Date(Date.parse("2026-10-01T08:00:00+04:00") + i * 26 * 3600_000).toISOString(),
      dateSource: "exif" as const,
      place: null,
      status: "kept" as const,
      dupGroup: null,
      blurScore: i,
    }));
    for (const design of modern) {
      const doc = autolayout(photos, { ...BASE, isPaid: false, design });
      expectValidDoc(doc, keptIds(photos), 20);
      expect(doc.chapters.length).toBeGreaterThan(0);
    }
  });
});

describe("fit helpers per design", () => {
  it("bestPageLayout: default = classic portrait; design picks only its own layouts", () => {
    expect(bestPageLayout(["portrait"])).toBe("full-page");
    expect(bestPageLayout(["portrait", "portrait"], { design: { format: "A5_LANDSCAPE", designStyle: "classic" } })).toBe("c-l-two-side");
    expect(bestPageLayout(["landscape", "landscape"], { design: { format: "A5_LANDSCAPE", designStyle: "classic" } })).toBe("c-l-two-stacked");
    expect(bestPageLayout(["landscape", "landscape"], { design: { format: "A5_PORTRAIT", designStyle: "modern" } })).toBe("m-p-two-stack");
    expect(bestPageLayout(Array(12).fill("square"), { design: { format: "A5_PORTRAIT", designStyle: "modern" }, role: "spread" })).toBe("m-p-spread-grid");
    expect(bestPageLayout(Array(12).fill("square"), { design: { format: "A5_PORTRAIT", designStyle: "classic" }, role: "spread" })).toBeNull();
    for (const d of DESIGNS) {
      for (let k = 1; k <= 6; k++) {
        const id = bestPageLayout(Array(k).fill("landscape"), { design: d, preferCaption: true });
        if (id === null) continue;
        const l = getLayout(id)!;
        expect([l.format, l.style, l.role, l.photoCount]).toEqual([d.format, d.designStyle, "page", k]);
      }
    }
  });

  it("bestCoverLayout / fullPageLayout stay in the design", () => {
    expect(bestCoverLayout()).toBe("cover");
    expect(fullPageLayout()).toBe("full-page");
    expect(fullPageLayout({ format: "A5_LANDSCAPE", designStyle: "classic" })).toBe("c-l-full-page");
    expect(fullPageLayout({ format: "A5_PORTRAIT", designStyle: "modern" })).toBe("m-p-full");
    expect(fullPageLayout({ format: "A5_LANDSCAPE", designStyle: "modern" })).toBe("m-l-full-bleed");
    expect(bestCoverLayout({ format: "A5_LANDSCAPE", designStyle: "modern" }, "landscape")).toBe("m-l-cover-strip");
    expect(bestCoverLayout({ format: "A5_LANDSCAPE", designStyle: "modern" }, "portrait")).toBe("m-l-cover-panel");
    for (const d of DESIGNS) {
      for (const o of ["portrait", "landscape", "square", null] as const) {
        const l = getLayout(bestCoverLayout(d, o))!;
        expect([l.role, l.format, l.style]).toEqual(["cover", d.format, d.designStyle]);
      }
    }
  });
});

// ---------- relayout with spreads ----------

const MP: BookDesign = { format: "A5_PORTRAIT", designStyle: "modern" };
const ML: BookDesign = { format: "A5_LANDSCAPE", designStyle: "modern" };
const P = { width: 3000, height: 4000 };
const L = { width: 4000, height: 3000 };

function rp(id: string, size: { width: number; height: number }, hour: number, status: "kept" | "dropped" = "kept"): RelayoutPhoto {
  return { id, ...size, takenAt: `2026-10-12T${String(hour).padStart(2, "0")}:00:00`, status, place: null, dupGroup: null, blurScore: 50 };
}

const slotsOf = (ids: string[]) => ids.map((photoId) => ({ photoId, crop: { x: 0.5, y: 0.5, zoom: 1 } }));
const single = (id: string, layout: string, ids: string[]): BookPage => ({ id, chapterId: "c1", layout, slots: slotsOf(ids), caption: null });
const spread = (leftId: string, rightId: string, layout: string, ids: string[], caption: BookPage["caption"] = null): BookPage[] => [
  { id: leftId, chapterId: "c1", layout, slots: slotsOf(ids), caption, side: "left" },
  { id: rightId, chapterId: "c1", layout, slots: [], caption: null, side: "right" },
];

function docOf(design: BookDesign, pages: BookPage[], cover: string): BookDoc {
  return {
    version: 2,
    format: design.format,
    occasion: "travel",
    cover: { layout: bestCoverLayout(design, "portrait"), photoId: cover, title: "Trip", subtitle: "" },
    chapters: [{ id: "c1", title: "Day one", dateLabel: "12 Oct 2026", place: null }],
    pages,
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: design.designStyle, font: "Playfair" },
    meta: { generator: "ai", generatorVersion: 1, runId: null, userEdited: false },
  };
}

const OPTS = { isPaid: true, maxPages: 100, captionLang: "en" as const };

describe("relayoutDoc with spreads", () => {
  // m-p-spread-mosaic prefers [P, any, any, L, P, L, L]: slots 0–2 on the left page, 3–6 on the right.
  const mosaicIds = ["m0", "m1", "m2", "m3", "m4", "m5", "m6"];
  const mosaicPhotos = [rp("m0", P, 9), rp("m1", P, 9), rp("m2", P, 9), rp("m3", L, 10), rp("m4", P, 10), rp("m5", L, 10), rp("m6", L, 10)];

  it("untouched spreads stay as they are", () => {
    const doc = docOf(MP, [...spread("p1", "p2", "m-p-spread-mosaic", mosaicIds)], "m0");
    const r = relayoutDoc(doc, mosaicPhotos, OPTS);
    expect(r.changed).toBe(false);
    expect(r.doc).toBe(doc);
  });

  it("a spread losing a photo with no smaller spread splits into its halves (single pages, in style)", () => {
    const doc = docOf(MP, [...spread("p1", "p2", "m-p-spread-mosaic", mosaicIds)], "m0");
    const photos = mosaicPhotos.map((p) => (p.id === "m5" ? { ...p, status: "dropped" as const } : p));
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.changed).toBe(true);
    expect(r.doc.pages.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(r.doc.pages.every((p) => p.side === undefined)).toBe(true);
    expect(r.doc.pages[0].slots.map((s) => s.photoId)).toEqual(["m0", "m1", "m2"]);
    expect(r.doc.pages[1].slots.map((s) => s.photoId)).toEqual(["m3", "m4", "m6"]);
    expectInDesign(r.doc, MP);
    expectValidDoc(r.doc, keptIds(photos), 100);
  });

  it("an emptied half is dropped; the user's caption moves to the remaining half", () => {
    const caption = { text: "Our day", font: "Playfair" as const, align: "center" as const, source: "user" as const };
    const doc = docOf(MP, [...spread("p1", "p2", "m-p-spread-mosaic", mosaicIds, caption)], "m0");
    const photos = mosaicPhotos.map((p) => (["m3", "m4", "m5", "m6"].includes(p.id) ? { ...p, status: "dropped" as const } : p));
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.doc.pages).toHaveLength(1);
    expect(r.doc.pages[0].slots.map((s) => s.photoId)).toEqual(["m0", "m1", "m2"]);
    expect(r.doc.pages[0].caption).toEqual(caption);
    expectValidDoc(r.doc, keptIds(photos), 100);
  });

  it("a spread-grid losing photos refits to a smaller spread when every photo fits it", () => {
    // 12-grid → 7 left: mosaic needs [P, any, any, L, P, L, L].
    const ids = Array.from({ length: 12 }, (_, i) => `g${i}`);
    const sizes = [P, P, P, L, P, L, L, P, P, P, P, P];
    const photos = ids.map((id, i) => rp(id, sizes[i], 9 + Math.floor(i / 6), i >= 7 ? "dropped" : "kept"));
    const doc = docOf(MP, [...spread("p1", "p2", "m-p-spread-grid", ids)], "g0");
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.doc.pages.map((p) => [p.layout, p.side])).toEqual([
      ["m-p-spread-mosaic", "left"],
      ["m-p-spread-mosaic", "right"],
    ]);
    expectValidDoc(r.doc, keptIds(photos), 100);
  });

  it("a spread-grid losing one photo → six-grid + five-photo page", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `g${i}`);
    const photos = ids.map((id, i) => rp(id, P, 9, i === 8 ? "dropped" : "kept"));
    const doc = docOf(MP, [...spread("p1", "p2", "m-p-spread-grid", ids)], "g0");
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.doc.pages.map((p) => getLayout(p.layout)?.photoCount)).toEqual([6, 5]);
    expect(r.doc.pages.every((p) => p.side === undefined)).toBe(true);
    expectValidDoc(r.doc, keptIds(photos), 100);
  });

  it("a removed page before a spread → repairSpreads splits the shifted spread into its twins", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `g${i}`);
    const photos = [rp("a", P, 8, "dropped"), rp("b", P, 8), ...ids.map((id) => rp(id, P, 9))];
    const doc = docOf(MP, [single("p1", "m-p-full", ["a"]), single("p2", "m-p-full", ["b"]), ...spread("p3", "p4", "m-p-spread-grid", ids)], "b");
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.doc.pages.map((p) => p.layout)).toEqual(["m-p-full", "m-p-six-grid", "m-p-six-grid"]);
    expectValidDoc(r.doc, keptIds(photos), 100);
  });

  it("panorama spread losing its photo goes as a unit; a lone photo never becomes a panorama", () => {
    const pano = { width: 6000, height: 2000 };
    const photos = [rp("pz", pano, 8, "dropped"), rp("x", P, 9)];
    const doc = docOf(ML, [...spread("p1", "p2", "m-l-spread-panorama", ["pz"]), single("p3", "m-l-one-text", ["x"])], "x");
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.doc.pages.map((p) => p.id)).toEqual(["p3"]);
    expectValidDoc(r.doc, keptIds(photos), 100);

    const grid = Array.from({ length: 12 }, (_, i) => `g${i}`);
    const ps2 = grid.map((id, i) => rp(id, P, 9, i === 0 ? "kept" : "dropped"));
    const r2 = relayoutDoc(docOf(ML, spread("p1", "p2", "m-l-spread-grid", grid), "g0"), ps2, OPTS);
    expect(getLayout(r2.doc.pages[0].layout)?.role).toBe("page");
    expectValidDoc(r2.doc, keptIds(ps2), 100);
  });

  it("cap shrink removes a trailing spread as one unit", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `g${i}`);
    const photos = [rp("a", P, 8), rp("b", P, 8), ...ids.map((id) => rp(id, P, 9))];
    const doc = docOf(MP, [single("p1", "m-p-full", ["a"]), single("p2", "m-p-full", ["b"]), ...spread("p3", "p4", "m-p-spread-grid", ids)], "a");
    const r = relayoutDoc(doc, photos, { isPaid: false, maxPages: 3, captionLang: "en" });
    expect(r.doc.pages.map((p) => p.id)).toEqual(["p1", "p2"]);
    expectValidDoc(r.doc, keptIds(photos), 3);
  });

  it("new photos are added as single pages of the design", () => {
    const photos = [...mosaicPhotos, rp("n1", L, 11), rp("n2", L, 11)];
    const doc = docOf(MP, spread("p1", "p2", "m-p-spread-mosaic", mosaicIds), "m0");
    const r = relayoutDoc(doc, photos, OPTS);
    expect(r.added).toBe(2);
    expect(r.doc.pages.slice(0, 2)).toEqual(doc.pages);
    expect(r.doc.pages.slice(2).every((p) => getLayout(p.layout)?.role === "page" && p.side === undefined)).toBe(true);
    expectInDesign(r.doc, MP);
    expectValidDoc(r.doc, keptIds(photos), 100);
  });
});
