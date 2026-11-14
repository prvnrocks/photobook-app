import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COVER_ASPECT,
  DRAWN_SPINE_W,
  filterShelf,
  selectionAfterFilter,
  SHELF_BOOKS,
  SHELF_DEFAULT_ID,
  SHELF_EDGES,
  SHELF_FILTERS,
  SPINE_NATURAL_H,
  spineCropStyle,
  spineRatio,
  stepSelection,
  trackShift,
  type ShelfBook,
} from "@/lib/marketing/shelf";

/** PNG width/height from the IHDR chunk. */
function pngSize(src: string) {
  const buf = readFileSync(path.join(process.cwd(), "public", src));
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const ids = (books: readonly ShelfBook[]) => books.map((b) => b.id);

describe("shelf data", () => {
  it("14 books in mockup order with the user's categories", () => {
    expect(SHELF_BOOKS.map((b) => [b.title, b.category])).toEqual([
      ["Our Family", "family"],
      ["Little Years", "kids"],
      ["Summer Abroad", "travel"],
      ["Mountain Days", "travel"],
      ["Sunday Walks", "family"],
      ["Desert Days", "travel"],
      ["First Steps", "kids"],
      ["The Day We Said Yes", "weddings"],
      ["The Wedding", "weddings"],
      ["Forest Retreat", "travel"],
      ["Island Escape", "travel"],
      ["A Year Abroad", "travel"],
      ["New Beginnings", "kids"],
      ["Family Reunion", "family"],
    ]);
    expect(new Set(ids(SHELF_BOOKS)).size).toBe(SHELF_BOOKS.length);
  });

  it("only The Day We Said Yes has a real cover (and no spine PNG); everyone else has a spine", () => {
    for (const b of SHELF_BOOKS) {
      if (b.id === SHELF_DEFAULT_ID) {
        expect(b.cover).toBeDefined();
        expect(b.spine).toBeUndefined();
      } else {
        expect(b.cover).toBeUndefined();
        expect(b.spine).toBeDefined();
      }
    }
  });

  it("asset sizes match the files on disk; cover aspect is the real cover's", () => {
    for (const b of SHELF_BOOKS) {
      const a = b.spine ?? b.cover!;
      expect(pngSize(a.src)).toEqual({ w: a.w, h: a.h });
    }
    for (const e of Object.values(SHELF_EDGES)) expect(pngSize(e.src)).toEqual({ w: e.w, h: e.h });
    const cover = SHELF_BOOKS.find((b) => b.cover)!.cover!;
    expect(COVER_ASPECT).toBeCloseTo(cover.w / cover.h, 6);
  });

  it("photo and glyph boxes sit inside their spine", () => {
    for (const b of SHELF_BOOKS) {
      if (!b.spine) continue;
      expect(b.spine.h).toBe(SPINE_NATURAL_H);
      for (const box of [b.spine.photo, b.spine.glyph]) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w).toBeLessThanOrEqual(b.spine.w);
        expect(box.y + box.h).toBeLessThanOrEqual(b.spine.h);
        expect(box.w).toBeGreaterThan(20);
      }
      expect(b.spine.photo.y + b.spine.photo.h).toBeLessThan(b.spine.glyph.y);
    }
  });

  it("colours are hex, tones and blurbs set", () => {
    for (const b of SHELF_BOOKS) {
      expect(b.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(["light", "dark"]).toContain(b.tone);
      expect(b.blurb.length).toBeGreaterThan(10);
      expect(b.blurb.length).toBeLessThanOrEqual(100);
    }
  });

  it("filters: All + every category that has books", () => {
    expect(SHELF_FILTERS.map((f) => f.label)).toEqual(["All", "Family", "Travel", "Weddings", "Kids"]);
    for (const f of SHELF_FILTERS) expect(filterShelf(SHELF_BOOKS, f.id).length).toBeGreaterThan(0);
  });
});

describe("filterShelf", () => {
  it("all keeps order; a category keeps only its books in order", () => {
    expect(ids(filterShelf(SHELF_BOOKS, "all"))).toEqual(ids(SHELF_BOOKS));
    expect(ids(filterShelf(SHELF_BOOKS, "weddings"))).toEqual(["the-day-we-said-yes", "the-wedding"]);
    expect(ids(filterShelf(SHELF_BOOKS, "family"))).toEqual(["our-family", "sunday-walks", "family-reunion"]);
    expect(ids(filterShelf(SHELF_BOOKS, "kids"))).toEqual(["little-years", "first-steps", "new-beginnings"]);
    expect(filterShelf(SHELF_BOOKS, "travel")).toHaveLength(6);
  });
});

describe("selectionAfterFilter", () => {
  it("keeps the current book when still visible", () => {
    expect(selectionAfterFilter(filterShelf(SHELF_BOOKS, "travel"), "island-escape")).toBe("island-escape");
  });
  it("falls back to the default book, then to the middle book", () => {
    expect(selectionAfterFilter(filterShelf(SHELF_BOOKS, "weddings"), "island-escape")).toBe(SHELF_DEFAULT_ID);
    expect(selectionAfterFilter(filterShelf(SHELF_BOOKS, "kids"), SHELF_DEFAULT_ID)).toBe("first-steps");
    expect(selectionAfterFilter(filterShelf(SHELF_BOOKS, "travel"), SHELF_DEFAULT_ID)).toBe("desert-days");
  });
  it("empty list → null", () => {
    expect(selectionAfterFilter([], SHELF_DEFAULT_ID)).toBeNull();
  });
});

describe("stepSelection", () => {
  const all = SHELF_BOOKS;
  it("moves by delta and clamps at both ends (no wrap)", () => {
    expect(stepSelection(all, SHELF_DEFAULT_ID, 1)).toBe("the-wedding");
    expect(stepSelection(all, SHELF_DEFAULT_ID, -1)).toBe("first-steps");
    expect(stepSelection(all, SHELF_DEFAULT_ID, -3)).toBe("sunday-walks");
    expect(stepSelection(all, "our-family", -1)).toBe("our-family");
    expect(stepSelection(all, "family-reunion", 5)).toBe("family-reunion");
  });
  it("steps within the filtered list only", () => {
    const fam = filterShelf(all, "family");
    expect(stepSelection(fam, "our-family", 1)).toBe("sunday-walks");
  });
  it("unknown current → first visible", () => {
    expect(stepSelection(filterShelf(all, "kids"), "nope", 1)).toBe("little-years");
  });
});

describe("trackShift", () => {
  const edge = SHELF_EDGES.left.w / SPINE_NATURAL_H;
  it("first book: just the left edge and one gap", () => {
    expect(trackShift(SHELF_BOOKS, "our-family")).toEqual({ ratio: Math.round(edge * 1e4) / 1e4, gaps: 1 });
  });
  it("sums the visible spines before the selected book", () => {
    const before = SHELF_BOOKS.slice(0, 7);
    const want = edge + before.reduce((s, b) => s + spineRatio(b), 0);
    const got = trackShift(SHELF_BOOKS, SHELF_DEFAULT_ID);
    expect(got.gaps).toBe(8);
    expect(got.ratio).toBeCloseTo(want, 3);
  });
  it("filtered list ignores hidden books", () => {
    const wed = filterShelf(SHELF_BOOKS, "weddings");
    const got = trackShift(wed, "the-wedding");
    expect(got.gaps).toBe(2);
    expect(got.ratio).toBeCloseTo(edge + DRAWN_SPINE_W / SPINE_NATURAL_H, 3);
  });
  it("unknown selection behaves like the first book", () => {
    expect(trackShift(SHELF_BOOKS, "nope").gaps).toBe(1);
  });
});

describe("spineCropStyle", () => {
  it("maps the photo box to background size/position and keeps its aspect", () => {
    const fam = SHELF_BOOKS[0];
    const s = spineCropStyle(fam, "photo")!;
    const p = fam.spine!.photo;
    expect(s.aspectRatio).toBe(`${p.w} / ${p.h}`);
    expect(s.backgroundImage).toBe(`url(${fam.spine!.src})`);
    const [bw, bh] = s.backgroundSize.split(" ").map(parseFloat);
    expect(bw).toBeCloseTo((fam.spine!.w / p.w) * 100, 1);
    expect(bh).toBeCloseTo((SPINE_NATURAL_H / p.h) * 100, 1);
    const [px, py] = s.backgroundPosition.split(" ").map(parseFloat);
    expect(px).toBeCloseTo((p.x / (fam.spine!.w - p.w)) * 100, 1);
    expect(py).toBeCloseTo((p.y / (SPINE_NATURAL_H - p.h)) * 100, 1);
  });
  it("null for a book without a spine PNG", () => {
    expect(spineCropStyle(SHELF_BOOKS.find((b) => b.cover)!, "glyph")).toBeNull();
  });
});
