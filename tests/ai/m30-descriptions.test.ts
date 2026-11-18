// M30 T10 — AI builds for magazine / editorial: Storyteller catalogue + style rules, the plan
// fitter's description modes, and AI chapter descriptions (Caption Writer variant, pre-check,
// Critic variant, repair targeting, doc writer). Replay / hand-written answers only — no live call.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  buildCaptionUserMessage,
  buildCaptionWriterRequest,
  CAPTION_WRITER_DESCRIPTIONS_MAX_TOKENS,
  captionWriterMaxTokens,
  DESCRIPTION_OUTPUT_TOKENS,
  precheckBatch,
  writeCaptions,
  type WriteCaptionsArgs,
} from "@/lib/ai/agents/caption-writer";
import {
  captionWriterReplaySynth,
  PLANTED_DESCRIPTION_TEXT,
  replayCaption,
  replayDescription,
} from "@/lib/ai/agents/caption-writer-replay";
import { buildCriticRequest, buildCriticUserMessage } from "@/lib/ai/agents/critic";
import { buildStorytellerRequest } from "@/lib/ai/agents/storyteller";
import { synthAlbumPlan } from "@/lib/ai/agents/storyteller-replay";
import { buildCaptionContext, checkBookDescriptions, checkDescription } from "@/lib/ai/caption-check";
import { applyCaptions, captionBatches, chaptersWantingDescription, type CaptionBatchSpec } from "@/lib/ai/captions";
import { fitPlanToDesign, planToDoc, prunePlan } from "@/lib/ai/plan-to-doc";
import {
  CAPTION_WRITER_DESCRIPTIONS_SYSTEM_PROMPT,
  CAPTION_WRITER_SYSTEM_PROMPT,
  captionWriterSystemFor,
} from "@/lib/ai/prompts/caption-writer";
import { criticDescriptionsSystemText, criticSystemFor, criticSystemText, DESCRIPTION_DETAIL_PREFIX } from "@/lib/ai/prompts/critic";
import { layoutCatalogue, storytellerSystemText } from "@/lib/ai/prompts/storyteller";
import { descriptionPageIndexes, planRepair } from "@/lib/ai/repair";
import type { AgentStepRecord, RunTotalsDelta, StepLogger } from "@/lib/ai/run-step";
import {
  albumPlanAiSchemaFor,
  AlbumPlanAiSchema,
  AlbumPlanStrictSchema,
  CaptionBatchAiSchema,
  CaptionBatchWithDescriptionsAiSchema,
  captionBatchAiSchemaFor,
  captionKey,
  captionLogOutput,
  CritiqueAiSchema,
  MAX_CHAPTER_DESCRIPTION_WORDS,
  wordCount,
  type AlbumPlan,
  type Critique,
} from "@/lib/ai/schemas";
import type { StoryPhoto } from "@/lib/ai/story";
import { ReplayTransport, type ReplaySynth } from "@/lib/ai/transport-replay";
import type { BookDesign } from "@/lib/book/book-design";
import { serializeDoc } from "@/lib/book/doc-version";
import { hasUserDescriptions, isAiReplaceableDoc } from "@/lib/book/replaceable";
import { CHAPTER_DESCRIPTION_MAX, parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import { autoCoversFor, layoutsFor } from "@/lib/book/spreads";
import type { BookDoc } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";
import { layoutIdShowsDescription, layoutShowsDescription, writesDescriptions } from "@/lib/layouts/description";
import { bestPageLayout } from "@/lib/layouts/fit";
import "@/lib/ai/agents/replay-synths";
import { aliasMaps, RUN_ID, storyBook } from "../helpers/story-fixtures";

const NEW_STYLES = ["magazine", "editorial"] as const;
const OLD_STYLES = ["classic", "modern", "geometric", "scrapbook"] as const;
const FORMATS = ["A5_PORTRAIT", "A5_LANDSCAPE"] as const;
const NEW_DESIGNS: BookDesign[] = NEW_STYLES.flatMap((designStyle) => FORMATS.map((format) => ({ format, designStyle })));
const nameOf = (d: BookDesign) => `${d.designStyle}/${d.format}`;
const ARABIC = /[؀-ۿ]/;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** `n` kept photos over `days` days; every third one landscape. */
function photoSet(n: number, days = 2, over: Partial<StoryPhoto> = {}): StoryPhoto[] {
  return Array.from({ length: n }, (_, i) => {
    const landscape = i % 3 === 0;
    const day = Math.floor((i * days) / n);
    return {
      id: uuid(i + 1),
      width: landscape ? 1600 : 1200,
      height: landscape ? 1200 : 1600,
      takenAt: new Date(Date.parse("2026-10-12T09:00:00+04:00") + day * 86_400_000 + i * 600_000).toISOString(),
      place: null,
      keep: true,
      analysis: { description: `Friends walking along a quiet street, frame ${i + 1}`, scene: "group", mood: "joyful", quality: 7, coverWorthy: i === 0 },
      ...over,
    };
  });
}

function synthPlan(design: BookDesign, photos: StoryPhoto[], lang: "en" | "ar" = "en"): AlbumPlan {
  const { aliasOf } = aliasMaps(photos);
  const raw = synthAlbumPlan({
    photos: photos.map((p) => ({
      alias: aliasOf.get(p.id) as string,
      ms: p.takenAt ? Date.parse(p.takenAt) : null,
      orientation: p.width > p.height ? "landscape" : p.width < p.height ? "portrait" : "square",
      quality: p.analysis?.quality ?? 5,
      cover: p.analysis?.coverWorthy ?? false,
      place: p.place,
    })),
    maxPages: 20,
    userTitle: null,
    captionLang: lang,
    occasion: "travel",
    design,
  });
  return AlbumPlanStrictSchema.parse(albumPlanAiSchemaFor(design.designStyle).parse(raw));
}

function docOf(design: BookDesign, photos: StoryPhoto[], plan: AlbumPlan = synthPlan(design, photos), lang: "en" | "ar" = "en"): BookDoc {
  const { aliasToId } = aliasMaps(photos);
  const r = planToDoc(plan, { aliasToId, photos, book: storyBook({ captionLang: lang, occasion: "travel", tone: "fun" }), runId: RUN_ID, generatorVersion: 6, design });
  if (!("doc" in r)) throw new Error(r.issues.join("; "));
  return r.doc;
}

/** Pages (a spread once) of each chapter that show the chapter description. */
function descriptionPagesPerChapter(doc: BookDoc): Map<string, number> {
  const out = new Map<string, number>(doc.chapters.map((c) => [c.id, 0]));
  for (const p of doc.pages) {
    if (p.side === "right" || !p.chapterId || !layoutIdShowsDescription(p.layout)) continue;
    out.set(p.chapterId, (out.get(p.chapterId) ?? 0) + 1);
  }
  return out;
}

class MemoryLogger implements StepLogger {
  rows: AgentStepRecord[] = [];
  async insertStep(row: AgentStepRecord) {
    this.rows.push(row);
  }
  totals: RunTotalsDelta[] = [];
  async addRunTotals(runId: string, delta: RunTotalsDelta) {
    if (runId) this.totals.push(delta);
  }
}

const MAGAZINE: BookDesign = { format: "A5_PORTRAIT", designStyle: "magazine" };

// ------------------------------------------------------------------------------------------------

describe("writesDescriptions — derived from the layout data", () => {
  it("true for magazine + editorial, false for the older styles and junk", () => {
    for (const s of NEW_STYLES) expect(writesDescriptions(s)).toBe(true);
    for (const s of OLD_STYLES) expect(writesDescriptions(s)).toBe(false);
    expect(writesDescriptions(null)).toBe(false);
    expect(writesDescriptions("nope")).toBe(false);
  });
});

describe("Storyteller — magazine / editorial prompts", () => {
  it.each(NEW_DESIGNS.map((d) => [nameOf(d), d] as const))("%s: catalogue lists every page / spread layout and the auto cover only", (_n, design) => {
    const text = storytellerSystemText(design);
    const pages = layoutsFor(design.format, design.designStyle, "page");
    const spreads = layoutsFor(design.format, design.designStyle, "spread");
    expect(pages.length).toBeGreaterThanOrEqual(10);
    expect(spreads.length).toBeGreaterThanOrEqual(2);
    for (const l of [...pages, ...spreads]) {
      const line = text.split("\n").find((x) => x.startsWith(`- ${l.id} · `));
      expect(line, l.id).toBeDefined();
      expect(line).toContain(`${l.photoCount} photo`);
      // The text areas name the description panel exactly on the description layouts.
      expect(line!.includes("chapter description")).toBe(layoutShowsDescription(l));
      expect(line).toMatch(/ · caption (yes|no)/);
    }
    for (const l of spreads) expect(text).toContain(`- ${l.id} · "${l.name}"`);
    expect(text).toContain("occupies 2 pages, must start on a left page");
    const autoCovers = autoCoversFor(design.format, design.designStyle).map((l) => l.id);
    expect(autoCovers.length).toBeGreaterThan(0);
    for (const id of autoCovers) expect(text).toContain(`- ${id} · `);
    // User-only cover styles (autoPick: false) are never offered to the AI.
    const userCovers = layoutsFor(design.format, design.designStyle, "cover").map((l) => l.id).filter((id) => !autoCovers.includes(id));
    expect(userCovers.length).toBeGreaterThan(0);
    for (const id of userCovers) expect(text).not.toContain(`- ${id} · `);
    // No layout of another design, no background section (these styles take none).
    expect(text).not.toContain("BACKGROUNDS");
    expect(text).not.toContain("- full-page · ");
    expect(layoutCatalogue(design)).not.toContain("coverLine");
  });

  it("one short style-rule paragraph per style, inside rule 6", () => {
    for (const format of FORMATS) {
      const mg = storytellerSystemText({ format, designStyle: "magazine" });
      const ed = storytellerSystemText({ format, designStyle: "editorial" });
      const rule6 = (t: string) => t.split("\n").find((l) => l.startsWith("6. ")) as string;
      expect(rule6(mg)).toContain("Magazine layouts look like a travel magazine");
      expect(rule6(mg)).toContain("mix hero pages");
      expect(rule6(mg)).toContain("Keep a spread for the strongest panorama");
      expect(rule6(ed)).toContain("Editorial layouts are minimal");
      expect(rule6(ed)).toContain("generous empty space");
      expect(rule6(ed)).toContain("Diagonal layouts are accents");
      for (const t of [mg, ed]) {
        expect(rule6(t)).toContain("Open every moment with one such layout");
        expect(rule6(t)).toContain("exactly one chapter-description layout per moment");
        expect(t).toContain("13. Captions are written later by another agent; do not write captions.");
        expect(t).not.toContain("14. Backgrounds");
      }
      expect(rule6(mg)).not.toContain("Editorial layouts");
      expect(rule6(ed)).not.toContain("Magazine layouts");
    }
  });

  it("stable per design (one cache prefix each) and different from every other design", () => {
    const texts = NEW_DESIGNS.map((d) => storytellerSystemText(d));
    expect(new Set(texts).size).toBe(4);
    NEW_DESIGNS.forEach((d, i) => expect(storytellerSystemText(d)).toBe(texts[i]));
  });

  it("request: the design's prefix, the classic plan schema (no background fields), no colours in the photo lines", () => {
    const photos = photoSet(6, 1, { color: "#5B8DB8" });
    const { aliasOf } = aliasMaps(photos);
    for (const design of NEW_DESIGNS) {
      const req = buildStorytellerRequest({ photos, book: storyBook(), aliasOf, design });
      expect(req.system).toHaveLength(1);
      expect(req.system[0].text).toBe(storytellerSystemText(design));
      expect(req.system[0].cache_control).toEqual({ type: "ephemeral" });
      expect(req.schema).toBe(AlbumPlanAiSchema);
      expect(albumPlanAiSchemaFor(design.designStyle)).toBe(AlbumPlanAiSchema);
      expect(req.effort).toBe("medium");
      expect(JSON.stringify(req.messages)).not.toContain("colour #");
    }
  });
});

describe("plan → doc fitter — one description page per chapter", () => {
  it.each(NEW_DESIGNS.map((d) => [nameOf(d), d] as const))("%s: a classic plan is re-fitted: first page of each moment shows the description, no other page does", (_n, design) => {
    const photos = photoSet(10, 2);
    const { aliasToId } = aliasMaps(photos);
    const plan: AlbumPlan = {
      title: "Our days",
      subtitle: "",
      coverPhotoId: "p1",
      moments: [
        { id: "m1", title: "Part one", dateLabel: "", place: null, pages: [{ layoutId: "full-page", photoIds: ["p1"] }, { layoutId: "full-page", photoIds: ["p2"] }, { layoutId: "two-vertical", photoIds: ["p3", "p5"] }] },
        { id: "m2", title: "Part two", dateLabel: "", place: null, pages: [{ layoutId: "two-vertical", photoIds: ["p6", "p8"] }, { layoutId: "full-page", photoIds: ["p7"] }, { layoutId: "full-page", photoIds: ["p9"] }] },
      ],
    };
    const fitted = fitPlanToDesign(plan, { aliasToId, photos, design });
    for (const m of fitted.moments) {
      expect(m.pages.map((pg) => getLayout(pg.layoutId)?.style)).toEqual(m.pages.map(() => design.designStyle));
      expect(m.pages.map((pg) => layoutIdShowsDescription(pg.layoutId))).toEqual([true, false, false]);
    }
    const doc = docOf(design, photos, plan);
    expect([...descriptionPagesPerChapter(doc).values()]).toEqual([1, 1]);
  });

  it("keeps the Storyteller's own description page; a second one in the same moment is re-fitted without the panel", () => {
    const photos = photoSet(6, 1);
    const { aliasToId } = aliasMaps(photos);
    const plan: AlbumPlan = {
      title: "Our days",
      subtitle: "",
      coverPhotoId: "p1",
      moments: [
        {
          id: "m1",
          title: "Part one",
          dateLabel: "",
          place: null,
          pages: [
            { layoutId: "mg-p-full", photoIds: ["p2"] },
            { layoutId: "mg-p-one-headline", photoIds: ["p3"] },
            { layoutId: "mg-p-two-panel", photoIds: ["p5", "p6"] },
            { layoutId: "full-page", photoIds: ["p1"] },
          ],
        },
      ],
    };
    const fitted = fitPlanToDesign(plan, { aliasToId, photos, design: MAGAZINE });
    const ids = fitted.moments[0].pages.map((pg) => pg.layoutId);
    expect(ids[0]).toBe("mg-p-full"); // untouched (in design, no panel)
    expect(ids[1]).toBe("mg-p-one-headline"); // the AI's description page stays
    expect(ids[2]).toBe("mg-p-two-circle"); // second panel → the 2-photo layout without one
    expect(layoutIdShowsDescription(ids[3])).toBe(false); // foreign page: the moment already has one
    expect(fitted.moments[0].pages.map((pg) => pg.photoIds)).toEqual(plan.moments[0].pages.map((pg) => pg.photoIds));
    // Nothing to change → the same object.
    expect(fitPlanToDesign(fitted, { aliasToId, photos, design: MAGAZINE })).toBe(fitted);
  });

  it("the older styles are fitted exactly as before (no description mode)", () => {
    const photos = photoSet(6, 1);
    const { aliasToId } = aliasMaps(photos);
    const plan: AlbumPlan = {
      title: "Our days",
      subtitle: "",
      coverPhotoId: "p1",
      moments: [{ id: "m1", title: "Part one", dateLabel: "", place: null, pages: [{ layoutId: "mg-p-one-headline", photoIds: ["p2"] }, { layoutId: "mg-p-two-panel", photoIds: ["p3", "p5"] }] }],
    };
    const fitted = fitPlanToDesign(plan, { aliasToId, photos, design: { format: "A5_PORTRAIT", designStyle: "classic" } });
    const classic: BookDesign = { format: "A5_PORTRAIT", designStyle: "classic" };
    expect(fitted.moments[0].pages.map((pg) => pg.layoutId)).toEqual([
      bestPageLayout(["portrait"], { design: classic }),
      bestPageLayout(["portrait", "portrait"], { design: classic }),
    ]);
    expect(fitted.moments[0].pages.map((pg) => pg.layoutId)).toEqual(["full-page", "two-vertical"]);
  });

  it("prunePlan: a description page that loses a photo keeps showing the description", () => {
    const photos = photoSet(8, 1);
    const { aliasToId } = aliasMaps(photos);
    const plan: AlbumPlan = {
      title: "Our days",
      subtitle: "",
      coverPhotoId: "p1",
      moments: [
        {
          id: "m1",
          title: "Part one",
          dateLabel: "",
          place: null,
          pages: [
            { layoutId: "mg-p-two-panel", photoIds: ["p2", "p3"] },
            { layoutId: "mg-p-two-circle", photoIds: ["p4", "p5"] },
            { layoutId: "mg-p-full", photoIds: ["p6"] },
          ],
        },
      ],
    };
    const dropped = (n: number) => photos.map((p, i) => (i === n - 1 ? { ...p, keep: false } : p));
    // p3 leaves the description page → still a description layout (1 photo).
    const a = prunePlan(plan, { aliasToId, photos: dropped(3), design: MAGAZINE }).plan.moments[0].pages;
    expect(a.map((pg) => layoutIdShowsDescription(pg.layoutId))).toEqual([true, false, false]);
    expect(a[0].photoIds).toEqual(["p2"]);
    // p5 leaves a plain page → it stays plain (the moment already has its description page).
    const b = prunePlan(plan, { aliasToId, photos: dropped(5), design: MAGAZINE }).plan.moments[0].pages;
    expect(b.map((pg) => layoutIdShowsDescription(pg.layoutId))).toEqual([true, false, false]);
    expect(b[1].photoIds).toEqual(["p4"]);
  });

  it.each(NEW_DESIGNS.map((d) => [nameOf(d), d] as const))("%s: the replay plan opens every moment with exactly one description page / spread and builds a valid doc", (_n, design) => {
    for (const [n, days] of [[5, 1], [14, 2], [36, 3], [60, 3]] as const) {
      const photos = photoSet(n, days);
      const doc = docOf(design, photos);
      const kept = new Set(photos.map((p) => p.id));
      expect(validateBookDoc(doc, { photoIds: kept, maxPages: 20 })).toEqual([]);
      for (const p of doc.pages) expect(getLayout(p.layout)).toMatchObject({ format: design.format, style: design.designStyle });
      const counts = descriptionPagesPerChapter(doc);
      expect([...counts.values()], `${n} photos`).toEqual(doc.chapters.map(() => 1));
      for (const ch of doc.chapters) {
        const first = doc.pages.find((p) => p.chapterId === ch.id);
        expect(layoutIdShowsDescription(first?.layout)).toBe(true);
      }
    }
  });

  it("the older styles' replay plans never use a description layout", () => {
    for (const designStyle of OLD_STYLES) {
      const doc = docOf({ format: "A5_PORTRAIT", designStyle }, photoSet(30, 3));
      expect(doc.pages.some((p) => layoutIdShowsDescription(p.layout))).toBe(false);
    }
  });
});

// ------------------------------------------------------------------------------------------------

const words = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? "Slow" : "light")).join(" ");
const EN_CTX = buildCaptionContext({ lang: "en", dates: ["2026-10-12T10:00:00+04:00"] });
const AR_CTX = buildCaptionContext({ lang: "ar", dates: ["2026-10-12T10:00:00+04:00"] });

describe("description pre-check (caption-check.ts)", () => {
  it("word limit 45: 45 words pass, 46 → too_long; the caption limit (18) does not apply", () => {
    expect(MAX_CHAPTER_DESCRIPTION_WORDS).toBe(45);
    expect(checkDescription(words(45), EN_CTX)).toEqual([]);
    expect(checkDescription(words(19), EN_CTX)).toEqual([]);
    expect(checkDescription(words(46), EN_CTX).map((i) => i.code)).toEqual(["too_long"]);
  });

  it("over the doc's 400-unit cap → too_long (never clipped silently)", () => {
    const long = Array.from({ length: 40 }, () => "extraordinarily").join(" "); // 40 words, 639 units
    expect(wordCount(long)).toBeLessThanOrEqual(45);
    expect(long.length).toBeGreaterThan(CHAPTER_DESCRIPTION_MAX);
    expect(checkDescription(`A ${long}`, EN_CTX).map((i) => i.code)).toEqual(["too_long"]);
  });

  it("invented name or place → unknown_name (English); allowed when it is in the metadata", () => {
    const text = "We spent the afternoon by the water. Later everyone walked with Ahmed through the old streets of Lisbon until the lamps came on and the day ended.";
    expect(checkDescription(text, EN_CTX).map((i) => i.code)).toEqual(["unknown_name"]);
    const ctx = buildCaptionContext({ lang: "en", photoPlaces: ["Lisbon"], knownNames: ["Ahmed"] });
    expect(checkDescription(text, ctx)).toEqual([]);
  });

  it("invented number → unknown_number; a number from the photo dates passes", () => {
    expect(checkDescription("We counted 40 lanterns over the square that night.", EN_CTX).map((i) => i.code)).toEqual(["unknown_number"]);
    expect(checkDescription("By the 12 of the month the whole street was full of light.", EN_CTX)).toEqual([]);
  });

  it("language / script: native Arabic passes; Latin words in Arabic, English in an Arabic book and Arabic in English are flagged", () => {
    for (let i = 1; i <= 12; i++) {
      const ar = replayDescription(`m${i}`, "ar");
      expect(ARABIC.test(ar)).toBe(true);
      expect(/[A-Za-z]/.test(ar)).toBe(false);
      expect(checkDescription(ar, AR_CTX), `m${i}`).toEqual([]);
    }
    expect(checkDescription("قضينا العصر كله في Paris وكان يومًا جميلًا لا يُنسى أبدًا.", AR_CTX).map((i) => i.code)).toEqual(["latin_word"]);
    expect(checkDescription(replayDescription("m1", "en"), AR_CTX).map((i) => i.code)).toContain("not_arabic");
    expect(checkDescription(replayDescription("m1", "ar"), EN_CTX).map((i) => i.code)).toContain("arabic_in_english");
  });

  it("quotes, attribution, links, hashtags and empty text are flagged like captions", () => {
    expect(checkDescription("", EN_CTX).map((i) => i.code)).toEqual(["empty"]);
    expect(checkDescription("“A day by the sea is never wasted, and this one proved it twice over.”", EN_CTX).map((i) => i.code)).toContain("wrapped_in_quotes");
    expect(checkDescription("The sea was calm all day, as they say, and so were we.", EN_CTX).map((i) => i.code)).toContain("attribution");
    expect(checkDescription("More of this day at www.example.com for everyone who asked.", EN_CTX).map((i) => i.code)).toContain("url");
    expect(checkDescription("A slow day by the water #blessed and nothing else to add.", EN_CTX).map((i) => i.code)).toContain("hashtag");
  });

  it("duplicates: another description, a caption of ≥ 4 words verbatim, the chapter title of ≥ 3 words verbatim", () => {
    const a = replayDescription("m1", "en");
    const b = replayDescription("m2", "en");
    const key = (m: string) => captionKey(m, "desc");
    expect(checkBookDescriptions([{ key: key("m1"), text: a }, { key: key("m2"), text: b }], EN_CTX)).toEqual(new Map());
    // Equal to an earlier / another description (case and punctuation ignored).
    expect([...checkBookDescriptions([{ key: key("m1"), text: a }, { key: key("m2"), text: a.toUpperCase() }], buildCaptionContext({ lang: "en" })).keys()]).toEqual([key("m2")]);
    expect(checkBookDescriptions([{ key: key("m2"), text: a }], EN_CTX, { otherDescriptions: [`${a}!`] }).get(key("m2"))?.map((i) => i.code)).toEqual(["duplicate"]);
    // Repeats a caption verbatim (short captions of < 4 words are ordinary phrases, not flagged).
    const withCaption = `${a.split(". ")[0]}. Soft light and softer smiles all around.`;
    expect(checkBookDescriptions([{ key: key("m1"), text: withCaption }], EN_CTX, { captions: ["Soft light and softer smiles"] }).get(key("m1"))?.map((i) => i.code)).toEqual(["duplicate"]);
    expect(checkBookDescriptions([{ key: key("m1"), text: withCaption }], EN_CTX, { captions: ["Soft light", "softer smiles everywhere tonight"] })).toEqual(new Map());
    // Repeats its own chapter title / heading verbatim (≥ 3 words).
    const withTitle = "Dinner by the water was the plan from the start. Nobody hurried, and the evening stretched on.";
    expect(checkBookDescriptions([{ key: key("m1"), text: withTitle, titles: ["Dinner by the water"] }], EN_CTX).get(key("m1"))?.map((i) => i.code)).toEqual(["duplicate"]);
    expect(checkBookDescriptions([{ key: key("m1"), text: withTitle, titles: ["By the", null, undefined] }], EN_CTX)).toEqual(new Map());
  });

  it("issues carry codes and the key only — never text", () => {
    const out = checkBookDescriptions([{ key: "m1:desc", text: words(60) }], EN_CTX);
    expect(JSON.stringify([...out])).toBe('[["m1:desc",[{"code":"too_long","key":"m1:desc"}]]]');
  });
});

describe("replay descriptions (caption-writer-replay.ts)", () => {
  it("25–45 words, 2 sentences, unique per moment, clean against every replay caption — English and Arabic", () => {
    for (const lang of ["en", "ar"] as const) {
      const ctx = lang === "en" ? EN_CTX : AR_CTX;
      const captions = Array.from({ length: 44 }, (_, ordinal) =>
        replayCaption({ key: "m1:0", pageIndex: 0, ordinal, scene: "group", mood: "joyful", place: null }, lang, false),
      );
      const all = Array.from({ length: 70 }, (_, i) => ({ key: captionKey(`m${i + 1}`, "desc"), text: replayDescription(`m${i + 1}`, lang) }));
      expect(new Set(all.map((d) => d.text)).size).toBe(70);
      for (const d of all) {
        expect(wordCount(d.text)).toBeGreaterThanOrEqual(25);
        expect(wordCount(d.text)).toBeLessThanOrEqual(45);
        expect(d.text.length).toBeLessThanOrEqual(CHAPTER_DESCRIPTION_MAX);
      }
      expect(checkBookDescriptions(all, ctx, { captions })).toEqual(new Map());
      // A repaired text differs from every first-attempt text.
      const repaired = Array.from({ length: 12 }, (_, i) => replayDescription(`m${i + 1}`, lang, true));
      for (const r of repaired) {
        expect(all.some((d) => d.text === r)).toBe(false);
        expect(checkDescription(r, ctx)).toEqual([]);
      }
    }
  });

  it("the planted description is over 45 words and names an invented place", () => {
    expect(wordCount(PLANTED_DESCRIPTION_TEXT.en)).toBeGreaterThan(45);
    expect(checkDescription(PLANTED_DESCRIPTION_TEXT.en, EN_CTX).map((i) => i.code).sort()).toEqual(["too_long", "unknown_name"]);
    expect(wordCount(PLANTED_DESCRIPTION_TEXT.ar)).toBeGreaterThan(45);
    expect(checkDescription(PLANTED_DESCRIPTION_TEXT.ar, AR_CTX).map((i) => i.code).sort()).toEqual(["latin_word", "too_long"]);
  });
});

// ------------------------------------------------------------------------------------------------

function fixture(design: BookDesign = MAGAZINE, lang: "en" | "ar" = "en", n = 14) {
  const photos = photoSet(n, 2);
  const doc = docOf(design, photos, synthPlan(design, photos, lang), lang);
  const photosById = new Map(photos.map((p) => [p.id, p]));
  const { aliasOf } = aliasMaps(photos);
  const specs = captionBatches(doc, { lang, descriptions: true });
  return { photos, doc, photosById, aliasOf, specs };
}

describe("captionBatches — descriptions ride on the heading's batch", () => {
  it("same batches, keys and call count with or without descriptions; wantDescription only where a page shows it", () => {
    for (const design of NEW_DESIGNS) {
      const photos = photoSet(60, 3);
      const doc = docOf(design, photos);
      const base = captionBatches(doc, { lang: "en" });
      const withDesc = captionBatches(doc, { lang: "en", descriptions: true });
      expect(withDesc.length).toBe(base.length);
      expect(withDesc.map((b) => b.keys)).toEqual(base.map((b) => b.keys));
      expect(withDesc.map((b) => b.moments.map((m) => m.momentId))).toEqual(base.map((b) => b.moments.map((m) => m.momentId)));
      // Without the flag: no description fields at all (the pre-M30 spec shape).
      for (const b of base) for (const m of b.moments) expect("wantDescription" in m || "descriptionPhotoIds" in m).toBe(false);
      // With it: once per moment, in the batch that asks for the heading.
      const asked = withDesc.flatMap((b) => b.moments.filter((m) => m.wantDescription).map((m) => m.momentId));
      expect(asked).toEqual(doc.chapters.map((_, i) => `m${i + 1}`));
      for (const b of withDesc) for (const m of b.moments) {
        if (m.wantDescription) {
          expect(m.wantHeading).toBe(true);
          expect(m.descriptionPhotoIds!.length).toBeGreaterThan(0);
          expect(m.descriptionPhotoIds!.length).toBeLessThanOrEqual(8);
        } else expect(m.descriptionPhotoIds).toBeUndefined();
      }
    }
  });

  it("not asked: a chapter with no description page, a chapter with a user description, a style without descriptions", () => {
    const { doc } = fixture();
    const first = doc.chapters[0].id;
    // The chapter's description page becomes a plain layout.
    const plain: BookDoc = { ...doc, pages: doc.pages.map((p) => (p.chapterId === first && layoutIdShowsDescription(p.layout) ? { ...p, layout: getLayout(p.layout)!.photoCount === 1 ? "mg-p-full" : "mg-p-two-circle" } : p)) };
    expect(captionBatches(plain, { lang: "en", descriptions: true }).flatMap((b) => b.moments.filter((m) => m.wantDescription).map((m) => m.momentId))).toEqual(["m2"]);
    expect([...chaptersWantingDescription(plain)]).toEqual([doc.chapters[1].id]);
    // A user description is never asked again.
    const user: BookDoc = { ...doc, chapters: doc.chapters.map((c, i) => (i === 1 ? { ...c, description: { text: "Typed by me.", source: "user" } } : c)) };
    expect(captionBatches(user, { lang: "en", descriptions: true }).flatMap((b) => b.moments.filter((m) => m.wantDescription).map((m) => m.momentId))).toEqual(["m1"]);
    // Classic book: the flag alone asks nothing (no description layouts).
    const classic = docOf({ format: "A5_PORTRAIT", designStyle: "classic" }, photoSet(14, 2));
    expect(captionBatches(classic, { lang: "en", descriptions: true }).some((b) => b.moments.some((m) => m.wantDescription))).toBe(false);
  });
});

describe("applyCaptions — chapters[i].description", () => {
  const text = replayDescription("m1", "en");
  const text2 = replayDescription("m2", "en");

  it("writes { text, source: 'ai' } for chapters whose page shows it; the doc stays valid and round-trips as v2", () => {
    const { doc, photos } = fixture();
    const out = applyCaptions(doc, new Map(), new Map(), { lang: "en", descriptions: new Map([["m1", text], ["m2", `  ${text2}\n`]]) });
    expect(out.chapters.map((c) => c.description)).toEqual([{ text, source: "ai" }, { text: text2, source: "ai" }]);
    expect(validateBookDoc(out, { photoIds: new Set(photos.map((p) => p.id)), maxPages: 20 })).toEqual([]);
    const back = parseBookDoc(JSON.parse(JSON.stringify(serializeDoc(out))));
    expect(back.ok && back.doc.chapters[0].description).toEqual({ text, source: "ai" });
    expect(doc.chapters.every((c) => c.description === undefined)).toBe(true); // input untouched
  });

  it("never overwrites a user description; replaces an earlier AI one", () => {
    const { doc } = fixture();
    const seeded: BookDoc = {
      ...doc,
      chapters: doc.chapters.map((c, i) => ({ ...c, description: i === 0 ? { text: "My own words about this day.", source: "user" as const } : { text: "An older draft.", source: "ai" as const } })),
    };
    const out = applyCaptions(seeded, new Map(), new Map(), { lang: "en", descriptions: new Map([["m1", text], ["m2", text2]]) });
    expect(out.chapters[0].description).toEqual({ text: "My own words about this day.", source: "user" });
    expect(out.chapters[1].description).toEqual({ text: text2, source: "ai" });
  });

  it("no description for a chapter that no page shows it on; none without the option; a failing text is not written", () => {
    const { doc } = fixture();
    const first = doc.chapters[0].id;
    const plain: BookDoc = { ...doc, pages: doc.pages.map((p) => (p.chapterId === first && layoutIdShowsDescription(p.layout) ? { ...p, layout: getLayout(p.layout)!.photoCount === 1 ? "mg-p-full" : "mg-p-two-circle" } : p)) };
    const out = applyCaptions(plain, new Map(), new Map(), { lang: "en", descriptions: new Map([["m1", text], ["m2", text2]]) });
    expect(out.chapters.map((c) => c.description?.source)).toEqual([undefined, "ai"]);
    expect(applyCaptions(doc, new Map(), new Map(), { lang: "en" }).chapters.every((c) => c.description === undefined)).toBe(true);
    const bad = applyCaptions(doc, new Map(), new Map(), { lang: "en", descriptions: new Map([["m1", words(46)], ["m2", PLANTED_DESCRIPTION_TEXT.en]]) });
    expect(bad.chapters.every((c) => c.description === undefined)).toBe(true);
  });

  it("classic books never get a description (no page shows one)", () => {
    const classic = docOf({ format: "A5_PORTRAIT", designStyle: "classic" }, photoSet(14, 2));
    const out = applyCaptions(classic, new Map(), new Map(), { lang: "en", descriptions: new Map([["m1", text]]) });
    expect(out.chapters.every((c) => c.description === undefined)).toBe(true);
  });
});

describe("user descriptions block an AI rebuild (replaceable.ts)", () => {
  it("a doc with a user description is not AI-replaceable; an AI one is", () => {
    const { doc } = fixture();
    const ai = applyCaptions(doc, new Map(), new Map(), { lang: "en", descriptions: new Map([["m1", replayDescription("m1", "en")]]) });
    expect(hasUserDescriptions(serializeDoc(ai))).toBe(false);
    expect(isAiReplaceableDoc(serializeDoc(ai))).toBe(true);
    const user = { ...ai, chapters: ai.chapters.map((c, i) => (i === 0 ? { ...c, description: { text: "Mine.", source: "user" as const } } : c)) };
    expect(hasUserDescriptions(serializeDoc(user))).toBe(true);
    expect(isAiReplaceableDoc(serializeDoc(user))).toBe(false);
    expect(hasUserDescriptions(null)).toBe(false);
    expect(hasUserDescriptions({ chapters: "x" })).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------

function writerArgs(spec: CaptionBatchSpec, fx: ReturnType<typeof fixture>, over: Partial<WriteCaptionsArgs> = {}): WriteCaptionsArgs {
  return {
    runId: RUN_ID,
    stepKey: `caption_writer:${spec.index}`,
    attempt: 1,
    spec,
    book: { occasion: "travel", tone: "fun", captionLang: spec.lang, title: null },
    photosById: fx.photosById,
    aliasOf: fx.aliasOf,
    descriptions: true,
    transport: new ReplayTransport({ scenario: "ok", fixturesDir: "/nonexistent" }),
    logger: new MemoryLogger(),
    retry: { retries: 0 },
    ...over,
  };
}

describe("Caption Writer — descriptions variant", () => {
  it("variant prompt = base text + DESCRIPTIONS section; its own cached block; rules present", () => {
    expect(CAPTION_WRITER_DESCRIPTIONS_SYSTEM_PROMPT.startsWith(`${CAPTION_WRITER_SYSTEM_PROMPT}\n\nDESCRIPTIONS\n`)).toBe(true);
    const section = CAPTION_WRITER_DESCRIPTIONS_SYSTEM_PROMPT.slice(CAPTION_WRITER_SYSTEM_PROMPT.length);
    for (const phrase of ["25 to 45 words", "2 or 3 sentences", "Never more than 45 words", "original text only", "never invent names, places", "native Arabic in Arabic script", "the tone of the book", "do not repeat the chapter title", "m2:desc", "description null"]) {
      expect(section, phrase).toContain(phrase);
    }
    expect(captionWriterSystemFor(true)).toEqual([{ type: "text", text: CAPTION_WRITER_DESCRIPTIONS_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(captionWriterSystemFor(false).map((b) => b.text)).toEqual([CAPTION_WRITER_SYSTEM_PROMPT]);
  });

  it("variant schema = base + nullable description per moment; the base schema is what other calls send", () => {
    const json = (s: Parameters<typeof zodOutputFormat>[0]) => zodOutputFormat(s).schema as { properties: { moments: { items: { properties: Record<string, unknown>; required: string[] } } } };
    const base = json(CaptionBatchAiSchema).properties.moments.items;
    const variant = json(CaptionBatchWithDescriptionsAiSchema).properties.moments.items;
    expect(Object.keys(variant.properties)).toEqual([...Object.keys(base.properties), "description"]);
    expect(variant.required).toEqual([...base.required, "description"]);
    expect(captionBatchAiSchemaFor(false)).toBe(CaptionBatchAiSchema);
    expect(captionBatchAiSchemaFor(true)).toBe(CaptionBatchWithDescriptionsAiSchema);
  });

  it("max_tokens: raised only when the call writes descriptions (ceiling 10k); the base budget is untouched", () => {
    for (const pages of [1, 4, 12, 40]) {
      expect(captionWriterMaxTokens(pages)).toBe(Math.min(8_000, 3_000 + 250 * pages));
      expect(captionWriterMaxTokens(pages, 0)).toBe(captionWriterMaxTokens(pages));
    }
    expect(captionWriterMaxTokens(12, 3)).toBe(6_000 + 3 * DESCRIPTION_OUTPUT_TOKENS);
    expect(captionWriterMaxTokens(12, 12)).toBe(9_600);
    expect(captionWriterMaxTokens(40, 12)).toBe(CAPTION_WRITER_DESCRIPTIONS_MAX_TOKENS);
  });

  it("request: variant system + schema, effort medium, a desc line per wanted moment; without the flag the pre-M30 request", () => {
    const fx = fixture();
    const spec = fx.specs[0];
    const wanted = spec.moments.filter((m) => m.wantDescription);
    expect(wanted.length).toBeGreaterThan(0);
    const req = buildCaptionWriterRequest(writerArgs(spec, fx));
    expect(req.system[0].text).toBe(CAPTION_WRITER_DESCRIPTIONS_SYSTEM_PROMPT);
    expect(req.schema).toBe(CaptionBatchWithDescriptionsAiSchema);
    expect(req.effort).toBe("medium");
    expect(req.maxTokens).toBe(captionWriterMaxTokens(spec.keys.length, wanted.length));
    expect(req.maxTokens).toBeGreaterThan(captionWriterMaxTokens(spec.keys.length));
    const msg = req.messages[0].content as string;
    for (const m of wanted) {
      const line = msg.split("\n").find((l) => l.startsWith(`- ${m.momentId}:desc · chapter description wanted · photos: `));
      expect(line, m.momentId).toBeDefined();
      // A photo already noted on a page line of this moment is an alias only; others carry a note.
      const noted = new Set(m.pages.flatMap((p) => p.photoIds));
      for (const id of m.descriptionPhotoIds!) {
        const alias = fx.aliasOf.get(id) as string;
        expect(new RegExp(`${alias}(,|$| ")`).test(line!.split("photos: ")[1])).toBe(true);
        if (noted.has(id)) expect(line).not.toContain(`${alias} "`);
        else expect(line).toContain(`${alias} "Friends walking`);
      }
    }
    // Same spec without the flag: base prompt, base schema, base budget, no desc line.
    const base = buildCaptionWriterRequest(writerArgs(spec, fx, { descriptions: false }));
    expect(base.system[0].text).toBe(CAPTION_WRITER_SYSTEM_PROMPT);
    expect(base.schema).toBe(CaptionBatchAiSchema);
    expect(base.maxTokens).toBe(captionWriterMaxTokens(spec.keys.length));
    expect(base.messages[0].content).not.toContain(":desc");
    expect(base.scenarioMeta).not.toHaveProperty("descriptions");
    expect(buildCaptionUserMessage({ spec, book: { occasion: "travel", tone: "fun", captionLang: "en", title: null }, photosById: fx.photosById, aliasOf: fx.aliasOf, memoryBlock: "", repair: null })).toBe(base.messages[0].content);
  });

  it.each(["en", "ar"] as const)("replay (%s): one call per batch returns captions, headings AND descriptions that pass the pre-check", async (lang) => {
    for (const design of NEW_DESIGNS) {
      const fx = fixture(design, lang, 30);
      const logger = new MemoryLogger();
      const transport = new ReplayTransport({ scenario: "ok", fixturesDir: "/nonexistent" });
      const descriptions = new Map<string, string>();
      for (const spec of fx.specs) {
        const r = await writeCaptions(writerArgs(spec, fx, { logger, transport, otherDescriptions: [...descriptions.values()] }));
        expect(r.ok).toBe(true);
        expect([...r.issues.keys()]).toEqual([]);
        expect([...r.captions.keys()]).toEqual(spec.keys);
        expect([...r.descriptions.keys()]).toEqual(spec.moments.filter((m) => m.wantDescription).map((m) => m.momentId));
        for (const [m, t] of r.descriptions) descriptions.set(m, t);
      }
      expect(transport.callCount).toBe(fx.specs.length); // no extra call for descriptions
      expect([...descriptions.keys()]).toEqual(fx.doc.chapters.map((_, i) => `m${i + 1}`));
      for (const t of descriptions.values()) {
        expect(wordCount(t)).toBeLessThanOrEqual(45);
        expect(ARABIC.test(t)).toBe(lang === "ar");
        if (lang === "ar") expect(/[A-Za-z]/.test(t)).toBe(false);
      }
      // Log-safe: counts and codes, never the text.
      const logged = JSON.stringify(logger.rows.map((r) => [r.inputSummary, r.output]));
      for (const t of descriptions.values()) expect(logged).not.toContain(t);
      expect(logger.rows[0].inputSummary).toMatchObject({ descriptionsPromptVersion: 1, descriptions: fx.specs[0].moments.filter((m) => m.wantDescription).length });
      expect(JSON.stringify(logger.rows[0].output)).toContain('"descriptionWords"');
    }
  });

  it("a 46-word description and an invented name are rejected with codes; the ONE repair call fixes them", async () => {
    const fx = fixture();
    const spec = fx.specs[0];
    const [m1, m2] = spec.moments.filter((m) => m.wantDescription).map((m) => m.momentId);
    expect(m2).toBeDefined();
    const inventedName = "We spent the afternoon by the water. Later everyone walked with Ahmed through the old streets of Lisbon until the lamps came on and the day ended.";
    const bad: ReplaySynth = (meta, ctx) => {
      const out = captionWriterReplaySynth(meta, ctx) as { moments: Array<{ momentId: string; description?: string | null }> };
      if (Array.isArray(meta.repair)) return out;
      for (const m of out.moments) {
        if (m.momentId === m1) m.description = words(46);
        if (m.momentId === m2) m.description = inventedName;
      }
      return out;
    };
    const logger = new MemoryLogger();
    const transport = new ReplayTransport({ scenario: "ok", fixturesDir: "/nonexistent", synths: { caption_writer: bad } });
    const first = await writeCaptions(writerArgs(spec, fx, { logger, transport }));
    expect(first.ok).toBe(true);
    expect(first.issues.get(`${m1}:desc`)?.map((i) => i.code)).toEqual(["too_long"]);
    expect(first.issues.get(`${m2}:desc`)?.map((i) => i.code)).toEqual(["unknown_name"]);
    expect(first.descriptions.has(m1)).toBe(false);
    expect(first.descriptions.has(m2)).toBe(false);
    expect([...first.captions.keys()]).toEqual(spec.keys); // captions are unaffected
    expect(logger.rows[0].output).toMatchObject({ moments: [{ descriptionWords: 46, descriptionIssues: ["too_long"] }, { descriptionIssues: ["unknown_name"] }] });
    expect(JSON.stringify(logger.rows[0])).not.toContain("Lisbon");

    const targets = [...first.issues].map(([key, list]) => ({ key, reason: list.map((i) => i.code) }));
    const repairArgs = writerArgs(spec, fx, { logger, transport, stepKey: "caption_writer:repair:0", repairTargets: targets });
    const req = buildCaptionWriterRequest(repairArgs);
    expect(req.effort).toBe("low");
    expect(req.messages[0].content).toContain(`Rewrite only these: ${m1}:desc (too_long), ${m2}:desc (unknown_name)`);
    const repaired = await writeCaptions(repairArgs);
    expect(repaired.ok).toBe(true);
    expect([...repaired.issues.keys()]).toEqual([]);
    expect([...repaired.descriptions.keys()]).toEqual([m1, m2]);
    expect([...repaired.captions.keys()]).toEqual([]); // only the listed keys
    for (const t of repaired.descriptions.values()) expect(wordCount(t)).toBeLessThanOrEqual(45);
    expect(transport.callCount).toBe(2);
  });

  it("pre-check details: missing → empty; repeats a caption of the batch or another description → duplicate; a repair of one key leaves the others alone", () => {
    const fx = fixture();
    const spec = fx.specs[0];
    const [m1, m2] = spec.moments.filter((m) => m.wantDescription).map((m) => m.momentId);
    const captionOf = (k: string) => `Quiet streets and a slow easy walk ${k.replace(/\D/g, " ").trim().split(" ").map((d) => "abcdefghij"[Number(d) % 10]).join("")}`;
    const moments = spec.moments.map((m) => ({
      momentId: m.momentId,
      heading: "Slow hours",
      pageCaptions: m.pages.map((p) => ({ pageIndex: p.pageIndex, text: captionOf(p.key) })),
      description: null as string | null,
    }));
    const args = { spec, book: { occasion: "travel" as const, tone: "fun" as const, captionLang: "en" as const, title: null }, photosById: fx.photosById, descriptions: true };
    // Missing.
    expect(precheckBatch({ moments }, args).issues.get(`${m1}:desc`)?.map((i) => i.code)).toEqual(["empty"]);
    // Repeats a caption of the same batch verbatim.
    const firstKey = spec.moments.find((m) => m.momentId === m1)!.pages[0]?.key ?? spec.keys[0];
    const copy = moments.map((m) => (m.momentId === m1 ? { ...m, description: `${captionOf(firstKey)}. ${replayDescription("m1", "en")}` } : m.momentId === m2 ? { ...m, description: replayDescription("m2", "en") } : m));
    const r = precheckBatch({ moments: copy }, args);
    expect(r.issues.get(`${m1}:desc`)?.map((i) => i.code)).toEqual(["duplicate"]);
    expect(r.descriptions.get(m2)).toBe(replayDescription("m2", "en"));
    // Equal to a description written for another moment in an earlier batch.
    const dup = precheckBatch({ moments: copy }, { ...args, otherDescriptions: [replayDescription("m2", "en")] });
    expect(dup.issues.get(`${m2}:desc`)?.map((i) => i.code)).toEqual(["duplicate"]);
    // Without the flag nothing about descriptions is checked or returned (pre-M30 behaviour).
    const off = precheckBatch({ moments: copy }, { ...args, descriptions: false });
    expect(off.descriptions.size).toBe(0);
    expect([...off.issues.keys()].some((k) => k.endsWith(":desc"))).toBe(false);
    // Repair of m1:desc only: m2's description is not requested, not returned.
    const rep = precheckBatch({ moments: copy.map((m) => (m.momentId === m1 ? { ...m, description: replayDescription("m1", "en", true), pageCaptions: [] } : { ...m, pageCaptions: [] })) }, { ...args, repairTargets: [{ key: `${m1}:desc`, reason: "duplicate" }] });
    expect([...rep.descriptions.keys()]).toEqual([m1]);
    expect([...rep.issues.keys()]).toEqual([]);
    expect(rep.captions.size).toBe(0);
  });

  it("captionLogOutput: description word count + issue codes only on answers that carry one", () => {
    const base = captionLogOutput({ moments: [{ momentId: "m1", heading: "Slow hours", pageCaptions: [] }] }, "en");
    expect(base.moments[0]).toEqual({ momentId: "m1", headingWords: 2, pages: [] });
    const withDesc = captionLogOutput(
      { moments: [{ momentId: "m1", heading: "Slow hours", pageCaptions: [], description: "Secret words here." }, { momentId: "m2", heading: "More", pageCaptions: [], description: null }] },
      "en",
      new Map([["m1:desc", [{ code: "duplicate" }]]]),
    );
    expect(withDesc.moments).toEqual([
      { momentId: "m1", headingWords: 2, pages: [], descriptionWords: 3, descriptionIssues: ["duplicate"] },
      { momentId: "m2", headingWords: 1, pages: [] },
    ]);
    expect(JSON.stringify(withDesc)).not.toContain("Secret");
  });
});

// ------------------------------------------------------------------------------------------------

function describedDoc(fx: ReturnType<typeof fixture>, userChapter = -1): BookDoc {
  const doc = applyCaptions(fx.doc, new Map(), new Map(), { lang: "en", descriptions: new Map(fx.doc.chapters.map((_, i) => [`m${i + 1}`, replayDescription(`m${i + 1}`, "en")])) });
  return userChapter < 0 ? doc : { ...doc, chapters: doc.chapters.map((c, i) => (i === userChapter ? { ...c, description: { text: "My own words about the day.", source: "user" as const } } : c)) };
}

const criticArgs = (fx: ReturnType<typeof fixture>, doc: BookDoc, descriptions: boolean) => ({
  doc,
  aliasOf: fx.aliasOf,
  photosById: fx.photosById,
  metadata: { title: null, places: [], dates: fx.photos.map((p) => p.takenAt) },
  precheck: new Map(),
  book: { occasion: "travel" as const, tone: "fun" as const, captionLang: "en" as const },
  descriptions,
});

describe("Critic — descriptions variant", () => {
  it("variant prompt = base rules + DESCRIPTIONS section; same schema, no new issue type", () => {
    const base = criticSystemText();
    const variant = criticDescriptionsSystemText();
    expect(variant.startsWith(`${base.trimEnd()}\n\nDESCRIPTIONS\n`)).toBe(true);
    const section = variant.slice(base.trimEnd().length);
    for (const phrase of ['description [ai] "text"', "description [user]", "fix rewrite_caption", `Start detail with "${DESCRIPTION_DETAIL_PREFIX}"`, "Never report issues for [user] descriptions", "25 to 45 words"]) {
      expect(section, phrase).toContain(phrase);
    }
    expect(criticSystemFor(true).map((b) => b.text)).toEqual([variant]);
    expect(criticSystemFor(false).map((b) => b.text)).toEqual([base]);
    const fx = fixture();
    const doc = describedDoc(fx);
    expect(buildCriticRequest(criticArgs(fx, doc, true)).schema).toBe(CritiqueAiSchema);
    expect(buildCriticRequest(criticArgs(fx, doc, true)).maxTokens).toBe(buildCriticRequest(criticArgs(fx, doc, false)).maxTokens);
  });

  it("user message: each description once, on the page that prints it, tagged [ai] / [user]; flagged ones listed by code", () => {
    const fx = fixture();
    const doc = describedDoc(fx, 1);
    const pages = descriptionPageIndexes(doc);
    expect(pages.size).toBe(doc.chapters.length);
    const precheck = new Map([["m1:desc", [{ code: "duplicate" as const, key: "m1:desc" }]]]);
    const msg = buildCriticUserMessage({ ...criticArgs(fx, doc, true), precheck });
    const lines = msg.split("\n");
    const start = lines.findIndex((l) => l.startsWith("PAGES ("));
    doc.pages.forEach((p, i) => {
      const line = lines[start + 1 + i];
      expect(line.startsWith(`${i} · `)).toBe(true);
      const ch = doc.chapters.findIndex((c) => c.id === p.chapterId);
      if (pages.get(p.chapterId as string) === i) {
        expect(line).toContain(` · description [${ch === 1 ? "user" : "ai"}] "${doc.chapters[ch].description!.text.replace(/"/g, "'")}"`);
      } else expect(line).not.toContain("description [");
    });
    expect(msg.split("description [").length - 1).toBe(doc.chapters.length);
    expect(msg).toContain(`page ${pages.get(doc.chapters[0].id)} (description): duplicate`);
    // Base call on the same doc: no description text at all.
    const base = buildCriticUserMessage(criticArgs(fx, doc, false));
    expect(base).not.toContain("description [");
    expect(base).not.toContain(doc.chapters[0].description!.text);
  });
});

describe("repair plan — description issues", () => {
  const batchOf = () => 0;
  const critique = (issues: Critique["issues"], score = 5): Critique => ({ score, issues });

  it("a pre-check failure of a description is a target (heading-like key)", () => {
    const fx = fixture();
    const doc = describedDoc(fx);
    const plan = planRepair(null, new Map([["m2:desc", [{ code: "too_long" as const }]]]), doc, { photos: fx.photos, batchIndexOf: batchOf });
    expect([...plan.rewrite.values()].flat()).toEqual([{ key: "m2:desc", reason: "pre-check: too_long" }]);
    expect(plan.loggedOnly).toEqual([]);
  });

  it("Critic: a detail starting with 'description:' on the description page → m{n}:desc (fix rewrite_caption, existing types)", () => {
    const fx = fixture();
    const doc = describedDoc(fx);
    const page = descriptionPageIndexes(doc).get(doc.chapters[1].id) as number;
    const withCaption: BookDoc = { ...doc, pages: doc.pages.map((p, i) => (i === page && getLayout(p.layout)?.caption ? { ...p, caption: { text: "A caption here", font: "Poppins", align: "center", source: "ai" } } : p)) };
    for (const type of ["caption_invented_fact", "caption_mismatch", "caption_not_original", "too_repetitive"] as const) {
      const plan = planRepair(critique([{ type, pageIndex: page, detail: "Description: names a city that is not in the metadata.", fix: "rewrite_caption" }]), new Map(), withCaption, { photos: fx.photos, batchIndexOf: batchOf });
      expect([...plan.rewrite.values()].flat()).toEqual([{ key: "m2:desc", reason: `critic: ${type}` }]);
    }
    // Without the prefix the issue is about the page caption (pre-M30 behaviour) when it has an AI caption…
    const hasCaption = Boolean(withCaption.pages[page].caption);
    const plain = planRepair(critique([{ type: "caption_mismatch", pageIndex: page, detail: "The caption talks about a beach.", fix: "rewrite_caption" }]), new Map(), withCaption, { photos: fx.photos, batchIndexOf: batchOf });
    const keys = [...plain.rewrite.values()].flat().map((t) => t.key);
    expect(keys).toHaveLength(1);
    expect(keys[0].endsWith(":desc")).toBe(!hasCaption);
    // …and about the description when the page has no AI caption to blame.
    const noCaption = planRepair(critique([{ type: "caption_mismatch", pageIndex: page, detail: "Does not match the photos.", fix: "rewrite_caption" }]), new Map(), doc, { photos: fx.photos, batchIndexOf: batchOf });
    expect([...noCaption.rewrite.values()].flat().map((t) => t.key)).toEqual(["m2:desc"]);
  });

  it("never targets a user description; a score ≥ 7 repairs nothing; other pages are unaffected", () => {
    const fx = fixture();
    const doc = describedDoc(fx, 0);
    const page = descriptionPageIndexes(doc).get(doc.chapters[0].id) as number;
    const issue = { type: "caption_invented_fact" as const, pageIndex: page, detail: "description: invented name.", fix: "rewrite_caption" as const };
    const user = planRepair(critique([issue]), new Map(), doc, { photos: fx.photos, batchIndexOf: batchOf });
    expect(user.rewrite.size).toBe(0);
    expect(user.loggedOnly).toEqual([`caption_invented_fact@${page}:user_description`]);
    const fine = planRepair(critique([{ ...issue, pageIndex: descriptionPageIndexes(doc).get(doc.chapters[1].id) as number }], 8), new Map(), doc, { photos: fx.photos, batchIndexOf: batchOf });
    expect(fine.rewrite.size).toBe(0);
    // A "description:" detail on a page that prints no description is not a description target.
    const other = doc.pages.findIndex((p, i) => ![...descriptionPageIndexes(doc).values()].includes(i) && p.side !== "right");
    const stray = planRepair(critique([{ ...issue, pageIndex: other }]), new Map(), doc, { photos: fx.photos, batchIndexOf: batchOf });
    expect([...stray.rewrite.values()].flat().some((t) => t.key.endsWith(":desc"))).toBe(false);
    expect(JSON.stringify([...user.rewrite, ...user.loggedOnly, ...stray.loggedOnly])).not.toContain("invented name");
  });
});
