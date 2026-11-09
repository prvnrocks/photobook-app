import { describe, expect, it } from "vitest";

import {
  applyCaptions,
  batchIndexOfKey,
  batchIndexOfMoment,
  captionBatches,
  checkHeading,
  countCaptionablePages,
  docCaptionContext,
  groundStoryText,
  headingContext,
  neutralSubtitle,
} from "@/lib/ai/captions";
import { buildCaptionContext } from "@/lib/ai/caption-check";
import { LIMITS } from "@/lib/ai/limits";
import { planToDoc } from "@/lib/ai/plan-to-doc";
import { pageCaptionKeys } from "@/lib/ai/repair";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { aliasMaps, fixturePlan, RUN_ID, storyBook, storyPhotos } from "../helpers/story-fixtures";

function fixtureDoc(): BookDoc {
  const photos = storyPhotos();
  const r = planToDoc(fixturePlan(), {
    aliasToId: aliasMaps(photos).aliasToId,
    photos,
    book: storyBook(),
    runId: RUN_ID,
    generatorVersion: 2,
  });
  if (!("doc" in r)) throw new Error(r.issues.join("; "));
  return r.doc;
}

const keptIds = () => new Set(storyPhotos().filter((p) => p.keep).map((p) => p.id));

/** A synthetic doc with `n` one-portrait pages spread over `chapters` chapters (photo ids unique). */
function bigDoc(n: number, chapters: number): BookDoc {
  const base = fixtureDoc();
  return {
    ...base,
    cover: { ...base.cover, photoId: null },
    chapters: Array.from({ length: chapters }, (_, i) => ({ id: `c${i + 1}`, title: `Part ${i + 1}`, dateLabel: "", place: null })),
    pages: Array.from({ length: n }, (_, i) => ({
      id: `p${i + 1}`,
      chapterId: `c${Math.floor((i * chapters) / n) + 1}`,
      layout: "one-portrait",
      slots: [{ photoId: `photo-${i}`, crop: { x: 0.5, y: 0.5, zoom: 1 } }],
      caption: null,
    })),
  };
}

describe("captionBatches", () => {
  // Fixture: m1 = one-portrait, three-mixed, two-horizontal, one-portrait; m2 = two-vertical, full-page, one-portrait
  it("captions only pages with a caption area, keyed m{n}:{k} over all chapter pages", () => {
    const doc = fixtureDoc();
    const batches = captionBatches(doc, { lang: "en" });
    expect(batches).toHaveLength(1);
    expect(batches[0].keys).toEqual(["m1:0", "m1:1", "m1:2", "m1:3", "m2:0", "m2:2"]);
    expect(batches[0].keys).not.toContain("m2:1"); // full-page has no caption area
    expect(countCaptionablePages(doc)).toBe(6);
    expect(batches[0].moments.map((m) => [m.momentId, m.wantHeading])).toEqual([
      ["m1", true],
      ["m2", true],
    ]);
  });

  it("keys round-trip with repair.ts pageCaptionKeys (same page in doc order)", () => {
    const doc = fixtureDoc();
    const keys = pageCaptionKeys(doc);
    for (const b of captionBatches(doc, { lang: "en" })) {
      for (const m of b.moments) for (const p of m.pages) expect(keys[p.bookPageIndex]).toBe(p.key);
    }
  });

  it("uses chapter POSITION, not the chapter id, for moment ids", () => {
    const doc = fixtureDoc();
    const renamed: BookDoc = {
      ...doc,
      chapters: doc.chapters.map((c, i) => ({ ...c, id: `x${i}` })),
      pages: doc.pages.map((p) => ({ ...p, chapterId: p.chapterId === "c1" ? "x0" : "x1" })),
    };
    expect(captionBatches(renamed, { lang: "en" })[0].keys).toEqual(captionBatches(doc, { lang: "en" })[0].keys);
    expect(pageCaptionKeys(renamed).filter(Boolean)).toEqual(pageCaptionKeys(doc).filter(Boolean));
  });

  it("plan input yields the same keys as the doc", () => {
    expect(captionBatches(fixturePlan(), { lang: "en" })[0].keys).toEqual(captionBatches(fixtureDoc(), { lang: "en" })[0].keys);
  });

  it("skips pages with a user caption", () => {
    const doc = fixtureDoc();
    doc.pages[2].caption = { text: "Ours", font: "Playfair", align: "center", source: "user" };
    const keys = captionBatches(doc, { lang: "en" })[0].keys;
    expect(keys).not.toContain("m1:2");
    expect(keys).toContain("m1:3");
    expect(countCaptionablePages(doc)).toBe(5);
  });

  it("splits consecutive moments by page budget; a continued moment asks no heading", () => {
    const doc = fixtureDoc();
    const batches = captionBatches(doc, { lang: "en", maxPagesPerBatch: 3 });
    expect(batches.map((b) => b.keys)).toEqual([
      ["m1:0", "m1:1", "m1:2"],
      ["m1:3", "m2:0", "m2:2"],
    ]);
    expect(batches[1].moments.map((m) => [m.momentId, m.wantHeading])).toEqual([
      ["m1", false],
      ["m2", true],
    ]);
    expect(batchIndexOfMoment(batches)("m1")).toBe(0);
    expect(batchIndexOfMoment(batches)("m2")).toBe(1);
    expect(batchIndexOfMoment(batches)("m9")).toBeUndefined();
    expect(batchIndexOfKey(batches)("m1:3")).toBe(1);
    expect(batches.map((b) => b.index)).toEqual([0, 1]);
  });

  it("batch count ≤ ceil(captionable / 12) and ≤ the build cap", () => {
    for (const [n, ch] of [[20, 3], [37, 5], [100, 9], [100, 40]] as const) {
      const doc = bigDoc(n, ch);
      const batches = captionBatches(doc, { lang: "en" });
      expect(batches.length).toBeLessThanOrEqual(Math.ceil(n / 12));
      expect(batches.length).toBeLessThanOrEqual(LIMITS.free.maxCaptionBatchesPerBuild);
      expect(batches.every((b) => b.keys.length <= 12)).toBe(true);
      expect(batches.flatMap((b) => b.keys)).toHaveLength(n);
    }
  });

  it("pages past the batch cap are left out (null)", () => {
    const batches = captionBatches(bigDoc(100, 10), { lang: "en", maxPagesPerBatch: 5 });
    expect(batches).toHaveLength(LIMITS.free.maxCaptionBatchesPerBuild);
    expect(batches.flatMap((b) => b.keys)).toHaveLength(50);
  });

  it("ordinals are book-wide and increasing", () => {
    const batches = captionBatches(bigDoc(30, 4), { lang: "en" });
    const ords = batches.flatMap((b) => b.moments.flatMap((m) => m.pages.map((p) => p.ordinal)));
    expect(ords).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });
});

describe("applyCaptions", () => {
  const all = (keys: string[]) => new Map(keys.map((k, i) => [k, `  A quiet line number one ${["a", "b", "c", "d", "e", "f"][i]}  `]));

  it("writes AI captions (Playfair, centre, source ai) and the doc still validates", () => {
    const doc = fixtureDoc();
    const keys = captionBatches(doc, { lang: "en" })[0].keys;
    const out = applyCaptions(doc, all(keys), new Map([["m1", "Getting ready together"]]), { lang: "en" });
    expect(out).not.toBe(doc);
    expect(doc.pages.every((p) => p.caption === null)).toBe(true); // input untouched
    const captioned = out.pages.filter((p) => p.caption);
    expect(captioned).toHaveLength(6);
    expect(captioned[0].caption).toEqual({ text: "A quiet line number one a", font: "Playfair", align: "center", source: "ai" });
    expect(out.pages[5].caption).toBeNull(); // full-page
    expect(out.chapters[0].title).toBe("Getting ready together");
    expect(out.chapters[1].title).toBe(doc.chapters[1].title);
    const parsed = parseBookDoc(out);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(validateBookDoc(parsed.doc, { photoIds: keptIds(), maxPages: 20 })).toEqual([]);
  });

  it("uses Cairo for Arabic", () => {
    const doc = fixtureDoc();
    const out = applyCaptions(doc, new Map([["m1:0", "ضحكة صغيرة تملأ المكان"]]), new Map(), { lang: "ar" });
    expect(out.pages[0].caption?.font).toBe("Cairo");
  });

  it("never touches user captions, even when a result exists for that key", () => {
    const doc = fixtureDoc();
    const user = { text: "Our own words", font: "Playfair", align: "left" as const, source: "user" as const };
    doc.pages[1].caption = user;
    const out = applyCaptions(doc, new Map([["m1:1", "AI text"], ["m1:0", "Other text"]]), new Map(), { lang: "en" });
    expect(out.pages[1].caption).toEqual(user);
    expect(out.pages[0].caption?.text).toBe("Other text");
  });

  it("ignores captions for pages without a caption area and unknown keys", () => {
    const doc = fixtureDoc();
    const out = applyCaptions(doc, new Map([["m2:1", "Full page"], ["m7:0", "Nope"]]), new Map(), { lang: "en" });
    expect(out.pages.every((p) => p.caption === null)).toBe(true);
  });

  it("keeps the Storyteller title when a heading fails validation", () => {
    const doc = fixtureDoc();
    const headings = new Map([
      ["m1", "A trip with Ahmed"], // unknown name
      ["m2", "One two three four five six seven eight nine"], // > 8 words
    ]);
    const out = applyCaptions(doc, new Map(), headings, { lang: "en" });
    expect(out.chapters.map((c) => c.title)).toEqual(doc.chapters.map((c) => c.title));
  });

  it("heading check (SF3): date-label numbers are allowed, chapter-title words are NOT (AI text)", () => {
    const doc = fixtureDoc();
    const ctx = docCaptionContext(doc, "en");
    expect(checkHeading("Before the Ready moment", ctx).map((i) => i.code)).toContain("unknown_name");
    expect(checkHeading("At last in Paris", ctx).map((i) => i.code)).toContain("unknown_name");
    expect(checkHeading("Our best 2026", ctx)).toEqual([]);
  });

  it("clips long caption text without breaking surrogates", () => {
    const doc = fixtureDoc();
    const long = "😀".repeat(150);
    const out = applyCaptions(doc, new Map([["m1:0", long]]), new Map(), { lang: "en" });
    expect(out.pages[0].caption!.text.length).toBeLessThanOrEqual(200);
    expect(parseBookDoc(out).ok).toBe(true);
  });
});

describe("groundStoryText (SF3)", () => {
  const dates = storyPhotos().map((p) => p.takenAt);
  const ctx = (over: Partial<Parameters<typeof buildCaptionContext>[0]> = {}) =>
    buildCaptionContext({ lang: "en", dates, ...over });
  const withText = (titles: string[], subtitle: string): BookDoc => {
    const d = fixtureDoc();
    return { ...d, cover: { ...d.cover, subtitle }, chapters: d.chapters.map((c, i) => ({ ...c, title: titles[i] ?? c.title })) };
  };

  it("clean sentence-case titles, 'Day 2' ordinals and an empty subtitle are kept (same object)", () => {
    const doc = withText(["Getting ready", "Day 2"], "");
    const r = groundStoryText(doc, ctx(), { lang: "en", dates });
    expect(r.doc).toBe(doc);
    expect(r).toMatchObject({ chapters: [], subtitle: false });
  });

  it("an invented name / place in a chapter title → its date label; in the subtitle → the date range", () => {
    const doc = withText(["Dinner with Ahmed", "Evenings in Paris"], "A weekend with Ahmed");
    const r = groundStoryText(doc, ctx(), { lang: "en", dates });
    expect(r.chapters).toEqual([0, 1]);
    expect(r.subtitle).toBe(true);
    expect(r.doc.chapters[0].title).toBe(doc.chapters[0].dateLabel);
    expect(r.doc.cover.subtitle).toBe("12–13 Oct 2026");
    expect(parseBookDoc(r.doc).ok).toBe(true);
  });

  it("names from user data are fine: user title, knownNames, GPS places", () => {
    const doc = withText(["Dinner with Ahmed", "Evenings in Paris"], "Sara and Omar");
    const r = groundStoryText(doc, ctx({ knownNames: ["Ahmed"], photoPlaces: ["Paris"], bookTitle: "Sara & Omar" }), { lang: "en", dates });
    expect(r).toMatchObject({ chapters: [], subtitle: false });
  });

  it("no date label → 'Chapter n' (en) / 'الفصل n' (ar); undated subtitle → the one shared place, else empty", () => {
    const base = withText(["Dinner with Ahmed", "Fine"], "A weekend with Ahmed");
    const doc: BookDoc = { ...base, chapters: base.chapters.map((c) => ({ ...c, dateLabel: "" })) };
    expect(groundStoryText(doc, ctx(), { lang: "en", dates: [] }).doc.chapters[0].title).toBe("Chapter 1");
    const arDoc: BookDoc = { ...doc, chapters: doc.chapters.map((c) => ({ ...c, title: "Ahmed" })) };
    const ar = groundStoryText(arDoc, buildCaptionContext({ lang: "ar" }), { lang: "ar", dates: [] });
    expect(ar.doc.chapters.map((c) => c.title)).toEqual(["الفصل 1", "الفصل 2"]);
    expect(groundStoryText(doc, ctx(), { lang: "en", dates: [] }).doc.cover.subtitle).toBe("");
    const placed: BookDoc = { ...doc, chapters: doc.chapters.map((c) => ({ ...c, place: "Abu Dhabi" })) };
    expect(neutralSubtitle(placed, [])).toBe("Abu Dhabi");
  });

  it("headingContext adds chapter ordinals only", () => {
    const h = headingContext(ctx(), 3);
    expect(checkHeading("Day 3", h)).toEqual([]);
    expect(checkHeading("Day 4", h).map((i) => i.code)).toContain("unknown_number");
  });

  it("applyCaptions with a metadata ctx rejects a heading that only an AI chapter title would allow", () => {
    const doc = withText(["Dinner with Ahmed", "Fine"], "");
    const out = applyCaptions(doc, new Map(), new Map([["m2", "More time with Ahmed"]]), { lang: "en", ctx: ctx() });
    expect(out.chapters[1].title).toBe("Fine");
  });
});
