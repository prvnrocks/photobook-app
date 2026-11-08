import { describe, expect, it } from "vitest";
import { LIMITS, limitsFor } from "@/lib/ai/limits";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { BOOK_TITLE_MAX_CODE_POINTS, DEFAULT_TONE, OCCASIONS, TONES } from "@/lib/book/options";
import { TITLE_MAX_CHARS } from "@/app/books/form-state";

// PLAN "Book document format" example.
const example = () => ({
  version: 1,
  format: "A5_PORTRAIT",
  occasion: "wedding",
  cover: { layout: "cover", photoId: "p1", title: "Sara & Omar", subtitle: "Abu Dhabi · 2026" },
  chapters: [{ id: "m1", title: "The Mehndi Night", dateLabel: "12 Oct 2026", place: "Abu Dhabi" }],
  pages: [
    {
      id: "pg1",
      chapterId: "m1",
      layout: "two-vertical",
      slots: [
        { photoId: "p2", crop: { x: 0.5, y: 0.4, zoom: 1.0 } },
        { photoId: "p3", crop: { x: 0.5, y: 0.5, zoom: 1.2 } },
      ],
      caption: { text: "أجمل ليلة بدأت بضحكة", font: "Cairo", align: "center", source: "ai" },
    },
  ],
  style: { background: "#FFFFFF", font: "Playfair" },
});

const photoIds = new Set(["p1", "p2", "p3", "p4"]);
const opts = { photoIds, maxPages: LIMITS.free.maxPages };

function parsed(input: unknown): BookDoc {
  const r = parseBookDoc(input);
  if (!r.ok) throw new Error(r.issues.join("; "));
  return r.doc;
}

describe("parseBookDoc", () => {
  it("accepts the PLAN example", () => {
    const doc = parsed(example());
    expect(validateBookDoc(doc, opts)).toEqual([]);
  });

  it("rejects a bad version or format", () => {
    expect(parseBookDoc({ ...example(), version: 2 }).ok).toBe(false);
    expect(parseBookDoc({ ...example(), format: "A4" }).ok).toBe(false);
    expect(parseBookDoc(null).ok).toBe(false);
  });

  it("rejects out-of-range crop", () => {
    for (const crop of [
      { x: 1.2, y: 0.5, zoom: 1 },
      { x: 0.5, y: -0.1, zoom: 1 },
      { x: 0.5, y: 0.5, zoom: 0.5 },
      { x: 0.5, y: 0.5, zoom: 5 },
    ]) {
      const d = example();
      d.pages[0].slots[0].crop = crop;
      expect(parseBookDoc(d).ok).toBe(false);
    }
  });

  it("rejects captions over 200 chars and unknown caption source", () => {
    const d = example();
    d.pages[0].caption.text = "a".repeat(201);
    expect(parseBookDoc(d).ok).toBe(false);
    const e = example();
    e.pages[0].caption.source = "robot";
    expect(parseBookDoc(e).ok).toBe(false);
  });

  it("issues never echo user text", () => {
    const d = example();
    d.pages[0].caption.text = "SECRET".repeat(50);
    const r = parseBookDoc(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(" ")).not.toContain("SECRET");
  });

  it("rejects more pages than the paid maximum at the shape level", () => {
    const d = example();
    d.pages = Array.from({ length: LIMITS.paid.maxPages + 1 }, (_, i) => ({
      ...d.pages[0],
      id: `pg${i}`,
      slots: [],
    }));
    expect(parseBookDoc(d).ok).toBe(false);
  });
});

describe("validateBookDoc", () => {
  it("rejects too many pages for the tier", () => {
    const d = parsed(example());
    d.pages = Array.from({ length: 21 }, (_, i) => ({
      id: `pg${i}`,
      chapterId: null,
      layout: "full-page",
      slots: [{ photoId: null, crop: { x: 0.5, y: 0.5, zoom: 1 } }],
      caption: null,
    }));
    expect(validateBookDoc(d, opts).some((i) => i.includes("exceeds limit of 20"))).toBe(true);
    expect(validateBookDoc(d, { photoIds, maxPages: LIMITS.paid.maxPages })).toEqual([]);
  });

  it("rejects unknown photos (pages and cover)", () => {
    const d = parsed(example());
    d.pages[0].slots[1].photoId = "p999";
    d.cover.photoId = "p998";
    const issues = validateBookDoc(d, opts);
    expect(issues).toContain("pages[0].slots[1]: unknown photo");
    expect(issues).toContain("cover: unknown photo");
    expect(issues.join(" ")).not.toContain("p999");
  });

  it("rejects a photo used twice in pages but allows the cover photo once more", () => {
    const d = parsed(example());
    d.pages[0].slots[1].photoId = "p2";
    expect(validateBookDoc(d, opts)).toContain("pages[0].slots[1]: photo used more than once");

    const ok = parsed(example());
    ok.pages[0].slots[0].photoId = "p1"; // cover photo repeated once inside
    expect(validateBookDoc(ok, opts)).toEqual([]);
  });

  it("rejects slot-count mismatch, unknown layouts and wrong layout roles", () => {
    const d = parsed(example());
    d.pages[0].layout = "four-grid";
    expect(validateBookDoc(d, opts)).toContain('pages[0]: layout "four-grid" needs 4 slots, got 2');

    const u = parsed(example());
    u.pages[0].layout = "mystery";
    expect(validateBookDoc(u, opts)).toContain('pages[0]: unknown layout "mystery"');

    const c = parsed(example());
    c.cover.layout = "two-vertical";
    c.pages[0].layout = "cover";
    const issues = validateBookDoc(c, opts);
    expect(issues).toContain('cover: layout "two-vertical" is not a cover layout');
    expect(issues).toContain('pages[0]: layout "cover" is not a page layout');
  });

  it("rejects captions on layouts without a caption area", () => {
    const d = parsed(example());
    d.pages[0].layout = "full-page";
    d.pages[0].slots = [d.pages[0].slots[0]];
    expect(validateBookDoc(d, opts)).toContain('pages[0]: layout "full-page" has no caption area');
  });

  it("rejects unknown chapters and duplicate ids", () => {
    const d = parsed(example());
    d.pages[0].chapterId = "m9";
    d.chapters.push({ ...d.chapters[0] });
    d.pages.push({ ...d.pages[0], slots: d.pages[0].slots.map((s) => ({ ...s, photoId: null })) });
    const issues = validateBookDoc(d, opts);
    expect(issues).toContain("pages[0]: unknown chapter");
    expect(issues).toContain("chapters[1]: duplicate chapter id");
    expect(issues).toContain("pages[1]: duplicate page id");
  });
});

describe("options + limits", () => {
  it("every occasion has a valid default tone", () => {
    for (const o of OCCASIONS) expect(TONES).toContain(DEFAULT_TONE[o]);
  });

  it("limitsFor picks the tier", () => {
    expect(limitsFor(false).maxPages).toBe(20);
    expect(limitsFor(true).maxPages).toBe(100);
    expect(limitsFor(true).maxUploadPhotos).toBe(500);
    expect(limitsFor(false).maxAnalyzedPhotos).toBe(150);
  });
});

describe("text fields: lone surrogates and title length", () => {
  it("rejects lone surrogates in every text field", () => {
    const mutate: ((d: ReturnType<typeof example>) => void)[] = [
      (d) => (d.cover.title = "Sara & Omar \ud83d"),
      (d) => (d.cover.subtitle = "\udc8d"),
      (d) => (d.chapters[0].title = "x\ud83d"),
      (d) => (d.chapters[0].dateLabel = "x\ud83d"),
      (d) => (d.chapters[0].place = "x\ud83d"),
      (d) => (d.pages[0].caption!.text = "x\ud83d"),
      (d) => (d.pages[0].id = "pg\ud83d"),
    ];
    for (const m of mutate) {
      const d = example();
      m(d);
      const r = parseBookDoc(d);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.join(" ")).not.toContain("\ud83d");
    }
  });

  it("cover title limit = form limit, counted in code points", () => {
    expect(BOOK_TITLE_MAX_CODE_POINTS).toBe(TITLE_MAX_CHARS);
    const emoji = "💍".repeat(120); // 120 code points, 240 UTF-16 units
    expect(parseBookDoc({ ...example(), cover: { ...example().cover, title: emoji } }).ok).toBe(true);
    expect(parseBookDoc({ ...example(), cover: { ...example().cover, title: "a".repeat(120) } }).ok).toBe(true);
    expect(parseBookDoc({ ...example(), cover: { ...example().cover, title: "a".repeat(121) } }).ok).toBe(false);
    expect(parseBookDoc({ ...example(), cover: { ...example().cover, title: emoji + "💍" } }).ok).toBe(false);
  });

  it("accepts well-formed emoji and Arabic text", () => {
    const d = example();
    d.cover.title = "Sara & Omar 💍👨‍👩‍👧 🇦🇪";
    d.pages[0].caption!.text = "مُحَمَّد وَسَارَة 💍";
    expect(parseBookDoc(d).ok).toBe(true);
  });
});

