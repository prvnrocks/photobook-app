// M10b A11 — Storyteller v5: per-design prompt + catalogue, spreads in the plan, captions with
// spreads, style caption fonts. Pure / replay only (no network).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildStorytellerRequest } from "@/lib/ai/agents/storyteller";
import { synthAlbumPlan } from "@/lib/ai/agents/storyteller-replay";
import { applyCaptions, captionBatches, countCaptionablePages, hasCaptionArea } from "@/lib/ai/captions";
import { fitPlanToDesign, planPageCount, planToDoc, prunePlan, validatePlanAgainstPhotos } from "@/lib/ai/plan-to-doc";
import { layoutCatalogue, storytellerSystem, storytellerSystemText } from "@/lib/ai/prompts/storyteller";
import { isCaptionable, pageCaptionKeys } from "@/lib/ai/repair";
import { AlbumPlanAiSchema, AlbumPlanBackgroundsAiSchema, type AlbumPlan } from "@/lib/ai/schemas";
import type { StoryPhoto } from "@/lib/ai/story";
import type { BookDesign } from "@/lib/book/book-design";
import { validateBookDoc } from "@/lib/book/schema";
import { isSpreadAligned, layoutsFor } from "@/lib/book/spreads";
import type { BookDoc } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";
import { aliasMaps, RUN_ID, storyBook } from "../helpers/story-fixtures";

const CLASSIC_PORTRAIT: BookDesign = { format: "A5_PORTRAIT", designStyle: "classic" };
const MODERN_PORTRAIT: BookDesign = { format: "A5_PORTRAIT", designStyle: "modern" };
const CLASSIC_LANDSCAPE: BookDesign = { format: "A5_LANDSCAPE", designStyle: "classic" };
const MODERN_LANDSCAPE: BookDesign = { format: "A5_LANDSCAPE", designStyle: "modern" };
const ALL = [CLASSIC_PORTRAIT, MODERN_PORTRAIT, CLASSIC_LANDSCAPE, MODERN_LANDSCAPE];

// ------------------------------------------------------------------------------------------ prompt

describe("Storyteller v5 system prompt per design", () => {
  it("classic A5 portrait text is BYTE-IDENTICAL to v4 (HEAD 9a5a525) — caches + replays stay valid", () => {
    const v4 = readFileSync(join(process.cwd(), "tests/fixtures/ai/storyteller/system-v4-classic-portrait.txt"), "utf8");
    expect(storytellerSystemText()).toBe(v4);
    expect(storytellerSystemText(CLASSIC_PORTRAIT)).toBe(v4);
    expect(storytellerSystem()[0].text).toBe(v4);
  });

  it("4 stable prefixes: identical across calls per design, distinct between designs, cache_control on the block", () => {
    const texts = ALL.map((d) => storytellerSystemText(d));
    expect(new Set(texts).size).toBe(4);
    for (const d of ALL) {
      const a = storytellerSystem(d);
      const b = storytellerSystem({ ...d });
      expect(a).toEqual(b);
      expect(a).not.toBe(b); // fresh array each call
      expect(a).toHaveLength(1);
      expect(a[0].cache_control).toEqual({ type: "ephemeral" });
    }
  });

  it("each catalogue lists exactly that design's layouts (built at runtime from layoutsFor), nothing per book", () => {
    for (const d of ALL) {
      const text = storytellerSystemText(d);
      const own = new Set(
        (["page", "spread", "cover"] as const).flatMap((r) => layoutsFor(d.format, d.designStyle, r).map((l) => l.id)),
      );
      // v6: the BACKGROUNDS list (modern) uses the same "- id · " shape — count layouts only.
      const layoutsPart = text.split("\nBACKGROUNDS (")[0];
      const listed = new Set([...layoutsPart.matchAll(/^- ([a-z0-9-]+) · /gm)].map((m) => m[1]));
      expect(listed).toEqual(own);
      expect(text).not.toMatch(/maxPages: \d|kept photos: \d/);
    }
  });

  it("modern catalogues describe spreads (2 pages, must start on a left page); classic ones have none", () => {
    for (const d of [MODERN_PORTRAIT, MODERN_LANDSCAPE]) {
      const cat = layoutCatalogue(d);
      expect(cat).toContain("SPREAD LAYOUTS");
      for (const l of layoutsFor(d.format, d.designStyle, "spread")) {
        expect(cat).toContain(`- ${l.id} · "${l.name}" · ${l.photoCount} photo${l.photoCount === 1 ? "" : "s"}`);
      }
      expect(cat.match(/occupies 2 pages, must start on a left page/g)?.length).toBe(layoutsFor(d.format, d.designStyle, "spread").length);
      const text = storytellerSystemText(d);
      expect(text).toContain("a spread counts as 2 pages");
      expect(text).toContain("must start on a left page");
    }
    for (const d of [CLASSIC_PORTRAIT, CLASSIC_LANDSCAPE]) expect(storytellerSystemText(d)).not.toMatch(/spread/i);
    expect(storytellerSystemText(CLASSIC_LANDSCAPE)).toContain("works on a landscape cover");
  });

  it("snapshots per non-classic-portrait design (regenerate with -u when a layout is added to that catalogue)", () => {
    expect(storytellerSystemText(MODERN_PORTRAIT)).toMatchSnapshot("modern-portrait");
    expect(storytellerSystemText(CLASSIC_LANDSCAPE)).toMatchSnapshot("classic-landscape");
    expect(storytellerSystemText(MODERN_LANDSCAPE)).toMatchSnapshot("modern-landscape");
  });

  it("buildStorytellerRequest picks the design's system text; default = classic; effort/schema unchanged", () => {
    const photos = photoSet(6);
    const { aliasOf } = aliasMaps(photos);
    const base = { photos, book: storyBook(), aliasOf };
    const classic = buildStorytellerRequest(base);
    const modern = buildStorytellerRequest({ ...base, design: MODERN_LANDSCAPE });
    expect(classic.system[0].text).toBe(storytellerSystemText());
    expect(modern.system[0].text).toBe(storytellerSystemText(MODERN_LANDSCAPE));
    // v6 (M10c T12): modern photo lines carry the photo colour and modern uses the backgrounds
    // schema (D-068); classic keeps the v5 user message + AlbumPlanAiSchema.
    expect(modern.messages).not.toEqual(classic.messages);
    expect(classic.messages[0].content).not.toContain("colour ");
    expect(modern.messages[0].content).toContain("colour unknown");
    expect(modern.effort).toBe(classic.effort);
    expect(classic.schema).toBe(AlbumPlanAiSchema);
    expect(modern.schema).toBe(AlbumPlanBackgroundsAiSchema);
    expect(modern.maxTokens).toBe(classic.maxTokens);
    expect(modern.scenarioMeta).toMatchObject({ design: MODERN_LANDSCAPE });
  });
});

// ------------------------------------------------------------------------------------------ plans

/** n kept photos on one day, 10 min apart; every 3rd landscape. */
function photoSet(n: number, landscapeEvery = 3): StoryPhoto[] {
  return Array.from({ length: n }, (_, i) => {
    const land = (i + 1) % landscapeEvery === 0;
    return {
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      width: land ? 4032 : 3024,
      height: land ? 3024 : 4032,
      takenAt: new Date(Date.parse("2026-10-12T10:00:00+04:00") + i * 600_000).toISOString(),
      place: null,
      keep: true,
      analysis: { description: "a photo", scene: "group", mood: "joyful", quality: 7, coverWorthy: i === 0 },
    };
  });
}

const photos = photoSet(24);
const { aliasToId } = aliasMaps(photos);
const a = (n: number) => `p${n}`;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => a(from + i));
const base = { aliasToId, photos, book: storyBook({ maxPages: 20 }), runId: RUN_ID, generatorVersion: 5 };

function plan(moments: Array<Array<{ layoutId: string; photoIds: string[] }>>, cover = "p1"): AlbumPlan {
  return {
    title: "Our day",
    subtitle: "",
    coverPhotoId: cover,
    moments: moments.map((pages, i) => ({ id: `m${i + 1}`, title: `Part ${i + 1}`, dateLabel: "", place: null, pages })),
  };
}

function okDoc(p: AlbumPlan, design: BookDesign, over: Partial<typeof base> = {}): BookDoc {
  const r = planToDoc(p, { ...base, ...over, design });
  if (!("doc" in r)) throw new Error(`issues: ${r.issues.join("; ")}`);
  return r.doc;
}

describe("planToDoc — spreads in the plan (modern)", () => {
  it("a spread entry expands into the page pair: left owns slots (side left), right empty (side right), same chapter", () => {
    const p = plan([
      [
        { layoutId: "m-p-full", photoIds: [a(1)] },
        { layoutId: "m-p-two-panel", photoIds: [a(2), a(4)] },
        { layoutId: "m-p-spread-mosaic", photoIds: [a(5), a(7), a(8), a(3), a(10), a(6), a(9)] },
      ],
    ]);
    const doc = okDoc(p, MODERN_PORTRAIT);
    expect(doc.pages.map((x) => [x.layout, x.side ?? null, x.slots.length])).toEqual([
      ["m-p-full", null, 1],
      ["m-p-two-panel", null, 2],
      ["m-p-spread-mosaic", "left", 7],
      ["m-p-spread-mosaic", "right", 0],
    ]);
    expect(doc.pages[2].slots.map((s) => s.photoId)).toEqual([5, 7, 8, 3, 10, 6, 9].map((n) => aliasToId.get(a(n))));
    expect(doc.pages[3]).toMatchObject({ chapterId: "c1", caption: null, slots: [] });
    expect(isSpreadAligned(doc)).toBe(true);
    expect(validateBookDoc(doc, { photoIds: new Set(photos.map((x) => x.id)), maxPages: 20 })).toEqual([]);
  });

  it("a spread counts as 2 pages toward maxPages", () => {
    const p = plan([
      [
        { layoutId: "m-p-spread-grid", photoIds: range(1, 12) },
        { layoutId: "m-p-full", photoIds: [a(13)] },
      ],
    ]);
    expect(planPageCount(p)).toBe(3);
    expect(okDoc(p, MODERN_PORTRAIT).pages).toHaveLength(3);
    const r = planToDoc(p, { ...base, book: storyBook({ maxPages: 2 }), design: MODERN_PORTRAIT });
    expect("issues" in r && r.issues).toEqual(["plan: 3 pages exceeds the limit of 2 pages (a spread counts as 2)"]);
    expect(validatePlanAgainstPhotos(p, { aliasToId, photos, maxPages: 3, design: MODERN_PORTRAIT })).toEqual([]);
  });

  it("a spread on a right-hand page is split into its twin single pages (repairSpreads), no photo lost", () => {
    const p = plan([
      [
        { layoutId: "m-p-full", photoIds: [a(1)] },
        { layoutId: "m-p-spread-grid", photoIds: range(2, 13) },
      ],
    ]);
    const doc = okDoc(p, MODERN_PORTRAIT);
    expect(isSpreadAligned(doc)).toBe(true);
    expect(doc.pages.map((x) => x.layout)).toEqual(["m-p-full", "m-p-six-grid", "m-p-six-grid"]);
    expect(doc.pages.every((x) => x.side === undefined)).toBe(true);
    expect(doc.pages.flatMap((x) => x.slots.map((s) => s.photoId))).toEqual(range(1, 13).map((x) => aliasToId.get(x)));
  });

  it("a spread later in the book starts on an even index counting earlier spreads as 2", () => {
    const p = plan([
      [{ layoutId: "m-l-spread-panorama", photoIds: [a(3)] }],
      [
        { layoutId: "m-l-full-bleed", photoIds: [a(6)] },
        { layoutId: "m-l-one", photoIds: [a(9)] },
        { layoutId: "m-l-spread-mosaic", photoIds: [a(12), a(15), a(18), a(21), a(24), a(1)] },
      ],
    ]);
    const doc = okDoc(p, MODERN_LANDSCAPE);
    expect(doc.pages.map((x) => x.side ?? "-")).toEqual(["left", "right", "-", "-", "left", "right"]);
    expect(doc.pages.map((x) => x.chapterId)).toEqual(["c1", "c1", "c2", "c2", "c2", "c2"]);
  });

  it("layouts of another format/style are re-fitted inside the book's design (spread → spread of that count)", () => {
    const p = plan([
      [
        { layoutId: "full-page", photoIds: [a(1)] }, // classic portrait
        { layoutId: "m-p-full", photoIds: [a(2)] }, // modern portrait (wrong format)
        { layoutId: "m-p-spread-grid", photoIds: range(3, 14) }, // modern portrait spread, starts at index 2
      ],
    ]);
    const fitted = fitPlanToDesign(p, { aliasToId, photos, design: MODERN_LANDSCAPE });
    expect(fitted.moments[0].pages.map((x) => x.layoutId)).toEqual(["m-l-one-text", "m-l-one-text", "m-l-spread-grid"]);
    const doc = okDoc(p, MODERN_LANDSCAPE);
    for (const x of doc.pages) expect(getLayout(x.layout)).toMatchObject({ format: "A5_LANDSCAPE", style: "modern" });
    expect(fitPlanToDesign(fitted, { aliasToId, photos, design: MODERN_LANDSCAPE })).toBe(fitted); // idempotent
  });

  it("a spread in a classic book is re-fitted to page layouts (classic has no spreads); no fit → issue (retry → rule fallback)", () => {
    const panorama = plan([[{ layoutId: "m-l-spread-panorama", photoIds: [a(3)] }]]);
    const doc = okDoc(panorama, CLASSIC_LANDSCAPE);
    expect(doc.pages.map((x) => [x.layout, x.side ?? null])).toEqual([["c-l-full-page", null]]);
    const grid = plan([[{ layoutId: "m-p-spread-grid", photoIds: range(1, 12) }]]);
    const r = planToDoc(grid, { ...base, design: CLASSIC_PORTRAIT });
    expect("issues" in r && r.issues).toEqual(['moments[0].pages[0]: layout "m-p-spread-grid" is not in this book\'s catalogue (use only the catalogue layouts)']);
  });

  it("cover = the style's cover layout for the cover photo's orientation (classic portrait stays 'cover')", () => {
    const p = plan([[{ layoutId: "m-l-one", photoIds: [a(3)] }]], "p2");
    expect(okDoc(p, MODERN_LANDSCAPE).cover.layout).toBe("m-l-cover-panel"); // p2 portrait
    expect(okDoc(plan([[{ layoutId: "m-l-one", photoIds: [a(3)] }]], "p3"), MODERN_LANDSCAPE).cover.layout).toBe("m-l-cover-strip");
    expect(okDoc(plan([[{ layoutId: "full-page", photoIds: [a(3)] }]], "p3"), CLASSIC_PORTRAIT).cover.layout).toBe("cover");
    expect(okDoc(plan([[{ layoutId: "m-p-full", photoIds: [a(1)] }]]), MODERN_PORTRAIT).cover.layout).toBe("m-p-cover-strips");
  });

  it("style.font = the style's caption face (classic Playfair/Cairo unchanged, modern Cormorant/Amiri)", () => {
    const p1 = plan([[{ layoutId: "m-p-full", photoIds: [a(1)] }]]);
    expect(okDoc(p1, MODERN_PORTRAIT).style.font).toBe("Cormorant");
    expect(okDoc(p1, MODERN_PORTRAIT, { book: storyBook({ captionLang: "ar" }) }).style.font).toBe("Amiri");
    const p2 = plan([[{ layoutId: "full-page", photoIds: [a(1)] }]]);
    expect(okDoc(p2, CLASSIC_PORTRAIT).style.font).toBe("Playfair");
    expect(okDoc(p2, CLASSIC_PORTRAIT, { book: storyBook({ captionLang: "ar" }) }).style.font).toBe("Cairo");
  });
});

describe("prunePlan with a design", () => {
  it("a spread that lost photos becomes a spread of that count, else page layouts of the design (nothing lost)", () => {
    const p = plan([[{ layoutId: "m-p-spread-grid", photoIds: range(1, 12) }]]);
    const gone = new Set([aliasToId.get(a(12))]);
    const ps = photos.map((x) => (gone.has(x.id) ? { ...x, keep: false } : x));
    const r = prunePlan(p, { aliasToId, photos: ps, design: MODERN_PORTRAIT });
    expect(r.removed).toBe(1);
    // No 11-photo layout: chunked into modern portrait pages (6 + 5).
    expect(r.plan.moments[0].pages.map((x) => [x.layoutId, x.photoIds.length])).toEqual([
      ["m-p-six-grid", 6],
      ["m-p-five-mosaic", 5],
    ]);
    const doc = okDoc(r.plan, MODERN_PORTRAIT, { photos: ps });
    expect(doc.pages.flatMap((x) => x.slots)).toHaveLength(11);

    const mosaic = plan([[{ layoutId: "m-l-spread-mosaic", photoIds: [a(3), a(6), a(9), a(12), a(15), a(18)] }]]);
    const ps2 = photos.map((x) => (x.id === aliasToId.get(a(18)) ? { ...x, keep: false } : x));
    const r2 = prunePlan(mosaic, { aliasToId, photos: ps2, design: MODERN_LANDSCAPE });
    for (const pg of r2.plan.moments[0].pages) expect(getLayout(pg.layoutId)).toMatchObject({ format: "A5_LANDSCAPE", style: "modern", role: "page" });
  });

  it("re-fitted pages stay inside the design (A10 note: bestPageLayout gets the design)", () => {
    const p = plan([[{ layoutId: "m-l-three", photoIds: [a(3), a(6), a(9)] }]]);
    const ps = photos.map((x) => (x.id === aliasToId.get(a(9)) ? { ...x, keep: false } : x));
    const r = prunePlan(p, { aliasToId, photos: ps, design: MODERN_LANDSCAPE });
    expect(getLayout(r.plan.moments[0].pages[0].layoutId)).toMatchObject({ format: "A5_LANDSCAPE", style: "modern", photoCount: 2 });
  });
});

// ------------------------------------------------------------------------------------------ captions

describe("captions with spreads", () => {
  const p = plan([
    [
      { layoutId: "m-p-one-band", photoIds: [a(3)] },
      { layoutId: "m-p-full", photoIds: [a(1)] },
      { layoutId: "m-p-spread-mosaic", photoIds: [a(2), a(4), a(5), a(6), a(7), a(9), a(12)] },
      { layoutId: "m-p-spread-grid", photoIds: [...range(13, 23), a(8)] },
      { layoutId: "m-p-two-panel", photoIds: [a(10), a(11)] },
    ],
  ]);
  const doc = okDoc(p, MODERN_PORTRAIT);

  it("page indices count both halves; the left half of a captioned spread is captionable, the right half never", () => {
    expect(doc.pages.map((x) => `${x.layout}${x.side ? `:${x.side}` : ""}`)).toEqual([
      "m-p-one-band",
      "m-p-full",
      "m-p-spread-mosaic:left",
      "m-p-spread-mosaic:right",
      "m-p-spread-grid:left",
      "m-p-spread-grid:right",
      "m-p-two-panel",
    ]);
    const spec = captionBatches(doc, { lang: "en", maxBatches: 5 });
    const keys = spec.flatMap((s) => s.keys);
    expect(keys).toEqual(["m1:0", "m1:2", "m1:6"]); // band, mosaic left, two-panel (grid has no caption area)
    expect(pageCaptionKeys(doc)).toEqual(["m1:0", "m1:1", "m1:2", "m1:3", "m1:4", "m1:5", "m1:6"]);
    expect(countCaptionablePages(doc)).toBe(3);
    // The plan view agrees with the doc view (a spread entry expands into two keys).
    expect(captionBatches(p, { lang: "en", maxBatches: 5 }).flatMap((s) => s.keys)).toEqual(keys);
    expect(countCaptionablePages(p)).toBe(3);
    expect(hasCaptionArea("m-p-spread-mosaic", "left")).toBe(true);
    expect(hasCaptionArea("m-p-spread-mosaic", "right")).toBe(false);
    expect(hasCaptionArea("m-p-spread-mosaic")).toBe(false);
    expect(isCaptionable(doc.pages[2])).toBe(true);
    expect(isCaptionable(doc.pages[3])).toBe(false);
  });

  it("applyCaptions writes the spread caption on the left page in the style's caption face; right halves stay null", () => {
    const results = new Map([
      ["m1:0", "Morning light"],
      ["m1:2", "All of us together"],
      ["m1:3", "SHOULD NOT LAND"],
      ["m1:6", "Two smiles"],
    ]);
    const out = applyCaptions(doc, results, new Map(), { lang: "en" });
    expect(out.pages.map((x) => x.caption?.text ?? null)).toEqual(["Morning light", null, "All of us together", null, null, null, "Two smiles"]);
    expect(out.pages.flatMap((x) => (x.caption ? [x.caption.font] : []))).toEqual(["Cormorant", "Cormorant", "Cormorant"]);
    const ar = applyCaptions(doc, new Map([["m1:2", "معاً"]]), new Map(), { lang: "ar" });
    expect(ar.pages[2].caption).toMatchObject({ text: "معاً", font: "Amiri", source: "ai" });
  });

  it("classic books keep writing Playfair / Cairo captions", () => {
    const c = okDoc(plan([[{ layoutId: "one-portrait", photoIds: [a(1)] }]]), CLASSIC_PORTRAIT);
    expect(applyCaptions(c, new Map([["m1:0", "Hello"]]), new Map(), { lang: "en" }).pages[0].caption?.font).toBe("Playfair");
    expect(applyCaptions(c, new Map([["m1:0", "مرحبا"]]), new Map(), { lang: "ar" }).pages[0].caption?.font).toBe("Cairo");
  });
});

// ------------------------------------------------------------------------------------------ replay

describe("replay Storyteller per design", () => {
  const many = photoSet(60, 2);
  const maps = aliasMaps(many);
  const meta = (design: BookDesign, maxPages = 20) => ({
    photos: many.map((p, i) => ({
      alias: maps.aliasOf.get(p.id) as string,
      ms: Date.parse(p.takenAt as string) + Math.floor(i / 20) * 86_400_000,
      orientation: p.width > p.height ? ("landscape" as const) : ("portrait" as const),
      quality: 5 + (i % 5),
      cover: i % 7 === 0,
      place: null,
    })),
    maxPages,
    userTitle: null,
    captionLang: "en" as const,
    occasion: "travel" as const,
    design,
  });

  for (const design of ALL) {
    it(`${design.format}/${design.designStyle}: synthesised plan → valid, aligned doc using only that design`, () => {
      const p = synthAlbumPlan(meta(design));
      const r = planToDoc(p as AlbumPlan, { aliasToId: maps.aliasToId, photos: many, book: storyBook({ maxPages: 20 }), runId: RUN_ID, generatorVersion: 5, design });
      if (!("doc" in r)) throw new Error(r.issues.join("; "));
      expect(isSpreadAligned(r.doc)).toBe(true);
      for (const id of [r.doc.cover.layout, ...r.doc.pages.map((x) => x.layout)]) {
        expect(getLayout(id)).toMatchObject({ format: design.format, style: design.designStyle });
      }
      // The replay plan places spreads only where they land on a left page → no repair needed.
      const entries = p.moments.flatMap((m) => m.pages);
      expect(r.doc.pages.filter((x) => x.side !== "right")).toHaveLength(entries.length);
      if (design.designStyle === "modern") expect(r.doc.pages.some((x) => x.side === "left")).toBe(true);
    });
  }

  it("classic portrait replay plan is unchanged by the design hint", () => {
    const withHint = synthAlbumPlan(meta(CLASSIC_PORTRAIT));
    const noHint: Partial<ReturnType<typeof meta>> = meta(CLASSIC_PORTRAIT);
    delete noHint.design;
    expect(withHint).toEqual(synthAlbumPlan(noHint as ReturnType<typeof meta>));
  });

  it("over the page cap the replay plan drops spreads rather than exceeding maxPages", () => {
    for (const max of [4, 6, 9]) {
      const p = synthAlbumPlan(meta(MODERN_PORTRAIT, max));
      expect(planPageCount(p as AlbumPlan)).toBeLessThanOrEqual(max);
    }
  });
});
