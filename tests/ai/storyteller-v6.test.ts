// M10c T12 — Storyteller v6: geometric / scrapbook prompts (shape-aware catalogue), background
// catalogue + picks (D-068), photo colour in the user message, plan-to-doc background mapping with
// rule fallback, 8 cached prefixes. Pure / replay only (no network).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildStorytellerRequest, photoLine, planAlbum, planLogOutput } from "@/lib/ai/agents/storyteller";
import { synthAlbumPlan } from "@/lib/ai/agents/storyteller-replay";
import { backgroundPicksOf, planToDoc } from "@/lib/ai/plan-to-doc";
import { backgroundCatalogue, layoutCatalogue, STORYTELLER_PROMPT_VERSION, storytellerSystemText } from "@/lib/ai/prompts/storyteller";
import {
  albumPlanAiSchemaFor,
  AlbumPlanAiSchema,
  AlbumPlanBackgroundsAiSchema,
  AlbumPlanScrapbookAiSchema,
  AlbumPlanStrictSchema,
  type AlbumPlan,
} from "@/lib/ai/schemas";
import type { StoryPhoto } from "@/lib/ai/story";
import { ReplayTransport, MIN_CACHEABLE_TOKENS } from "@/lib/ai/transport-replay";
import type { BookDesign } from "@/lib/book/book-design";
import { validateBookDoc } from "@/lib/book/schema";
import { isSpreadAligned, layoutsFor } from "@/lib/book/spreads";
import type { BookDoc } from "@/lib/book/types";
import {
  AI_BACKGROUND_CATALOGUE,
  FADED_PHOTO_ID,
  isValidAiBackground,
  suggestBookBackground,
} from "@/lib/design/background-suggest";
import { getLayout } from "@/lib/layouts";
import { aliasMaps, RUN_ID, storyBook } from "../helpers/story-fixtures";
import type { AgentStepRecord, StepLogger } from "@/lib/ai/run-step";
import "@/lib/ai/agents/replay-synths";

const FORMATS = ["A5_PORTRAIT", "A5_LANDSCAPE"] as const;
const STYLES = ["classic", "modern", "geometric", "scrapbook"] as const;
const ALL8: BookDesign[] = FORMATS.flatMap((format) => STYLES.map((designStyle) => ({ format, designStyle })));
const NEW4: BookDesign[] = FORMATS.flatMap((format) => (["geometric", "scrapbook"] as const).map((designStyle) => ({ format, designStyle })));
const fixture = (f: string) => readFileSync(join(process.cwd(), "tests/fixtures/ai/storyteller", f), "utf8");
/** Same estimate as the replay usage model (≈ 4 chars per token). */
const estTokens = (s: string) => Math.ceil(s.length / 4);

// ------------------------------------------------------------------------------------------ prompts

describe("Storyteller v6 prompts", () => {
  it("PROMPT_VERSION 6", () => expect(STORYTELLER_PROMPT_VERSION).toBe(6));

  it("classic prefixes are BYTE-IDENTICAL to v5 (portrait = v4 fixture, landscape = v5 fixture)", () => {
    expect(storytellerSystemText({ format: "A5_PORTRAIT", designStyle: "classic" })).toBe(fixture("system-v4-classic-portrait.txt"));
    expect(storytellerSystemText({ format: "A5_LANDSCAPE", designStyle: "classic" })).toBe(fixture("system-v5-classic-landscape.txt"));
  });

  it("8 distinct stable prefixes, each above the Opus 5.5 minimum cacheable length (512 tokens) with margin", () => {
    const texts = ALL8.map((d) => storytellerSystemText(d));
    expect(new Set(texts).size).toBe(8);
    for (const d of ALL8) {
      expect(storytellerSystemText({ ...d })).toBe(storytellerSystemText(d));
      // ≥ 2× the minimum even if the real tokenizer packs ~2× more chars per token than the estimate.
      expect(estTokens(storytellerSystemText(d))).toBeGreaterThan(2 * MIN_CACHEABLE_TOKENS);
    }
  });

  it("nothing per book or per run in any prefix (no colours of photos, limits, aliases)", () => {
    for (const d of ALL8) {
      const t = storytellerSystemText(d);
      expect(t).not.toMatch(/maxPages: \d|kept photos: \d|\bp1 ·|user title: "/);
    }
  });

  it("geometric / scrapbook catalogues list every layout of the design with slot shape, tilt, frame, text and caption", () => {
    for (const d of NEW4) {
      const cat = layoutCatalogue(d);
      const own = (["page", "spread", "cover"] as const).flatMap((r) => layoutsFor(d.format, d.designStyle, r));
      const listed = [...cat.split("\nBACKGROUNDS (")[0].matchAll(/^- ([a-z0-9-]+) · /gm)].map((m) => m[1]);
      expect(new Set(listed)).toEqual(new Set(own.map((l) => l.id)));
      for (const l of own) {
        const line = cat.split("\n").find((x) => x.startsWith(`- ${l.id} · `)) as string;
        expect(line).toContain(`${l.photoCount} photo`);
        expect(line).toContain(" · slots: 1 ");
        expect(line).toMatch(/ · text: /);
        if (l.role !== "cover") expect(line).toMatch(/ · caption (yes|no)/);
        expect(line.match(/prefers /g)?.length).toBe(l.photoCount);
      }
    }
  });

  it("shape hints: circles want square-ish photos; scrapbook overlaps are named; geometric shapes never 'overlap'", () => {
    const geoP = layoutCatalogue({ format: "A5_PORTRAIT", designStyle: "geometric" });
    expect(geoP).toMatch(/- g-p-two-circle · .*circle \(round crop: a square-ish photo with a centred subject\)/);
    expect(geoP).toMatch(/- g-p-three-diamond · .*diamond/);
    expect(geoP).toMatch(/- g-p-five-hex · .*hexagon/);
    expect(geoP).not.toContain("partly under");
    const scrapP = layoutCatalogue({ format: "A5_PORTRAIT", designStyle: "scrapbook" });
    expect(scrapP).toMatch(/- s-p-two-overlap · .*1 tilted polaroid, medium, prefers portrait, partly under slot 2/);
    expect(scrapP).toMatch(/- s-p-spread-wall · "6 taped photos across two pages" · 6 photos · .*occupies 2 pages, must start on a left page/);
    expect(scrapP).toMatch(/- s-p-four-pinned · .*bordered print/);
    expect(storytellerSystemText({ format: "A5_PORTRAIT", designStyle: "geometric" })).toContain("Geometric layouts cut photos into shapes");
    expect(storytellerSystemText({ format: "A5_PORTRAIT", designStyle: "scrapbook" })).toContain("Scrapbook layouts show photos as tilted prints");
    // No panorama in these styles.
    for (const d of NEW4) expect(storytellerSystemText(d)).not.toContain("panorama");
  });

  it("BACKGROUNDS catalogue = AI_BACKGROUND_CATALOGUE per style (modern/geometric/scrapbook); faded photo only in scrapbook; classic none", () => {
    for (const style of ["modern", "geometric", "scrapbook"] as const) {
      const ids = [...backgroundCatalogue(style).matchAll(/^- ([a-z0-9-]+) · /gm)].map((m) => m[1]);
      expect(ids).toEqual([...AI_BACKGROUND_CATALOGUE[style]]);
      for (const format of FORMATS) {
        const t = storytellerSystemText({ format, designStyle: style });
        expect(t).toContain("14. Backgrounds:");
        expect(t).toContain("colour (the photo's muted main colour as #RRGGBB, or unknown)");
        if (style === "scrapbook") expect(t).toContain(`15. Faded photo (scrapbook only): backgroundId "${FADED_PHOTO_ID}"`);
        else expect(t).not.toContain(FADED_PHOTO_ID);
      }
    }
    expect(backgroundCatalogue("classic")).toBe("");
    for (const format of FORMATS) {
      const t = storytellerSystemText({ format, designStyle: "classic" });
      expect(t).not.toMatch(/BACKGROUNDS|backgroundId|colour/);
    }
  });
});

// ------------------------------------------------------------------------------------------ user message / schema

function photoSet(n: number, colours: (string | null)[] = ["#C9A27E", "#b88a6a", null]): StoryPhoto[] {
  return Array.from({ length: n }, (_, i) => {
    const land = (i + 1) % 3 === 0;
    return {
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      width: land ? 4032 : 3024,
      height: land ? 3024 : 4032,
      takenAt: new Date(Date.parse("2026-10-12T10:00:00+04:00") + Math.floor(i / 12) * 86_400_000 + (i % 12) * 600_000).toISOString(),
      place: null,
      keep: true,
      analysis: { description: "a photo", scene: "group", mood: "joyful", quality: 7, coverWorthy: i === 0 },
      color: colours[i % colours.length],
      blurScore: 500 + i,
    };
  });
}

describe("Storyteller v6 request", () => {
  it("photo lines carry `colour #RRGGBB` (upper case) / `colour unknown` only for styles with AI backgrounds", () => {
    const [a, , c] = photoSet(3, ["#c9a27e", null, "red"]);
    expect(photoLine("p1", a, true)).toMatch(/ · place null · colour #C9A27E · "a photo"$/);
    expect(photoLine("p3", c, true)).toContain(" · colour unknown · ");
    expect(photoLine("p1", a)).not.toContain("colour");
    const photos = photoSet(6);
    const { aliasOf } = aliasMaps(photos);
    for (const d of ALL8) {
      const req = buildStorytellerRequest({ photos, book: storyBook(), aliasOf, design: d });
      const msg = String(req.messages[0].content);
      if (d.designStyle === "classic") expect(msg).not.toContain("colour");
      else expect(msg).toContain("colour #C9A27E");
    }
  });

  it("schema per style: classic = AlbumPlanAiSchema (unchanged), modern/geometric = backgrounds, scrapbook = + backgroundPhotoId", () => {
    expect(albumPlanAiSchemaFor("classic")).toBe(AlbumPlanAiSchema);
    expect(albumPlanAiSchemaFor("modern")).toBe(AlbumPlanBackgroundsAiSchema);
    expect(albumPlanAiSchemaFor("geometric")).toBe(AlbumPlanBackgroundsAiSchema);
    expect(albumPlanAiSchemaFor("scrapbook")).toBe(AlbumPlanScrapbookAiSchema);
    for (const schema of [AlbumPlanBackgroundsAiSchema, AlbumPlanScrapbookAiSchema]) {
      const f = zodOutputFormat(schema);
      expect(f.schema.additionalProperties).toBe(false);
      expect(JSON.stringify(f.schema)).not.toMatch(/"(minimum|maximum|minLength|maxLength)"/);
      expect(JSON.stringify(f.schema)).toContain("bookBackgroundId");
    }
    expect(JSON.stringify(zodOutputFormat(AlbumPlanScrapbookAiSchema).schema)).toContain("backgroundPhotoId");
    expect(JSON.stringify(zodOutputFormat(AlbumPlanBackgroundsAiSchema).schema)).not.toContain("backgroundPhotoId");
    expect(JSON.stringify(zodOutputFormat(AlbumPlanAiSchema).schema)).not.toContain("ackground");
  });

  it("strict schema: background fields are optional and never fail a plan (junk → undefined, null stays null)", () => {
    const base = {
      title: "T",
      subtitle: "",
      coverPhotoId: "p1",
      moments: [{ id: "m1", title: "A", dateLabel: "", place: null, pages: [{ layoutId: "x", photoIds: ["p1"] }] }],
    };
    const plain = AlbumPlanStrictSchema.parse(base);
    expect(plain.bookBackgroundId).toBeUndefined();
    expect(plain.moments[0].backgroundId).toBeUndefined();
    const junk = AlbumPlanStrictSchema.parse({
      ...base,
      bookBackgroundId: 42,
      moments: [{ ...base.moments[0], backgroundId: "Not An Id!", backgroundPhotoId: "photo-7" }],
    });
    expect(junk.bookBackgroundId).toBeUndefined();
    expect(junk.moments[0].backgroundId).toBeUndefined();
    expect(junk.moments[0].backgroundPhotoId).toBeNull();
    const ok = AlbumPlanStrictSchema.parse({ ...base, bookBackgroundId: null, moments: [{ ...base.moments[0], backgroundId: " sage ", backgroundPhotoId: "p4" }] });
    expect(ok.bookBackgroundId).toBeNull();
    expect(ok.moments[0]).toMatchObject({ backgroundId: "sage", backgroundPhotoId: "p4" });
  });

  it("agent_steps: picks are logged as ids/aliases, colours never (input summary = a count)", async () => {
    const photos = photoSet(24);
    const { aliasOf } = aliasMaps(photos);
    const rows: AgentStepRecord[] = [];
    const logger: StepLogger = { insertStep: async (r) => void rows.push(r), addRunTotals: async () => undefined };
    const r = await planAlbum({
      runId: RUN_ID,
      stepKey: "storyteller",
      attempt: 1,
      photos,
      book: storyBook(),
      aliasOf,
      transport: new ReplayTransport({ scenario: "ok", fixturesDir: "/nonexistent" }),
      logger,
      design: { format: "A5_PORTRAIT", designStyle: "scrapbook" },
    });
    expect(r.ok).toBe(true);
    const logged = JSON.stringify(rows);
    expect(logged.toUpperCase()).not.toContain("#C9A27E");
    expect(logged.toUpperCase()).not.toContain("#B88A6A");
    expect(rows[0].inputSummary).toMatchObject({ promptVersion: 6, photosWithColour: 16 });
    if (r.ok) expect(planLogOutput(r.data)).toHaveProperty("bookBg");
  });
});

// ------------------------------------------------------------------------------------------ replay builds + plan-to-doc

const book20 = storyBook({ maxPages: 20 });

function build(design: BookDesign, photos: StoryPhoto[], plan?: AlbumPlan) {
  const { aliasOf, aliasToId } = aliasMaps(photos);
  const req = buildStorytellerRequest({ photos, book: book20, aliasOf, design });
  const p = plan ?? (AlbumPlanStrictSchema.parse(synthAlbumPlan(req.scenarioMeta as never)) as AlbumPlan);
  const out = planToDoc(p, { aliasToId, photos, book: book20, runId: RUN_ID, generatorVersion: STORYTELLER_PROMPT_VERSION, design });
  return { out, plan: p, aliasToId, aliasOf };
}

function docOf(r: ReturnType<typeof build>["out"]): BookDoc {
  if (!("doc" in r)) throw new Error(`issues: ${r.issues.join("; ")}`);
  return r.doc;
}

describe("replay builds for the 4 new designs (v6)", () => {
  for (const design of NEW4) {
    it(`${design.format}/${design.designStyle}: synthesised plan → valid doc with catalogue backgrounds, AI picks applied`, () => {
      const photos = photoSet(30);
      const r = build(design, photos);
      const doc = docOf(r.out);
      const kept = new Set(photos.map((p) => p.id));
      expect(validateBookDoc(doc, { photoIds: kept, maxPages: 20 })).toEqual([]);
      expect(isSpreadAligned(doc)).toBe(true);
      for (const id of [doc.cover.layout, ...doc.pages.map((p) => p.layout)]) {
        expect(getLayout(id)).toMatchObject({ format: design.format, style: design.designStyle });
      }
      expect(doc.meta?.generatorVersion).toBe(6);
      expect(doc.style.backgroundSource).toBe("ai");
      expect(isValidAiBackground(design.designStyle, doc.style.background, { scope: "book" })).toBe(true);
      // The replay plan carried picks; the book pick is honoured.
      expect(typeof r.plan.bookBackgroundId).toBe("string");
      expect(r.plan.moments.some((m) => m.backgroundId !== undefined)).toBe(true);
      for (const p of doc.pages) if (p.background) expect(p.background.source).toBe("ai");
      if (design.designStyle === "scrapbook") {
        const faded = doc.pages.filter((p) => p.background?.kind === "photo");
        expect(faded.length).toBeGreaterThan(0);
        for (const p of faded) {
          const pid = (p.background as { photoId: string }).photoId;
          expect(kept.has(pid)).toBe(true);
          expect(p.slots.some((s) => s.photoId === pid)).toBe(false);
          expect(doc.pages.filter((x) => x.chapterId === p.chapterId).some((x) => x.slots.some((s) => s.photoId === pid))).toBe(true);
        }
      } else {
        expect(doc.pages.every((p) => p.background?.kind !== "photo")).toBe(true);
      }
    });
  }

  it("classic designs: background fields in a plan are ignored; doc identical to a plan without them (white, no source)", () => {
    for (const format of FORMATS) {
      const design: BookDesign = { format, designStyle: "classic" };
      const photos = photoSet(20);
      const base = build(design, photos);
      const withPicks = { ...base.plan, bookBackgroundId: "sage", moments: base.plan.moments.map((m) => ({ ...m, backgroundId: "blush" })) };
      const again = build(design, photos, withPicks);
      expect(docOf(again.out)).toEqual(docOf(base.out));
      expect(docOf(base.out).style).toEqual({ background: { kind: "color", hex: "#FFFFFF" }, designStyle: "classic", font: "Playfair" });
    }
  });
});

describe("plan-to-doc background picks (12b)", () => {
  const SCRAP: BookDesign = { format: "A5_PORTRAIT", designStyle: "scrapbook" };
  const GEO: BookDesign = { format: "A5_PORTRAIT", designStyle: "geometric" };

  /** Two moments of single pages: m1 = p1 | p2,p3 ; m2 = p4 | p5 — with p6 dropped. */
  function scrapPhotos(): StoryPhoto[] {
    const ps = photoSet(6).map((p) => ({ ...p, width: 3024, height: 4032 }));
    ps[5] = { ...ps[5], keep: false };
    return ps;
  }
  const scrapPlan = (o: Partial<AlbumPlan["moments"][number]> = {}, top: Partial<AlbumPlan> = {}): AlbumPlan => ({
    title: "T",
    subtitle: "",
    coverPhotoId: "p1",
    ...top,
    moments: [
      { id: "m1", title: "A", dateLabel: "", place: null, pages: [{ layoutId: "s-p-one-polaroid", photoIds: ["p1"] }, { layoutId: "s-p-two-overlap", photoIds: ["p2", "p3"] }], ...o },
      { id: "m2", title: "B", dateLabel: "", place: null, pages: [{ layoutId: "s-p-one-polaroid", photoIds: ["p4"] }, { layoutId: "s-p-one-polaroid", photoIds: ["p5"] }], backgroundId: null },
    ],
  });
  const openerBg = (doc: BookDoc, chapterId: string) => doc.pages.find((p) => p.chapterId === chapterId)?.background;

  it("a valid faded-photo pick (kept photo, other page of the same moment) is applied as is", () => {
    const photos = scrapPhotos();
    const doc = docOf(build(SCRAP, photos, scrapPlan({ backgroundId: FADED_PHOTO_ID, backgroundPhotoId: "p3" })).out);
    expect(openerBg(doc, "c1")).toMatchObject({ kind: "photo", photoId: photos[2].id, source: "ai" });
    // m2 said null → the rules add nothing there.
    expect(openerBg(doc, "c2")).toBeUndefined();
  });

  it("an AI pick pointing at a DROPPED photo is rejected → rule fallback (a kept photo, never the dropped one)", () => {
    const photos = scrapPhotos();
    const { aliasToId } = aliasMaps(photos);
    const plan = scrapPlan({ backgroundId: FADED_PHOTO_ID, backgroundPhotoId: "p6" });
    const built = build(SCRAP, photos, plan);
    const doc = docOf(built.out);
    const picks = backgroundPicksOf(plan, { aliasToId, photos, design: SCRAP, doc });
    expect(picks.chapters?.has("c1")).toBe(false);
    const bg = openerBg(doc, "c1");
    expect(bg).toMatchObject({ kind: "photo", source: "ai" }); // T11 rule faded photo
    expect((bg as { photoId: string }).photoId).not.toBe(photos[5].id);
    expect([photos[1].id, photos[2].id]).toContain((bg as { photoId: string }).photoId);
    expect(JSON.stringify(doc)).not.toContain(photos[5].id);
  });

  it("foreign / unknown / other-moment / on-the-opener aliases are rejected too", () => {
    const photos = scrapPhotos();
    for (const alias of ["p999", "p4", "p1"]) {
      const doc = docOf(build(SCRAP, photos, scrapPlan({ backgroundId: FADED_PHOTO_ID, backgroundPhotoId: alias })).out);
      const bg = openerBg(doc, "c1") as { photoId: string } | undefined;
      expect(bg?.photoId).not.toBe(photos[3].id);
      expect(bg?.photoId).not.toBe(photos[0].id);
      if (bg) expect([photos[1].id, photos[2].id]).toContain(bg.photoId);
    }
  });

  it("invalid ids → rules: unknown / other-style / faded-photo outside scrapbook / faded-photo as the book background", () => {
    const photos = photoSet(12, ["#C9A27E"]);
    const g = build(GEO, photos);
    const bad = {
      ...g.plan,
      bookBackgroundId: "kraft", // scrapbook-only texture
      moments: g.plan.moments.map((m) => ({ ...m, backgroundId: FADED_PHOTO_ID, backgroundPhotoId: m.pages[0].photoIds[0] })),
    };
    const doc = docOf(build(GEO, photos, bad).out);
    expect(doc.style.background).toEqual(suggestBookBackground("geometric", photos.map((p) => p.color ?? null)));
    expect(doc.pages.every((p) => p.background === undefined)).toBe(true);
    const sp = scrapPhotos();
    const scrapBookFaded = docOf(build(SCRAP, sp, scrapPlan({}, { bookBackgroundId: FADED_PHOTO_ID })).out);
    expect(scrapBookFaded.style.background.kind).not.toBe("photo");
  });

  it("a valid colour pick lands on the moment's opener only; the book pick wins over the colour vote", () => {
    const photos = photoSet(12, ["#C9A27E"]);
    const g = build(GEO, photos);
    const plan = { ...g.plan, bookBackgroundId: "stone", moments: g.plan.moments.map((m, i) => ({ ...m, backgroundId: i === 0 ? "sky" : null })) };
    const doc = docOf(build(GEO, photos, plan).out);
    expect(doc.style.background).toEqual({ kind: "color", hex: "#CFCBC4" });
    expect(doc.pages[0].background).toEqual({ kind: "color", hex: "#CFE1F0", source: "ai" });
    expect(doc.pages.slice(1).every((p) => p.background === undefined)).toBe(true);
  });

  it("a moment that opens with a spread gets no page background (one half must not differ from the other)", () => {
    const photos = photoSet(8).map((p) => ({ ...p, width: 3024, height: 4032 }));
    const plan: AlbumPlan = {
      title: "T",
      subtitle: "",
      coverPhotoId: "p1",
      bookBackgroundId: "paper-white",
      moments: [
        {
          id: "m1",
          title: "A",
          dateLabel: "",
          place: null,
          pages: [{ layoutId: "s-p-spread-wall", photoIds: ["p1", "p2", "p3", "p4", "p5", "p6"] }, { layoutId: "s-p-two-overlap", photoIds: ["p7", "p8"] }],
          backgroundId: "blush",
        },
      ],
    };
    const doc = docOf(build(SCRAP, photos, plan).out);
    expect(doc.pages[0].side).toBe("left");
    expect(doc.pages[0].background).toBeUndefined();
    expect(doc.style.background).toEqual({ kind: "texture", textureId: "paper-white" });
  });

  it("plans without picks (v5 plans resumed after deploy) → pure T11 rules", () => {
    const photos = scrapPhotos();
    const doc = docOf(build(SCRAP, photos, scrapPlan({}, {})).out);
    expect(doc.style.backgroundSource).toBe("ai");
    expect(openerBg(doc, "c1")).toMatchObject({ kind: "photo", source: "ai" });
  });
});

// ------------------------------------------------------------------------------------------ cost / caching

describe("cost per run unchanged; 8 prefixes = cache writes only on first use", () => {
  it("replay usage: first call per design writes the cache, later calls of that design read it; max tokens/effort unchanged", async () => {
    const t = new ReplayTransport({ scenario: "ok", fixturesDir: "/nonexistent" });
    const photos = photoSet(24);
    const { aliasOf } = aliasMaps(photos);
    const classicReq = buildStorytellerRequest({ photos, book: book20, aliasOf });
    for (const d of ALL8) {
      const req = buildStorytellerRequest({ photos, book: book20, aliasOf, design: d });
      expect(req.maxTokens).toBe(classicReq.maxTokens);
      expect(req.effort).toBe(classicReq.effort);
      const first = await t.parse(req);
      const second = await t.parse(buildStorytellerRequest({ photos, book: book20, aliasOf, design: d }));
      expect(first.usage.cacheWrite).toBeGreaterThan(0);
      expect(first.usage.cacheRead).toBe(0);
      expect(second.usage.cacheWrite).toBe(0);
      expect(second.usage.cacheRead).toBe(first.usage.cacheWrite);
      expect(first.parsed).not.toBeNull();
    }
  });
});
