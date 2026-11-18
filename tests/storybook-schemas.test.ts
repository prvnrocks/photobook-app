import { describe, expect, it } from "vitest";
import { DROP_REASONS, MOODS, SCENES } from "@/lib/ai/schemas";
import { DESIGN_STYLES } from "@/lib/book/schema";
import {
  AiObservationSchema,
  ChapterSchema,
  MemoryContextSchema,
  MomentSchema,
  NarrativeBlockSchema,
  PhotoAnalysisSchema,
  ProvenanceSchema,
  STORY_BALANCE,
  STORY_LIMITS,
  STORYBOOK_SCHEMA_VERSION,
  StoredMemoryContextSchema,
  StoryPageSchema,
  StorybookSchema,
} from "@/lib/storybook/schemas";
import { balanceOf, isBalanced, narrativePageBudget, storybookBalance } from "@/lib/storybook/balance";
import { aiProvenance, aiRewrite, hasUserContent, isProtectedPage, mergeAiDraft, userEdit } from "@/lib/storybook/versioning";
import type { Chapter, MemoryContext, Moment, NarrativeBlock, PhotoAnalysis, StoryAnswer, StoryPage, Storybook } from "@/lib/storybook/types";

const NOW = "2026-11-19T08:00:00.000Z";
const LATER = "2026-11-19T09:30:00.000Z";
const BOOK = "11111111-1111-4111-8111-111111111111";
const ph = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const photo = (over: Partial<PhotoAnalysis> = {}): PhotoAnalysis => ({
  v: 1,
  photoId: ph(1),
  takenAt: "2026-10-12T10:00:00+04:00",
  dateSource: "exif",
  place: "Abu Dhabi",
  hasGps: true,
  orientation: "landscape",
  aspect: 1.5,
  blurScore: 120.5,
  dupGroup: null,
  color: "#aabbcc",
  ai: { description: "Two people on a beach at sunset.", scene: "group", peopleCount: 2, mood: "calm", quality: 8, coverWorthy: true },
  keep: true,
  dropReason: null,
  userOverride: false,
  ...over,
});

const answer = (over: Partial<StoryAnswer> = {}): StoryAnswer => ({
  questionId: "travel.companions",
  question: "Who did you travel with?",
  text: "My sister and the kids",
  source: "user",
  ...over,
});

const context = (over: Partial<MemoryContext> = {}): MemoryContext => ({
  v: 1,
  occasion: "travel",
  tone: "nostalgic",
  lang: "en",
  storyTone: "heartfelt",
  answers: [answer()],
  skipped: false,
  note: "Our first trip to Oman with the kids.",
  people: [
    { name: "Aisha", relation: "my sister" },
    { name: "Omar", relation: null },
  ],
  places: ["Muscat", "Nizwa"],
  facts: ["We drove from Abu Dhabi."],
  avoid: [],
  narrator: "first_plural",
  dateRange: { from: "2026-10-10T00:00:00Z", to: "2026-10-14T00:00:00Z" },
  rev: 1,
  updatedAt: NOW,
  ...over,
});

const moment = (id: string, photoIds: string[], over: Partial<Moment> = {}): Moment => ({
  id,
  title: "Arrival",
  dateLabel: "10 Oct 2026",
  place: "Muscat",
  photoIds,
  heroPhotoId: photoIds[0] ?? null,
  beat: "opening",
  summary: "The family arrives at the hotel.",
  ...over,
});

const chapter = (id: string, momentIds: string[], over: Partial<Chapter> = {}): Chapter => ({
  id,
  title: { text: "Day one", provenance: aiProvenance(1) },
  momentIds,
  narrativeShare: 0.35,
  ...over,
});

const block = (id: string, over: Partial<NarrativeBlock> = {}): NarrativeBlock => ({
  id,
  kind: "paragraph",
  text: "We reached the coast just before sunset.",
  lang: "en",
  provenance: aiProvenance(1),
  groundedIn: [],
  ...over,
});

const page = (id: string, over: Partial<StoryPage> = {}): StoryPage => ({
  id,
  kind: "photo",
  chapterId: "c1",
  momentId: "m1",
  photoIds: [ph(1)],
  blocks: [],
  narrativeShare: 0,
  layoutId: null,
  userLocked: false,
  ...over,
});

const storybook = (over: Partial<Storybook> = {}): Storybook => ({
  v: 1,
  bookId: BOOK,
  version: 1,
  parentVersion: null,
  origin: "ai",
  generator: { pipeline: "storybook-1", model: "claude-opus-5-5", prompts: { storyteller: "v7" } },
  format: "A5_PORTRAIT",
  designStyle: "editorial",
  lang: "en",
  title: { text: "Oman, October", provenance: aiProvenance(1) },
  subtitle: null,
  coverPhotoId: ph(1),
  contextRev: 1,
  target: { photoShare: 0.65, narrativeShare: 0.35 },
  moments: [moment("m1", [ph(1), ph(2)]), moment("m2", [ph(3)], { beat: "closing" })],
  chapters: [chapter("c1", ["m1", "m2"])],
  pages: [
    page("pg1", { kind: "cover", chapterId: null, momentId: null, photoIds: [ph(1)] }),
    page("pg2", { photoIds: [ph(1), ph(2)] }),
    page("pg3", { kind: "mixed", momentId: "m2", photoIds: [ph(3)], blocks: [block("b1", { groundedIn: [ph(3)] })], narrativeShare: 0.5 }),
    page("pg4", { kind: "narrative", momentId: "m2", photoIds: [], blocks: [block("b2", { kind: "closing" })], narrativeShare: 0.9 }),
  ],
  createdAt: NOW,
  ...over,
});

const messages = (r: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

describe("storybook schemas: shared enums stay tied to the existing layers", () => {
  it("version, balance target and limits", () => {
    expect(STORYBOOK_SCHEMA_VERSION).toBe(1);
    expect(STORY_BALANCE.photoShare + STORY_BALANCE.narrativeShare).toBeCloseTo(1);
    expect(STORY_BALANCE).toMatchObject({ photoShare: 0.65, narrativeShare: 0.35 });
    expect(STORY_LIMITS.pagesPerBook).toBe(100);
  });

  it("PhotoAnalysis accepts every Curator scene / mood / drop reason", () => {
    for (const scene of SCENES) for (const mood of MOODS) expect(PhotoAnalysisSchema.safeParse(photo({ ai: { ...photo().ai!, scene, mood } })).success).toBe(true);
    for (const dropReason of DROP_REASONS) expect(PhotoAnalysisSchema.safeParse(photo({ keep: false, dropReason })).success).toBe(true);
  });

  it("Storybook accepts every design style", () => {
    for (const designStyle of DESIGN_STYLES) expect(StorybookSchema.safeParse(storybook({ designStyle })).success).toBe(true);
  });
});

describe("ProvenanceSchema", () => {
  it("ai content needs aiVersion; user content needs editedAt", () => {
    expect(ProvenanceSchema.safeParse(aiProvenance(3)).success).toBe(true);
    expect(ProvenanceSchema.safeParse({ source: "ai", rev: 1, aiVersion: null, editedAt: null }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ source: "user", rev: 2, aiVersion: 1, editedAt: null }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ source: "user", rev: 1, aiVersion: null, editedAt: NOW }).success).toBe(true);
    expect(ProvenanceSchema.safeParse({ ...aiProvenance(1), extra: 1 }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ ...aiProvenance(1), rev: 0 }).success).toBe(false);
  });
});

describe("PhotoAnalysisSchema", () => {
  it("accepts a full photo, an un-analysed photo (ai null) and optional story signals", () => {
    expect(PhotoAnalysisSchema.safeParse(photo()).success).toBe(true);
    expect(PhotoAnalysisSchema.safeParse(photo({ ai: null, takenAt: null, dateSource: null, place: null, hasGps: false, color: null, blurScore: null })).success).toBe(true);
    expect(PhotoAnalysisSchema.safeParse(photo({ story: { significance: 9, role: "establishing", tags: ["beach"] } })).success).toBe(true);
  });

  it("a dropped photo needs a reason unless the user dropped it; a kept photo has none", () => {
    expect(PhotoAnalysisSchema.safeParse(photo({ keep: false, dropReason: null })).success).toBe(false);
    expect(PhotoAnalysisSchema.safeParse(photo({ keep: false, dropReason: null, userOverride: true })).success).toBe(true);
    expect(PhotoAnalysisSchema.safeParse(photo({ keep: true, dropReason: "blurry" })).success).toBe(false);
  });

  it("rejects bad ids, colours, unknown keys, out-of-range scores and over-long descriptions", () => {
    expect(PhotoAnalysisSchema.safeParse(photo({ photoId: "p12" })).success).toBe(false);
    expect(PhotoAnalysisSchema.safeParse(photo({ color: "#ABCDEF" })).success).toBe(false);
    expect(PhotoAnalysisSchema.safeParse({ ...photo(), faces: [] }).success).toBe(false);
    expect(PhotoAnalysisSchema.safeParse(photo({ ai: { ...photo().ai!, quality: 11 } })).success).toBe(false);
    expect(PhotoAnalysisSchema.safeParse(photo({ ai: { ...photo().ai!, description: "x".repeat(201) } })).success).toBe(false);
    expect(PhotoAnalysisSchema.safeParse(photo({ story: { significance: 5, role: "action", tags: Array(9).fill("t") } })).success).toBe(false);
    expect(PhotoAnalysisSchema.safeParse({ ...photo(), v: 2 }).success).toBe(false);
  });
});

describe("MemoryContextSchema", () => {
  it("accepts a full context, a minimal one, and Arabic text", () => {
    expect(MemoryContextSchema.safeParse(context()).success).toBe(true);
    expect(MemoryContextSchema.safeParse(context({ note: null, people: [], places: [], facts: [], dateRange: null })).success).toBe(true);
    expect(MemoryContextSchema.safeParse(context({ lang: "ar", note: "رحلتنا الأولى إلى عُمان", people: [{ name: "عائشة", relation: "أختي" }] })).success).toBe(true);
  });

  it("rejects duplicate people (case-insensitive), blank text, reversed dates and lone surrogates", () => {
    expect(messages(MemoryContextSchema.safeParse(context({ people: [{ name: "Aisha", relation: null }, { name: " aisha", relation: null }] })))).toContain("people: duplicate person");
    expect(MemoryContextSchema.safeParse(context({ note: "   " })).success).toBe(false);
    expect(MemoryContextSchema.safeParse(context({ dateRange: { from: "2026-10-14T00:00:00Z", to: "2026-10-10T00:00:00Z" } })).success).toBe(false);
    expect(MemoryContextSchema.safeParse(context({ facts: ["bad \ud83d"] })).success).toBe(false);
  });

  it("compares dateRange as instants, not strings (different offsets)", () => {
    expect(MemoryContextSchema.safeParse(context({ dateRange: { from: "2026-10-10T23:00:00-05:00", to: "2026-10-11T05:00:00+04:00" } })).success).toBe(false);
    expect(MemoryContextSchema.safeParse(context({ dateRange: { from: "2026-10-11T05:00:00+04:00", to: "2026-10-10T23:00:00-05:00" } })).success).toBe(true);
  });

  it("enforces list and length limits", () => {
    expect(MemoryContextSchema.safeParse(context({ people: Array.from({ length: 21 }, (_, i) => ({ name: `P${i}`, relation: null })) })).success).toBe(false);
    expect(MemoryContextSchema.safeParse(context({ note: "x".repeat(STORY_LIMITS.noteText + 1) })).success).toBe(false);
    expect(MemoryContextSchema.safeParse(context({ avoid: Array(11).fill("x") })).success).toBe(false);
  });

  it("story step: skipped is different from not reached / unanswered", () => {
    // not reached yet or reached and left blank: no answers, not skipped
    const unanswered = MemoryContextSchema.safeParse(context({ storyTone: null, answers: [], skipped: false }));
    expect(unanswered.success && unanswered.data.skipped).toBe(false);
    // skipped on purpose: still no answers, and it says so
    const skipped = MemoryContextSchema.safeParse(context({ storyTone: null, answers: [], skipped: true }));
    expect(skipped.success && skipped.data.skipped).toBe(true);
    // a skipped step never carries answers; a tone alone is fine
    expect(messages(MemoryContextSchema.safeParse(context({ skipped: true })))).toContain("answers: a skipped step has no answers");
    expect(MemoryContextSchema.safeParse(context({ skipped: true, answers: [], storyTone: "elegant" })).success).toBe(true);
    // the three fields are required: an old-shape context is not silently "not skipped"
    for (const key of ["storyTone", "answers", "skipped"] as const) {
      const partial: Record<string, unknown> = { ...context() };
      delete partial[key];
      expect(MemoryContextSchema.safeParse(partial).success).toBe(false);
    }
  });

  it("story answers: at most 2, unique question, non-blank, 1–200 code points, Arabic accepted", () => {
    const second = answer({ questionId: "travel.special", question: "What made this trip special?", text: "The views" });
    expect(MemoryContextSchema.safeParse(context({ answers: [answer(), second] })).success).toBe(true);
    expect(MemoryContextSchema.safeParse(context({ answers: [answer(), second, answer({ questionId: "travel.other" })] })).success).toBe(false);
    expect(messages(MemoryContextSchema.safeParse(context({ answers: [answer(), answer({ text: "Again" })] })))).toContain("answers: duplicate question");
    for (const text of ["", "   ", "\n\t", "x".repeat(201), "bad \ud83d"]) {
      expect(MemoryContextSchema.safeParse(context({ answers: [answer({ text })] })).success).toBe(false);
    }
    // the limit counts code points: 200 emoji are 400 UTF-16 units and still fit; 201 do not
    expect(MemoryContextSchema.safeParse(context({ answers: [answer({ text: "x".repeat(200) })] })).success).toBe(true);
    expect(MemoryContextSchema.safeParse(context({ answers: [answer({ text: "🎂".repeat(200) })] })).success).toBe(true);
    expect(MemoryContextSchema.safeParse(context({ answers: [answer({ text: "🎂".repeat(201) })] })).success).toBe(false);
    expect(MemoryContextSchema.safeParse(context({ lang: "ar", answers: [answer({ text: "مع أختي والأطفال" })] })).success).toBe(true);
    for (const questionId of ["", "travel", "Travel.companions", "travel.companions.x", "travel.1", `travel.${"a".repeat(60)}`]) {
      expect(MemoryContextSchema.safeParse(context({ answers: [answer({ questionId })] })).success).toBe(false);
    }
    expect(MemoryContextSchema.safeParse(context({ storyTone: "romantic" as never })).success).toBe(false);
  });

  it("holds only what the user said: no AI-sourced entry and no field for model output", () => {
    expect(MemoryContextSchema.safeParse(context({ answers: [answer({ source: "ai" as never })] })).success).toBe(false);
    const unsourced: Record<string, unknown> = { ...answer() };
    delete unsourced.source;
    expect(MemoryContextSchema.safeParse(context({ answers: [unsourced as never] })).success).toBe(false);
    const observation = { photoId: ph(1), source: "ai", kind: "vision", text: "Two people on a beach." };
    expect(AiObservationSchema.safeParse(observation).success).toBe(true);
    expect(AiObservationSchema.safeParse({ ...observation, source: "user" }).success).toBe(false);
    // an observation fits nowhere in the context: not as an answer, not as an extra key
    expect(MemoryContextSchema.safeParse(context({ answers: [observation as never] })).success).toBe(false);
    for (const key of ["observations", "ai", "vision", "aiNotes"]) {
      expect(MemoryContextSchema.safeParse({ ...context(), [key]: [observation] }).success).toBe(false);
    }
    expect(MemoryContextSchema.safeParse(context({ answers: [{ ...answer(), aiSuggestion: "x" } as never] })).success).toBe(false);
  });

  it("the stored column value is a context or the empty object", () => {
    expect(StoredMemoryContextSchema.safeParse({}).success).toBe(true);
    expect(StoredMemoryContextSchema.safeParse(context()).success).toBe(true);
    expect(StoredMemoryContextSchema.safeParse({ note: "x" }).success).toBe(false);
  });
});

describe("MomentSchema / ChapterSchema", () => {
  it("accepts a moment; the hero must be one of its photos; photos are unique", () => {
    expect(MomentSchema.safeParse(moment("m1", [ph(1), ph(2)])).success).toBe(true);
    expect(MomentSchema.safeParse(moment("m1", [ph(1)], { heroPhotoId: ph(9) })).success).toBe(false);
    expect(MomentSchema.safeParse(moment("m1", [ph(1), ph(1)])).success).toBe(false);
    expect(MomentSchema.safeParse(moment("m1", [])).success).toBe(false);
    expect(MomentSchema.safeParse(moment("moment-1", [ph(1)])).success).toBe(false);
    expect(MomentSchema.safeParse(moment("m0", [ph(1)])).success).toBe(false);
  });

  it("accepts a chapter; moments are unique; narrativeShare is 0–1", () => {
    expect(ChapterSchema.safeParse(chapter("c1", ["m1", "m2"])).success).toBe(true);
    expect(ChapterSchema.safeParse(chapter("c1", ["m1", "m1"])).success).toBe(false);
    expect(ChapterSchema.safeParse(chapter("c1", [])).success).toBe(false);
    expect(ChapterSchema.safeParse(chapter("c1", ["m1"], { narrativeShare: 1.2 })).success).toBe(false);
  });
});

describe("NarrativeBlockSchema / StoryPageSchema", () => {
  it("a block has bounded, non-blank text and provenance", () => {
    expect(NarrativeBlockSchema.safeParse(block("b1")).success).toBe(true);
    expect(NarrativeBlockSchema.safeParse(block("b1", { text: "" })).success).toBe(false);
    expect(NarrativeBlockSchema.safeParse(block("b1", { text: "x".repeat(STORY_LIMITS.narrativeText + 1) })).success).toBe(false);
    expect(NarrativeBlockSchema.safeParse({ ...block("b1"), provenance: undefined }).success).toBe(false);
  });

  it("page kinds agree with their content", () => {
    expect(StoryPageSchema.safeParse(page("pg1")).success).toBe(true);
    expect(StoryPageSchema.safeParse(page("pg1", { photoIds: [] })).success).toBe(false); // photo page without photos
    expect(StoryPageSchema.safeParse(page("pg1", { blocks: [block("b1")], narrativeShare: 0.5 })).success).toBe(false); // photo page, half text
    expect(StoryPageSchema.safeParse(page("pg1", { kind: "narrative", photoIds: [], blocks: [block("b1")], narrativeShare: 1 })).success).toBe(true);
    expect(StoryPageSchema.safeParse(page("pg1", { kind: "narrative", photoIds: [], blocks: [], narrativeShare: 1 })).success).toBe(false);
    expect(StoryPageSchema.safeParse(page("pg1", { kind: "narrative", photoIds: [], blocks: [block("b1")], narrativeShare: 0.5 })).success).toBe(false);
    expect(StoryPageSchema.safeParse(page("pg1", { kind: "mixed", blocks: [], narrativeShare: 0 })).success).toBe(false);
    expect(StoryPageSchema.safeParse(page("pg1", { narrativeShare: 0.1 })).success).toBe(false); // text area without text
  });

  it("limits photos and blocks per page and rejects duplicates and bad layout ids", () => {
    expect(StoryPageSchema.safeParse(page("pg1", { photoIds: Array.from({ length: 7 }, (_, i) => ph(i + 1)) })).success).toBe(false);
    expect(StoryPageSchema.safeParse(page("pg1", { photoIds: [ph(1), ph(1)] })).success).toBe(false);
    expect(StoryPageSchema.safeParse(page("pg1", { kind: "mixed", blocks: [block("b1"), block("b1")], narrativeShare: 0.4 })).success).toBe(false);
    expect(StoryPageSchema.safeParse(page("pg1", { layoutId: "ed-p-one-column" })).success).toBe(true);
    expect(StoryPageSchema.safeParse(page("pg1", { layoutId: "Bad Layout" })).success).toBe(false);
  });
});

describe("StorybookSchema", () => {
  it("accepts a valid storybook and survives a JSON round trip unchanged", () => {
    const s = storybook();
    const r = StorybookSchema.safeParse(JSON.parse(JSON.stringify(s)));
    expect(messages(r)).toEqual([]);
    expect(r.success && r.data).toEqual(s);
  });

  it("accepts an empty first draft (no moments / pages yet)", () => {
    expect(StorybookSchema.safeParse(storybook({ moments: [], chapters: [], pages: [], coverPhotoId: null })).success).toBe(true);
  });

  it("cross references: chapters → moments, pages → chapters / moments / photos", () => {
    expect(messages(StorybookSchema.safeParse(storybook({ chapters: [chapter("c1", ["m1", "m9"])] })))).toContain("chapters.0.momentIds: unknown moment m9");
    const s = storybook();
    expect(messages(StorybookSchema.safeParse({ ...s, pages: [page("pg2", { chapterId: "c7" })] }))).toContain("pages.0.chapterId: unknown chapter c7");
    expect(messages(StorybookSchema.safeParse({ ...s, pages: [page("pg2", { momentId: "m7" })] }))).toContain("pages.0.momentId: unknown moment m7");
    expect(messages(StorybookSchema.safeParse({ ...s, pages: [page("pg2", { photoIds: [ph(99)] })] }))).toContain("pages.0.photoIds: photo is not in any moment");
  });

  it("a photo belongs to one moment and one inner page; a moment to one chapter; block ids are book-unique", () => {
    const s = storybook();
    expect(messages(StorybookSchema.safeParse({ ...s, moments: [moment("m1", [ph(1), ph(2)]), moment("m2", [ph(2), ph(3)])] }))).toContain(
      "moments.1.photoIds: a photo belongs to more than one moment",
    );
    expect(messages(StorybookSchema.safeParse({ ...s, pages: [page("pg2"), page("pg3", { photoIds: [ph(1)] })] }))).toContain(
      "pages.1.photoIds: a photo is placed on more than one page",
    );
    expect(messages(StorybookSchema.safeParse({ ...s, chapters: [chapter("c1", ["m1"]), chapter("c2", ["m1", "m2"])] }))).toContain(
      "chapters.1.momentIds: moment m1 is in more than one chapter",
    );
    const twice = [
      page("pg2", { kind: "mixed", blocks: [block("b1")], narrativeShare: 0.4 }),
      page("pg3", { kind: "mixed", photoIds: [ph(2)], blocks: [block("b1")], narrativeShare: 0.4 }),
    ];
    expect(messages(StorybookSchema.safeParse({ ...s, pages: twice }))).toContain("pages.1.blocks: block id b1 is used on more than one page");
  });

  it("the cover photo may also appear once inside the book; only one cover page", () => {
    expect(StorybookSchema.safeParse(storybook()).success).toBe(true); // ph(1) on cover + pg2
    const s = storybook();
    const cover = page("pg9", { kind: "cover", chapterId: null, momentId: null });
    expect(messages(StorybookSchema.safeParse({ ...s, pages: [...s.pages, cover] }))).toContain("pages: more than one cover page");
  });

  it("version rules and target shares", () => {
    expect(StorybookSchema.safeParse(storybook({ version: 2, parentVersion: 1 })).success).toBe(true);
    expect(StorybookSchema.safeParse(storybook({ version: 2, parentVersion: 2 })).success).toBe(false);
    expect(StorybookSchema.safeParse(storybook({ target: { photoShare: 0.7, narrativeShare: 0.35 } })).success).toBe(false);
    expect(StorybookSchema.safeParse(storybook({ target: { photoShare: 0.8, narrativeShare: 0.2 } })).success).toBe(true); // user-adjusted
    expect(StorybookSchema.safeParse({ ...storybook(), v: 2 }).success).toBe(false);
    expect(StorybookSchema.safeParse({ ...storybook(), origin: "robot" }).success).toBe(false);
    expect(StorybookSchema.safeParse({ ...storybook(), secret: 1 }).success).toBe(false);
  });

  it("an off-balance draft is still a VALID storybook (balance is reported, not a schema rule)", () => {
    const allPhotos = storybook({ pages: [page("pg2", { photoIds: [ph(1), ph(2)] }), page("pg3", { momentId: "m2", photoIds: [ph(3)] })] });
    expect(StorybookSchema.safeParse(allPhotos).success).toBe(true);
    expect(isBalanced(storybookBalance(allPhotos))).toBe(false);
  });
});

describe("balance (65 / 35)", () => {
  const p = (narrativeShare: number, kind: StoryPage["kind"] = "mixed") => ({ kind, narrativeShare });

  it("is the mean narrative area over inner pages; the cover does not count", () => {
    const b = balanceOf([p(0, "cover"), p(0, "photo"), p(0.5), p(0.9, "narrative"), p(0, "photo")]);
    expect(b).toEqual({ pages: 4, photoShare: 0.65, narrativeShare: 0.35, drift: 0 });
    expect(isBalanced(b)).toBe(true);
  });

  it("tolerance is ±5 points by default", () => {
    expect(isBalanced(balanceOf([p(0.4), p(0.4)]))).toBe(true); // 40 %
    expect(isBalanced(balanceOf([p(0.3), p(0.3)]))).toBe(true); // 30 %
    expect(isBalanced(balanceOf([p(0.41), p(0.41)]))).toBe(false);
    expect(isBalanced(balanceOf([p(0), p(0)]))).toBe(false);
    expect(balanceOf([p(0.6), p(0.6)]).drift).toBe(0.25);
  });

  it("an empty book is not balanced and does not divide by zero", () => {
    const b = balanceOf([p(0, "cover")]);
    expect(b).toEqual({ pages: 0, photoShare: 0, narrativeShare: 0, drift: -0.35 });
    expect(isBalanced(b)).toBe(false);
  });

  it("uses the storybook's own target and gives a page budget", () => {
    const s = storybook({ target: { photoShare: 0.8, narrativeShare: 0.2 }, pages: [page("pg2", { photoIds: [ph(1), ph(2)] }), page("pg3", { kind: "mixed", momentId: "m2", photoIds: [ph(3)], blocks: [block("b1")], narrativeShare: 0.4 })] });
    expect(storybookBalance(s)).toMatchObject({ narrativeShare: 0.2, drift: 0 });
    expect(narrativePageBudget(20)).toBe(7);
    expect(narrativePageBudget(100)).toBe(35);
    expect(narrativePageBudget(0)).toBe(0);
    expect(narrativePageBudget(Number.NaN)).toBe(0);
  });

  it("the fixture storybook is text-heavy: reported, not rejected", () => {
    expect(isBalanced(storybookBalance(storybook()))).toBe(false); // 3 inner pages: (0 + 0.5 + 0.9) / 3 = 46.7 %
    expect(storybookBalance(storybook()).narrativeShare).toBe(0.4667);
  });
});

describe("versioning: AI drafts, user edits are never overwritten", () => {
  it("provenance helpers", () => {
    const ai = aiProvenance(1);
    const edited = userEdit(ai, LATER);
    expect(edited).toEqual({ source: "user", rev: 2, aiVersion: 1, editedAt: LATER });
    expect(userEdit(null, LATER)).toEqual({ source: "user", rev: 1, aiVersion: null, editedAt: LATER });
    expect(aiRewrite(ai, 4)).toEqual({ source: "ai", rev: 2, aiVersion: 4, editedAt: null });
    for (const p of [ai, edited, userEdit(null, LATER), aiRewrite(ai, 4)]) expect(ProvenanceSchema.safeParse(p).success).toBe(true);
  });

  it("isProtectedPage / hasUserContent", () => {
    expect(isProtectedPage(page("pg1"))).toBe(false);
    expect(isProtectedPage(page("pg1", { userLocked: true }))).toBe(true);
    expect(isProtectedPage(page("pg1", { kind: "mixed", blocks: [block("b1", { provenance: userEdit(aiProvenance(1), LATER) })], narrativeShare: 0.4 }))).toBe(true);
    expect(hasUserContent(storybook())).toBe(false);
    expect(hasUserContent(storybook({ title: { text: "Mine", provenance: userEdit(aiProvenance(1), LATER) } }))).toBe(true);
  });

  it("with no user content the draft replaces everything: new version, origin ai", () => {
    const current = storybook();
    const draft = storybook({ version: 99, title: { text: "New title", provenance: aiProvenance(2) }, createdAt: LATER });
    const { storybook: next, report } = mergeAiDraft(current, draft, LATER);
    expect(report).toEqual({ keptPages: [], keptBlocks: [], keptTitles: [], carriedPages: [] });
    expect(next).toMatchObject({ version: 2, parentVersion: 1, origin: "ai", createdAt: LATER });
    expect(next.title.text).toBe("New title");
    expect(StorybookSchema.safeParse(next).success).toBe(true);
  });

  it("keeps user titles, user-written blocks and locked pages; origin merge", () => {
    const userBlock = block("b1", { text: "My own words.", provenance: userEdit(aiProvenance(1), LATER), groundedIn: [ph(3)] });
    const current = storybook({
      title: { text: "Our Oman", provenance: userEdit(aiProvenance(1), LATER) },
      chapters: [chapter("c1", ["m1", "m2"], { title: { text: "My chapter", provenance: userEdit(aiProvenance(1), LATER) } })],
      pages: [
        page("pg1", { kind: "cover", chapterId: null, momentId: null }),
        page("pg2", { photoIds: [ph(1), ph(2)], userLocked: true, layoutId: "ed-p-two" }),
        page("pg3", { kind: "mixed", momentId: "m2", photoIds: [ph(3)], blocks: [userBlock], narrativeShare: 0.5 }),
      ],
    });
    const draft = storybook({
      title: { text: "AI title", provenance: aiProvenance(2) },
      chapters: [chapter("c1", ["m1", "m2"], { title: { text: "AI chapter", provenance: aiProvenance(2) }, narrativeShare: 0.4 })],
      pages: [
        page("pg1", { kind: "cover", chapterId: null, momentId: null }),
        page("pg2", { photoIds: [ph(2)] }),
        page("pg3", { kind: "mixed", momentId: "m2", photoIds: [ph(3)], blocks: [block("b1", { text: "AI words.", provenance: aiProvenance(2) })], narrativeShare: 0.6 }),
      ],
    });
    const { storybook: next, report } = mergeAiDraft(current, draft, LATER);
    expect(next.origin).toBe("merge");
    expect(next.title.text).toBe("Our Oman");
    expect(next.chapters[0]!.title.text).toBe("My chapter");
    expect(next.chapters[0]!.narrativeShare).toBe(0.4); // the plan itself is the draft's
    expect(next.pages[1]).toEqual(current.pages[1]); // locked page kept whole
    expect(next.pages[2]).toEqual(current.pages[2]); // page with a user block is protected whole
    expect(report.keptPages).toEqual(["pg2", "pg3"]);
    expect(report.keptTitles).toEqual(["title", "chapter:c1"]);
    expect(StorybookSchema.safeParse(next).success).toBe(true);
    // inputs are not mutated
    expect(current.version).toBe(1);
    expect(draft.pages[1]!.photoIds).toEqual([ph(2)]);
  });

  it("a protected page the draft dropped is carried over after its chapter's last page", () => {
    const current = storybook({
      pages: [page("pg2", { photoIds: [ph(1)] }), page("pg7", { kind: "mixed", momentId: "m2", photoIds: [ph(3)], blocks: [block("b7", { provenance: userEdit(null, LATER) })], narrativeShare: 0.5 })],
    });
    const draft = storybook({ pages: [page("pg2", { photoIds: [ph(1)] }), page("pg3", { photoIds: [ph(2)] })] });
    const { storybook: next, report } = mergeAiDraft(current, draft, LATER);
    expect(report.carriedPages).toEqual(["pg7"]);
    expect(next.pages.map((p) => p.id)).toEqual(["pg2", "pg3", "pg7"]);
    expect(next.origin).toBe("merge");
    expect(StorybookSchema.safeParse(next).success).toBe(true);
  });

  it("the merged result is validated by the caller: a carried page whose photo the draft re-used fails the schema", () => {
    const current = storybook({ pages: [page("pg7", { photoIds: [ph(3)], momentId: "m2", userLocked: true })] });
    const draft = storybook({ pages: [page("pg2", { photoIds: [ph(3)], momentId: "m2" })] });
    const { storybook: next } = mergeAiDraft(current, draft, LATER);
    expect(messages(StorybookSchema.safeParse(next))).toContain("pages.1.photoIds: a photo is placed on more than one page");
  });
});
