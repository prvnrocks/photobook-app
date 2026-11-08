import { describe, expect, it } from "vitest";
import { autolayout, dayRange, parseTime, type AutoPhoto, type AutolayoutOptions } from "@/lib/autolayout";
import { LIMITS } from "@/lib/ai/limits";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";

const OPTS: AutolayoutOptions = { occasion: "travel", title: null, captionLang: "en", isPaid: false };

/** Deterministic PRNG (mulberry32) so fixtures are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function photo(id: string, over: Partial<AutoPhoto> = {}): AutoPhoto {
  return {
    id,
    width: 3000,
    height: 4000,
    takenAt: "2026-10-12T10:00:00+04:00",
    dateSource: "exif",
    place: "Abu Dhabi",
    status: "kept",
    dupGroup: null,
    blurScore: 100,
    ...over,
  };
}

/** n photos over `days` days, mixed orientation, some places, some undated, some dup groups. */
function makeSet(n: number, seed = 1, days = 6): AutoPhoto[] {
  const r = rng(seed);
  const places = ["Abu Dhabi", "Dubai", null, "Al Ain"];
  const start = Date.parse("2026-10-10T08:00:00+04:00");
  return Array.from({ length: n }, (_, i) => {
    const t = start + Math.floor(r() * days * 24 * 3600 * 1000);
    const land = r() < 0.4;
    return photo(`ph-${String(i).padStart(4, "0")}`, {
      width: land ? 4000 : 3000,
      height: land ? 3000 : 4000,
      takenAt: r() < 0.05 ? null : new Date(t).toISOString(),
      place: places[Math.floor(r() * places.length)],
      blurScore: Math.round(r() * 500),
      dupGroup: r() < 0.1 ? Math.floor(r() * 10) : null,
      status: r() < 0.05 ? "dropped" : "kept",
    });
  });
}

function keptIds(photos: AutoPhoto[]) {
  return new Set(photos.filter((p) => p.status === "kept").map((p) => p.id));
}

function expectValid(doc: BookDoc, photos: AutoPhoto[], maxPages: number) {
  const parsed = parseBookDoc(doc);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(validateBookDoc(parsed.doc, { photoIds: keptIds(photos), maxPages })).toEqual([]);
}

const slotIds = (doc: BookDoc) => doc.pages.flatMap((p) => p.slots.map((s) => s.photoId));

function shuffle<T>(xs: T[], seed: number): T[] {
  const r = rng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe("autolayout — sizes", () => {
  it("0 photos → cover without photo, no pages", () => {
    const doc = autolayout([], OPTS);
    expect(doc.cover).toEqual({ layout: "cover", photoId: null, title: "Our Travels", subtitle: "" });
    expect(doc.pages).toEqual([]);
    expect(doc.chapters).toEqual([]);
    expectValid(doc, [], 20);
  });

  it("1 photo → cover + one page with that photo", () => {
    const ps = [photo("a")];
    const doc = autolayout(ps, OPTS);
    expect(doc.cover.photoId).toBe("a");
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].layout).toBe("one-portrait");
    expect(slotIds(doc)).toEqual(["a"]);
    expect(doc.cover.subtitle).toBe("Abu Dhabi · Oct 2026");
    expectValid(doc, ps, 20);
  });

  it("7 photos → all placed, valid, chapter opener alone", () => {
    const ps = Array.from({ length: 7 }, (_, i) =>
      photo(`p${i}`, {
        takenAt: `2026-10-12T1${i}:00:00+04:00`,
        width: i % 3 === 0 ? 4000 : 3000,
        height: i % 3 === 0 ? 3000 : 4000,
      }),
    );
    const doc = autolayout(ps, OPTS);
    expectValid(doc, ps, 20);
    expect(new Set(slotIds(doc))).toEqual(new Set(ps.map((p) => p.id)));
    expect(doc.pages[0].slots).toHaveLength(1);
    expect(doc.chapters).toHaveLength(1);
    expect(doc.chapters[0]).toEqual({ id: "c1", title: "Abu Dhabi", dateLabel: "12 Oct 2026", place: "Abu Dhabi" });
    for (const p of doc.pages) {
      expect(p.caption).toBeNull();
      for (const s of p.slots) expect(s.crop).toEqual({ x: 0.5, y: 0.5, zoom: 1 });
    }
    expect(doc.pages.map((p) => p.id)).toEqual(doc.pages.map((_, i) => `p${i + 1}`));
  });

  it("150 photos on free → ≤ 20 pages, valid, every chapter has a page", () => {
    const ps = makeSet(150, 7);
    const doc = autolayout(ps, OPTS);
    expect(doc.pages.length).toBeLessThanOrEqual(LIMITS.free.maxPages);
    expect(doc.pages.length).toBeGreaterThan(10);
    expectValid(doc, ps, LIMITS.free.maxPages);
    for (const c of doc.chapters) expect(doc.pages.some((p) => p.chapterId === c.id)).toBe(true);
  });

  it("500 photos on paid → ≤ 100 pages, valid, fast", () => {
    const ps = makeSet(500, 3, 20);
    const t0 = performance.now();
    const doc = autolayout(ps, { ...OPTS, isPaid: true });
    const ms = performance.now() - t0;
    expect(doc.pages.length).toBeLessThanOrEqual(LIMITS.paid.maxPages);
    expect(doc.pages.length).toBeGreaterThan(50);
    expectValid(doc, ps, LIMITS.paid.maxPages);
    expect(ms).toBeLessThan(200);
  });

  it("many short chapters beyond the cap are merged to fit", () => {
    // 40 different days, 1 photo each, free cap 20 pages
    const ps = Array.from({ length: 40 }, (_, i) =>
      photo(`d${String(i).padStart(2, "0")}`, {
        takenAt: new Date(Date.parse("2026-01-01T12:00:00+04:00") + i * 86400000).toISOString(),
        place: null,
      }),
    );
    const doc = autolayout(ps, OPTS);
    expect(doc.chapters.length).toBeLessThanOrEqual(20);
    expect(doc.pages.length).toBeLessThanOrEqual(20);
    expectValid(doc, ps, 20);
  });
});

describe("autolayout — filtering", () => {
  it("excludes dropped photos", () => {
    const ps = [photo("a"), photo("b", { status: "dropped" }), photo("c")];
    const doc = autolayout(ps, OPTS);
    expect(slotIds(doc)).not.toContain("b");
    expect(doc.cover.photoId).not.toBe("b");
  });

  it("keeps the sharpest of a duplicate group, then largest, then id", () => {
    const ps = [
      photo("x1", { dupGroup: 1, blurScore: 50 }),
      photo("x2", { dupGroup: 1, blurScore: 90 }),
      photo("x3", { dupGroup: 1, blurScore: 70 }),
      photo("y1", { dupGroup: 2, blurScore: 10, width: 300, height: 400 }),
      photo("y2", { dupGroup: 2, blurScore: 10, width: 3000, height: 4000 }),
      photo("z2", { dupGroup: 3, blurScore: null }),
      photo("z1", { dupGroup: 3, blurScore: null }),
    ];
    const ids = slotIds(autolayout(ps, OPTS));
    expect(ids.sort()).toEqual(["x2", "y2", "z1"]);
  });

  it("opts.dupGroups overrides photo.dupGroup", () => {
    const ps = [photo("a", { blurScore: 1 }), photo("b", { blurScore: 2 }), photo("c")];
    const ids = slotIds(autolayout(ps, { ...OPTS, dupGroups: new Map([["a", 5], ["b", 5]]) }));
    expect(ids.sort()).toEqual(["b", "c"]);
  });
});

describe("autolayout — chapters & order", () => {
  const at = (id: string, takenAt: string | null, place: string | null = "Abu Dhabi") =>
    photo(id, { takenAt, place });

  it("breaks on Dubai calendar day", () => {
    // 23:30 and 00:30 Dubai time, 1 h apart → different days
    const doc = autolayout([at("a", "2026-10-12T19:30:00Z"), at("b", "2026-10-12T20:30:00Z")], OPTS);
    expect(doc.chapters.map((c) => c.dateLabel)).toEqual(["12 Oct 2026", "13 Oct 2026"]);
  });

  it("does not break across UTC midnight inside one Dubai day", () => {
    const doc = autolayout([at("a", "2026-10-12T22:30:00Z"), at("b", "2026-10-13T01:00:00Z")], OPTS);
    expect(doc.chapters).toHaveLength(1);
    expect(doc.chapters[0].dateLabel).toBe("13 Oct 2026");
  });

  it("breaks on a gap > 6 h within the day, not on exactly 6 h", () => {
    const d1 = autolayout([at("a", "2026-10-12T06:00:00+04:00"), at("b", "2026-10-12T12:01:00+04:00")], OPTS);
    expect(d1.chapters).toHaveLength(2);
    const d2 = autolayout([at("a", "2026-10-12T06:00:00+04:00"), at("b", "2026-10-12T12:00:00+04:00")], OPTS);
    expect(d2.chapters).toHaveLength(1);
  });

  it("breaks on place change; null place never breaks", () => {
    const doc = autolayout(
      [
        at("a", "2026-10-12T10:00:00+04:00", "Abu Dhabi"),
        at("b", "2026-10-12T10:10:00+04:00", null),
        at("c", "2026-10-12T10:20:00+04:00", "Abu Dhabi"),
        at("d", "2026-10-12T10:30:00+04:00", "Dubai"),
        at("e", "2026-10-12T10:40:00+04:00", null),
      ],
      OPTS,
    );
    expect(doc.chapters.map((c) => c.title)).toEqual(["Abu Dhabi", "Dubai"]);
    const byChapter = (cid: string) =>
      doc.pages.filter((p) => p.chapterId === cid).flatMap((p) => p.slots.map((s) => s.photoId));
    expect(byChapter("c1").sort()).toEqual(["a", "b", "c"]);
    expect(byChapter("c2").sort()).toEqual(["d", "e"]);
  });

  it("chapter without place is titled by its day", () => {
    const doc = autolayout([at("a", "2026-10-12T10:00:00+04:00", null)], OPTS);
    expect(doc.chapters[0]).toEqual({ id: "c1", title: "12 Oct 2026", dateLabel: "12 Oct 2026", place: null });
  });

  it("puts undated photos last, sorted by id, in their own chapter", () => {
    const doc = autolayout(
      [at("u2", null), at("d1", "2026-10-12T10:00:00+04:00", null), at("u1", null), at("bad", "not a date")],
      OPTS,
    );
    const ids = slotIds(doc);
    expect(ids[0]).toBe("d1");
    expect(ids.slice(1).sort()).toEqual(["bad", "u1", "u2"]);
    expect(doc.chapters).toHaveLength(2);
    expect(doc.chapters[1].dateLabel).toBe("");
  });

  it("all-undated book still gets a chapter", () => {
    const doc = autolayout([at("u1", null, null)], OPTS);
    expect(doc.chapters[0].title).toBe("Our moments");
  });

  it("orders pages chronologically", () => {
    const ps = [
      at("late", "2026-10-14T10:00:00+04:00", null),
      at("early", "2026-10-12T10:00:00+04:00", null),
      at("mid", "2026-10-13T10:00:00+04:00", null),
    ];
    expect(slotIds(autolayout(ps, OPTS))).toEqual(["early", "mid", "late"]);
  });

  it("reads zone-less timestamps as Dubai time, independent of machine TZ", () => {
    expect(parseTime("2026-10-12T10:00:00")).toBe(Date.parse("2026-10-12T10:00:00+04:00"));
    expect(parseTime("2026-10-12 10:00:00")).toBe(Date.parse("2026-10-12T10:00:00+04:00"));
    expect(parseTime("2026-10-12")).toBe(Date.parse("2026-10-12T00:00:00+04:00"));
    expect(parseTime("2026-10-12T10:00:00Z")).toBe(Date.parse("2026-10-12T10:00:00Z"));
    expect(parseTime("garbage")).toBeNull();
    expect(parseTime(null)).toBeNull();
  });

  it("formats day ranges", () => {
    const day = (s: string) => Math.floor((Date.parse(s + "T12:00:00+04:00") + 4 * 3600e3) / 86400e3);
    expect(dayRange(day("2026-10-12"), day("2026-10-14"))).toBe("12–14 Oct 2026");
    expect(dayRange(day("2026-10-30"), day("2026-11-02"))).toBe("30 Oct – 2 Nov 2026");
    expect(dayRange(day("2026-12-30"), day("2027-01-02"))).toBe("30 Dec 2026 – 2 Jan 2027");
  });

  it("merged multi-day chapter gets a range label", () => {
    const ps = Array.from({ length: 30 }, (_, i) =>
      photo(`m${String(i).padStart(2, "0")}`, {
        takenAt: new Date(Date.parse("2026-10-01T12:00:00+04:00") + i * 86400000).toISOString(),
        place: null,
      }),
    );
    const doc = autolayout(ps, OPTS);
    expect(doc.chapters.some((c) => /–/.test(c.dateLabel))).toBe(true);
  });
});

describe("autolayout — layouts", () => {
  const land = (id: string, t: string) => photo(id, { width: 4000, height: 3000, takenAt: t });
  const port = (id: string, t: string) => photo(id, { width: 3000, height: 4000, takenAt: t });
  const T = (m: number) => `2026-10-12T10:${String(m).padStart(2, "0")}:00+04:00`;

  it("portrait pairs end up in two-vertical", () => {
    const doc = autolayout([port("a", T(0)), port("b", T(1)), port("c", T(2))], OPTS);
    expect(doc.pages.map((p) => p.layout)).toEqual(["one-portrait", "two-vertical"]);
    expect(doc.pages[1].slots.map((s) => s.photoId)).toEqual(["b", "c"]);
  });

  it("landscape pairs end up in two-horizontal; single landscape → full-page", () => {
    const doc = autolayout([land("a", T(0)), land("b", T(1)), land("c", T(2))], OPTS);
    expect(doc.pages.map((p) => p.layout)).toEqual(["full-page", "two-horizontal"]);
  });

  it("landscape + 2 portraits → three-mixed with the landscape in the wide slot", () => {
    const doc = autolayout([port("o", T(0)), port("a", T(1)), land("b", T(2)), port("c", T(3))], OPTS);
    expect(doc.pages[1].layout).toBe("three-mixed");
    expect(doc.pages[1].slots.map((s) => s.photoId)).toEqual(["b", "a", "c"]);
  });

  it("square photos fit both orientations", () => {
    const sq = (id: string, t: string) => photo(id, { width: 1000, height: 1050, takenAt: t });
    const doc = autolayout([port("o", T(0)), sq("a", T(1)), land("b", T(2))], OPTS);
    expect(doc.pages[1].layout).toBe("two-horizontal");
  });

  it("long chapters use four-grid and vary layouts", () => {
    const ps = Array.from({ length: 21 }, (_, i) => port(`q${String(i).padStart(2, "0")}`, T(i)));
    const doc = autolayout(ps, OPTS);
    const layouts = doc.pages.map((p) => p.layout);
    expect(layouts).toContain("four-grid");
    for (let i = 2; i < layouts.length - 1; i++) {
      expect(layouts[i] === layouts[i - 1] && layouts[i] === layouts[i - 2]).toBe(false);
    }
  });

  it("every slot photo exists and is unique; layouts match slot counts", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const ps = makeSet(80, seed);
      const doc = autolayout(ps, OPTS);
      const ids = slotIds(doc);
      expect(new Set(ids).size).toBe(ids.length);
      const kept = keptIds(ps);
      for (const id of ids) expect(kept.has(id as string)).toBe(true);
      expectValid(doc, ps, 20);
    }
  });
});

describe("autolayout — cover & style", () => {
  it("prefers a portrait cover, then the sharpest", () => {
    const ps = [
      photo("l", { width: 4000, height: 3000, blurScore: 999 }),
      photo("p1", { blurScore: 10 }),
      photo("p2", { blurScore: 20 }),
    ];
    expect(autolayout(ps, OPTS).cover.photoId).toBe("p2");
  });

  it("uses opts.title, occasion defaults and Arabic font", () => {
    expect(autolayout([], { ...OPTS, title: "Sara & Omar" }).cover.title).toBe("Sara & Omar");
    expect(autolayout([], { ...OPTS, title: "   " }).cover.title).toBe("Our Travels");
    expect(autolayout([], { ...OPTS, occasion: "wedding" }).cover.title).toBe("Our Wedding");
    expect(autolayout([], OPTS).style).toEqual({ background: "#FFFFFF", font: "Playfair" });
    expect(autolayout([], { ...OPTS, captionLang: "ar" }).style.font).toBe("Cairo");
  });

  it("subtitle = most common place · month range", () => {
    const ps = [
      photo("a", { place: "Dubai", takenAt: "2026-10-30T10:00:00+04:00" }),
      photo("b", { place: "Abu Dhabi", takenAt: "2026-11-01T10:00:00+04:00" }),
      photo("c", { place: "Abu Dhabi", takenAt: "2026-11-02T10:00:00+04:00" }),
    ];
    expect(autolayout(ps, OPTS).cover.subtitle).toBe("Abu Dhabi · Oct – Nov 2026");
  });

  it("caps long titles to the schema limit", () => {
    const doc = autolayout([photo("a", { place: "X".repeat(200) })], { ...OPTS, title: "T".repeat(200) });
    expect(doc.cover.title.length).toBeLessThanOrEqual(80);
    expectValid(doc, [photo("a")], 20);
  });
});

describe("autolayout — determinism", () => {
  it("same input → deep-equal output, also with shuffled input", () => {
    const ps = makeSet(150, 11);
    const a = autolayout(ps, OPTS);
    expect(autolayout(ps, OPTS)).toEqual(a);
    expect(autolayout(shuffle(ps, 99), OPTS)).toEqual(a);
    const big = makeSet(500, 12, 15);
    const b = autolayout(big, { ...OPTS, isPaid: true });
    expect(autolayout(shuffle(big, 5), { ...OPTS, isPaid: true })).toEqual(b);
  });
});
