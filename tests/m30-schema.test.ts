// M30 T1 (D-090) — data model for the magazine / editorial styles: design styles + colourways,
// chapter descriptions, layout blocks, text ink / quarter turns / new bindings and font roles, the
// v2 serialisation rule (docs without the new fields stay byte-identical) and the public snapshot.
// Schema only: no layouts, renderer, UI or AI in this task.

import { describe, expect, it } from "vitest";
import { SUPPORTED_DESIGN_STYLES } from "@/lib/book/book-design";
import { serializeDoc, upgradeDocV1, usesV2Features } from "@/lib/book/doc-version";
import {
  BLOCK_FILLS,
  BookDocSchema,
  BookDocV1Schema,
  CHAPTER_DESCRIPTION_MAX,
  COLOURWAY_IDS,
  DESIGN_STYLES,
  EDITORIAL_COLOURWAY_IDS,
  layoutIssues,
  LayoutSchema,
  LayoutTextSchema,
  MAGAZINE_COLOURWAY_IDS,
  MAX_LAYOUT_BLOCKS,
  parseBookDoc,
  SLOT_ROTATE_MAX,
  STYLE_COLOURWAY_IDS,
  TEXT_BINDINGS,
  TEXT_FONT_ROLES,
  TEXT_INKS,
  validateBookDoc,
} from "@/lib/book/schema";
import { pageMm } from "@/lib/book/format";
import { layoutsFor } from "@/lib/book/spreads";
import type { BookDoc, ChapterDescription, ColourwayId, DesignStyle, Layout, LayoutBlock, LayoutText } from "@/lib/book/types";
import { STYLE_TOKENS, TEXT_ROLES } from "@/lib/design/styles";
import { LAYOUTS, SAFE_MM } from "@/lib/layouts";
import { parsePublicDoc, publicDocToRenderDoc, toPublicDoc } from "@/lib/publish/public-doc";
import { representativeDocV1 } from "./golden/m9-inputs";

const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DESCRIPTION: ChapterDescription = { text: "A slow morning by the water, coffee going cold.", source: "ai" };

/** A valid book of `style` (A5 portrait): auto cover + one filled page of the style. */
function docFor(style: "classic" | "modern" | "geometric" | "scrapbook"): BookDoc {
  const cover = layoutsFor("A5_PORTRAIT", style, "cover")[0]!;
  const page = layoutsFor("A5_PORTRAIT", style, "page").find((l) => l.photoCount === 1)!;
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: { layout: cover.id, photoId: pid(1), title: "Oman road trip", subtitle: "2026" },
    chapters: [
      { id: "c1", title: "Muscat", dateLabel: "March 2026", place: "Muscat" },
      { id: "c2", title: "Nizwa", dateLabel: "March 2026", place: null },
    ],
    pages: [{ id: "pg0", chapterId: "c1", layout: page.id, slots: [{ photoId: pid(10), crop: { x: 0.5, y: 0.5, zoom: 1 } }], caption: null }],
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: style, font: "Playfair" },
  };
}
const photoIdsOf = (d: BookDoc) => new Set([d.cover.photoId!, ...d.pages.flatMap((p) => p.slots.map((s) => s.photoId!))]);
const validate = (d: BookDoc) => validateBookDoc(d, { photoIds: photoIdsOf(d), maxPages: 20 });
const withDescription = (d: BookDoc, description = DESCRIPTION): BookDoc => ({
  ...d,
  chapters: d.chapters.map((c, i) => (i === 0 ? { ...c, description } : c)),
});
const withColourway = (d: BookDoc, id: ColourwayId, style?: DesignStyle): BookDoc => ({
  ...d,
  style: { ...d.style, ...(style ? { designStyle: style } : {}), colourway: { id, source: "ai" } },
});

// Real catalogue layouts as bases for the layout rules (their own data is valid).
const plain = (l: Layout) => !l.texts?.length && !l.decorations?.length;
const PAGE = LAYOUTS.find((l) => l.role === "page" && l.format === "A5_PORTRAIT" && plain(l))!;
const COVER = LAYOUTS.find((l) => l.role === "cover" && l.format === "A5_PORTRAIT" && l.style === "classic")!;
const SPREAD = LAYOUTS.find((l) => l.role === "spread" && l.format === "A5_PORTRAIT")!;
const PAGE_COVER_ID = COVER.id;
const text = (over: Partial<LayoutText> = {}): LayoutText => ({
  bind: "chapterTitle",
  box: { x: 10, y: 10, w: 40, h: 10 },
  align: "start",
  font: "chapter",
  ...over,
});
const block = (over: Partial<LayoutBlock> = {}): LayoutBlock => ({ box: { x: 0, y: 60, w: 100, h: 40 }, fill: "panel", layer: "under", ...over });
const TRIANGLE: [number, number][] = [
  [0, 0],
  [100, 0],
  [0, 100],
];

describe("M30 design styles + font roles", () => {
  it("DESIGN_STYLES gains magazine + editorial; they are not supported (no layouts) yet", () => {
    expect([...DESIGN_STYLES]).toEqual(["classic", "modern", "geometric", "scrapbook", "magazine", "editorial"]);
    expect([...SUPPORTED_DESIGN_STYLES]).toEqual(["classic", "modern", "geometric", "scrapbook"]);
    expect(LAYOUTS.some((l) => l.style === "magazine" || l.style === "editorial")).toBe(false);
  });

  it("font roles: masthead + body in both lists; pre-M30 styles map masthead → title, body → caption", () => {
    expect([...TEXT_FONT_ROLES]).toEqual(["title", "subtitle", "year", "chapter", "caption", "masthead", "body"]);
    expect([...TEXT_ROLES]).toEqual([...TEXT_FONT_ROLES]);
    for (const s of ["classic", "modern", "geometric", "scrapbook"] as const) {
      expect(STYLE_TOKENS[s].fonts.masthead, s).toEqual(STYLE_TOKENS[s].fonts.title);
      expect(STYLE_TOKENS[s].fonts.body, s).toEqual(STYLE_TOKENS[s].fonts.caption);
    }
    for (const s of DESIGN_STYLES) for (const r of TEXT_ROLES) expect(STYLE_TOKENS[s].fonts[r], `${s}/${r}`).toBeDefined();
  });

  it("no shipped layout uses the new roles, bindings, ink, blocks or quarter turns (no render change)", () => {
    for (const l of LAYOUTS) {
      expect(l.blocks, l.id).toBeUndefined();
      for (const t of l.texts ?? []) {
        expect(["masthead", "body"], l.id).not.toContain(t.font);
        expect(["chapterDescription", "coverLine"], l.id).not.toContain(t.bind);
        expect(t.ink, l.id).toBeUndefined();
        expect(t.n, l.id).toBeUndefined();
        expect(Math.abs(t.rotate ?? 0), l.id).toBeLessThanOrEqual(SLOT_ROTATE_MAX);
      }
    }
  });

  it("colourway id lists", () => {
    expect([...MAGAZINE_COLOURWAY_IDS]).toEqual(["lime", "sunset", "sky", "coral", "teal", "gold"]);
    expect([...EDITORIAL_COLOURWAY_IDS]).toEqual(["ink", "teal", "coral", "cobalt", "mustard", "forest"]);
    expect([...COLOURWAY_IDS].sort()).toEqual([...new Set([...MAGAZINE_COLOURWAY_IDS, ...EDITORIAL_COLOURWAY_IDS])].sort());
    expect(new Set(COLOURWAY_IDS).size).toBe(COLOURWAY_IDS.length);
    expect(STYLE_COLOURWAY_IDS.magazine).toEqual(MAGAZINE_COLOURWAY_IDS);
    expect(STYLE_COLOURWAY_IDS.editorial).toEqual(EDITORIAL_COLOURWAY_IDS);
    for (const s of ["classic", "modern", "geometric", "scrapbook"] as const) expect(STYLE_COLOURWAY_IDS[s]).toEqual([]);
  });
});

describe("M30 doc fields: shape", () => {
  it("chapter description: text 1..400, not blank, source ai|user, strict", () => {
    const ok = (description: unknown) => BookDocSchema.safeParse({ ...docFor("modern"), chapters: [{ id: "c1", title: "T", dateLabel: "D", place: null, description }] }).success;
    expect(ok(DESCRIPTION)).toBe(true);
    expect(ok({ text: "وصف قصير", source: "user" })).toBe(true);
    expect(ok({ text: "x".repeat(CHAPTER_DESCRIPTION_MAX), source: "ai" })).toBe(true);
    expect(CHAPTER_DESCRIPTION_MAX).toBe(400);
    expect(ok({ text: "x".repeat(CHAPTER_DESCRIPTION_MAX + 1), source: "ai" })).toBe(false);
    expect(ok({ text: "", source: "ai" })).toBe(false);
    expect(ok({ text: "   ", source: "ai" })).toBe(false);
    expect(ok({ text: "half \ud83d", source: "ai" })).toBe(false);
    expect(ok({ text: "ok", source: "auto" })).toBe(false);
    expect(ok({ text: "ok" })).toBe(false);
    expect(ok({ text: "ok", source: "ai", extra: 1 })).toBe(false);
    expect(ok("plain string")).toBe(false);
  });

  it("the v1 chapter schema is unchanged: a v1 doc with a description key drops it on read (as any unknown key)", () => {
    const v1 = representativeDocV1();
    const r = BookDocV1Schema.safeParse({ ...v1, chapters: v1.chapters.map((c) => ({ ...c, description: DESCRIPTION })) });
    expect(r.success).toBe(true);
    if (r.success) for (const c of r.data.chapters) expect(Object.keys(c)).toEqual(["id", "title", "dateLabel", "place"]);
  });

  it("style.colourway: known id + source ai|user, strict", () => {
    const ok = (colourway: unknown) => BookDocSchema.safeParse({ ...docFor("modern"), style: { ...docFor("modern").style, designStyle: "magazine", colourway } }).success;
    for (const id of COLOURWAY_IDS) expect(ok({ id, source: "ai" }), id).toBe(true);
    expect(ok({ id: "lime", source: "user" })).toBe(true);
    expect(ok({ id: "purple", source: "ai" })).toBe(false);
    expect(ok({ id: "lime", source: "auto" })).toBe(false);
    expect(ok({ id: "lime" })).toBe(false);
    expect(ok({ id: "lime", source: "ai", hex: "#00FF00" })).toBe(false);
    expect(ok("lime")).toBe(false);
  });
});

describe("M30 validateBookDoc: colourway belongs to the design style", () => {
  const colourwayIssues = (d: BookDoc) => validate(d).filter((i) => i.startsWith("style.colourway"));

  it("magazine / editorial accept their own ids only", () => {
    const base = docFor("modern");
    for (const id of MAGAZINE_COLOURWAY_IDS) expect(colourwayIssues(withColourway(base, id, "magazine")), id).toEqual([]);
    for (const id of EDITORIAL_COLOURWAY_IDS) expect(colourwayIssues(withColourway(base, id, "editorial")), id).toEqual([]);
    expect(colourwayIssues(withColourway(base, "ink", "magazine"))).toEqual(['style.colourway: "ink" is not a magazine colourway']);
    expect(colourwayIssues(withColourway(base, "lime", "editorial"))).toEqual(['style.colourway: "lime" is not a editorial colourway']);
    // Shared ids are valid in both styles.
    for (const id of ["teal", "coral"] as const) {
      expect(colourwayIssues(withColourway(base, id, "magazine"))).toEqual([]);
      expect(colourwayIssues(withColourway(base, id, "editorial"))).toEqual([]);
    }
  });

  it("classic / modern / geometric / scrapbook reject any colourway (also with designStyle absent = classic)", () => {
    for (const s of ["classic", "modern", "geometric", "scrapbook"] as const) {
      const d = docFor(s);
      expect(validate(d), s).toEqual([]);
      for (const id of COLOURWAY_IDS) expect(validate(withColourway(d, id)), `${s}/${id}`).toEqual([`style.colourway: "${id}" is not a ${s} colourway`]);
    }
    const classic = docFor("classic");
    const noStyle: BookDoc = { ...classic, style: { background: classic.style.background, font: classic.style.font, colourway: { id: "teal", source: "user" } } };
    expect(validate(noStyle)).toEqual(['style.colourway: "teal" is not a classic colourway']);
  });

  it("a description needs no semantic check: valid on any style", () => {
    for (const s of ["classic", "modern", "geometric", "scrapbook"] as const) expect(validate(withDescription(docFor(s))), s).toEqual([]);
  });
});

describe("M30 serialisation: v2 features", () => {
  it("a doc with neither field serialises byte-identically (v1 stays v1, key for key)", () => {
    const v1 = representativeDocV1();
    const doc = upgradeDocV1(v1);
    expect(usesV2Features(doc)).toBe(false);
    expect(JSON.stringify(serializeDoc(doc))).toBe(JSON.stringify(v1));
    // An explicit `description: undefined` / `colourway: undefined` is the same as absent.
    const undef: BookDoc = {
      ...doc,
      chapters: doc.chapters.map((c) => ({ ...c, description: undefined })),
      style: { ...doc.style, colourway: undefined },
    };
    expect(usesV2Features(undef)).toBe(false);
    const out = serializeDoc(undef);
    expect(JSON.stringify(out)).toBe(JSON.stringify(v1));
    for (const c of out.chapters) expect(Object.keys(c)).toEqual(["id", "title", "dateLabel", "place"]);
    expect(Object.keys(out.style)).toEqual(["background", "font"]);
  });

  it("a v2 doc with neither field serialises exactly as before M30 (no new keys, same order)", () => {
    const doc = docFor("modern");
    const out = serializeDoc({ ...doc, chapters: doc.chapters.map((c) => ({ ...c, description: undefined })), style: { ...doc.style, colourway: undefined } });
    expect(JSON.stringify(out)).toBe(JSON.stringify(doc));
    expect(JSON.stringify(serializeDoc(doc))).toBe(JSON.stringify(doc));
    expect(JSON.stringify(out)).not.toMatch(/description|colourway/);
    expect(out.chapters.map((c) => Object.keys(c))).toEqual([
      ["id", "title", "dateLabel", "place"],
      ["id", "title", "dateLabel", "place"],
    ]);
    expect(Object.keys(out.style)).toEqual(["background", "designStyle", "font"]);
  });

  it("a chapter description forces v2 and round-trips", () => {
    const doc = withDescription(upgradeDocV1(representativeDocV1()), { text: "نزهة هادئة على الشاطئ", source: "user" });
    expect(usesV2Features(doc)).toBe(true);
    const out = serializeDoc(doc);
    expect(out.version).toBe(2);
    expect(out.chapters[0]).toEqual({ ...doc.chapters[0], description: { text: "نزهة هادئة على الشاطئ", source: "user" } });
    expect(Object.keys(out.chapters[0]!)).toEqual(["id", "title", "dateLabel", "place", "description"]);
    for (const c of out.chapters.slice(1)) expect(c).not.toHaveProperty("description");
    const back = parseBookDoc(JSON.parse(JSON.stringify(out)));
    expect(back.ok && back.doc.chapters[0]!.description).toEqual({ text: "نزهة هادئة على الشاطئ", source: "user" });
    expect(back.ok && JSON.stringify(serializeDoc(back.doc))).toBe(JSON.stringify(out));
    // Fresh objects: never aliases the input.
    expect((out as BookDoc).chapters[0]!.description).not.toBe(doc.chapters[0]!.description);
  });

  it("a colourway forces v2 and round-trips", () => {
    const base = upgradeDocV1(representativeDocV1());
    const doc: BookDoc = { ...base, style: { ...base.style, colourway: { id: "sunset", source: "ai" } } };
    expect(usesV2Features(doc)).toBe(true);
    const out = serializeDoc(doc) as BookDoc;
    expect(out.version).toBe(2);
    expect(out.style.colourway).toEqual({ id: "sunset", source: "ai" });
    expect(out.style.colourway).not.toBe(doc.style.colourway);
    const back = parseBookDoc(JSON.parse(JSON.stringify(out)));
    expect(back.ok && back.doc.style.colourway).toEqual({ id: "sunset", source: "ai" });
    expect(back.ok && JSON.stringify(serializeDoc(back.doc))).toBe(JSON.stringify(out));
  });
});

describe("M30 public snapshot", () => {
  it("without the new fields the snapshot has no new keys (v1 and v2)", () => {
    const v1 = toPublicDoc(upgradeDocV1(representativeDocV1()));
    expect(v1.version).toBe(1);
    expect(JSON.stringify(v1)).not.toMatch(/description|colourway/);
    const v2 = toPublicDoc(docFor("modern"));
    expect(v2.version).toBe(2);
    expect(JSON.stringify(v2)).not.toMatch(/description|colourway/);
    expect(v2.chapters.map((c) => Object.keys(c))).toEqual([
      ["id", "title", "dateLabel"],
      ["id", "title", "dateLabel"],
    ]);
    expect(Object.keys(v2.style)).toEqual(["background", "designStyle", "font"]);
  });

  it("description is published as text only, colourway as id only (source dropped)", () => {
    const doc = withColourway(withDescription(docFor("modern"), { text: DESCRIPTION.text, source: "user" }), "coral", "magazine");
    const pub = toPublicDoc(doc);
    expect(pub.version).toBe(2);
    if (pub.version !== 2) return;
    expect(pub.chapters[0]).toEqual({ id: "c1", title: "Muscat", dateLabel: "March 2026", description: { text: DESCRIPTION.text } });
    expect(pub.chapters[1]).toEqual({ id: "c2", title: "Nizwa", dateLabel: "March 2026" });
    expect(pub.style.colourway).toEqual({ id: "coral" });
    expect(JSON.stringify(pub)).not.toContain("source");
    expect(parsePublicDoc(JSON.parse(JSON.stringify(pub)))).toEqual({ ok: true, doc: pub });

    const render = publicDocToRenderDoc(pub);
    expect(render.chapters[0]!.description).toEqual({ text: DESCRIPTION.text, source: "user" });
    expect(render.chapters[1]).not.toHaveProperty("description");
    expect(render.style.colourway).toEqual({ id: "coral", source: "user" });
    expect(BookDocSchema.safeParse(render).success).toBe(true);
  });

  it("strict: a `source` inside either field, or the fields on a v1 snapshot, reject the snapshot", () => {
    const pub = JSON.parse(JSON.stringify(toPublicDoc(withColourway(withDescription(docFor("modern")), "coral", "magazine"))));
    expect(parsePublicDoc(pub).ok).toBe(true);
    const a = structuredClone(pub);
    a.chapters[0].description.source = "ai";
    expect(parsePublicDoc(a).ok).toBe(false);
    const b = structuredClone(pub);
    b.style.colourway.source = "ai";
    expect(parsePublicDoc(b).ok).toBe(false);
    const c = structuredClone(pub);
    c.style.colourway.id = "purple";
    expect(parsePublicDoc(c).ok).toBe(false);
    const d = structuredClone(pub);
    d.chapters[0].description.text = "";
    expect(parsePublicDoc(d).ok).toBe(false);

    const v1 = JSON.parse(JSON.stringify(toPublicDoc(upgradeDocV1(representativeDocV1()))));
    expect(parsePublicDoc(v1).ok).toBe(true);
    const e = structuredClone(v1);
    e.chapters[0].description = { text: "x" };
    expect(parsePublicDoc(e).ok).toBe(false);
    const f = structuredClone(v1);
    f.style.colourway = { id: "lime" };
    expect(parsePublicDoc(f).ok).toBe(false);
  });

  it("old snapshots (literal pre-M30 JSON, v1 and v2) still parse and render without the fields", () => {
    const oldV1 = {
      version: 1,
      format: "A5_PORTRAIT",
      cover: { layout: PAGE_COVER_ID, photoId: null, title: "Our year", subtitle: "" },
      chapters: [{ id: "c1", title: "Spring", dateLabel: "March 2025" }],
      pages: [],
      style: { background: "#FFFFFF", font: "Playfair" },
    };
    const oldV2 = {
      version: 2,
      format: "A5_LANDSCAPE",
      cover: { layout: PAGE_COVER_ID, photoId: null, title: "Our year", subtitle: "" },
      chapters: [{ id: "c1", title: "Spring", dateLabel: "March 2025" }],
      pages: [],
      style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "modern", font: "Cormorant" },
      captionLang: "en",
    };
    for (const old of [oldV1, oldV2]) {
      const r = parsePublicDoc(old);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.doc).toEqual(old);
      const render = publicDocToRenderDoc(r.doc);
      expect(render.chapters[0]).toEqual({ id: "c1", title: "Spring", dateLabel: "March 2025", place: null });
      expect(render.style).not.toHaveProperty("colourway");
    }
  });
});

describe("M30 layout schema: blocks, ink, quarter turns, n", () => {
  it("base layouts are valid", () => {
    for (const l of [PAGE, COVER, SPREAD]) expect(layoutIssues(l), l.id).toEqual([]);
  });

  it("blocks: strict objects, fill / layer enums, polygon 3..8 points in 0..100, max 8", () => {
    const ok = (blocks: unknown) => LayoutSchema.safeParse({ ...PAGE, blocks }).success;
    expect([...BLOCK_FILLS]).toEqual(["panel", "accent", "paper", "ink"]);
    expect(MAX_LAYOUT_BLOCKS).toBe(8);
    for (const fill of BLOCK_FILLS) for (const layer of ["under", "over"] as const) expect(ok([block({ fill, layer })])).toBe(true);
    expect(ok([block({ points: TRIANGLE, when: "chapterDescription" })])).toBe(true);
    expect(ok(Array.from({ length: 8 }, () => block()))).toBe(true);
    expect(ok(Array.from({ length: 9 }, () => block()))).toBe(false);
    expect(ok([{ ...block(), fill: "#FF0000" }])).toBe(false);
    expect(ok([{ ...block(), layer: "top" }])).toBe(false);
    expect(ok([{ ...block(), colour: "red" }])).toBe(false);
    expect(ok([{ ...block(), when: "nothing" }])).toBe(false);
    expect(ok([block({ points: TRIANGLE.slice(0, 2) })])).toBe(false);
    expect(ok([block({ points: Array.from({ length: 8 }, (_, i) => [i * 10, i] as [number, number]) })])).toBe(true);
    expect(ok([block({ points: Array.from({ length: 9 }, (_, i) => [i * 10, i] as [number, number]) })])).toBe(false);
    expect(ok([block({ points: [[0, 0], [101, 0], [0, 100]] })])).toBe(false);
    expect(ok([{ box: { x: 0, y: 0, w: 100, h: 100 }, fill: "panel" }])).toBe(false);
  });

  it("text: ink enum, n int 0..5, bindings, roles", () => {
    const ok = (t: unknown) => LayoutTextSchema.safeParse(t).success;
    expect([...TEXT_INKS]).toEqual(["ink", "muted", "accent", "paper", "accentOnDark"]);
    expect([...TEXT_BINDINGS]).toEqual(["chapterTitle", "dateLabel", "pageCaption", "coverTitle", "coverSubtitle", "chapterDescription", "coverLine"]);
    expect(ok(text())).toBe(true);
    for (const ink of TEXT_INKS) expect(ok(text({ ink }))).toBe(true);
    expect(ok({ ...text(), ink: "white" })).toBe(false);
    for (const n of [0, 1, 5]) expect(ok(text({ bind: "coverLine", n }))).toBe(true);
    for (const n of [-1, 6, 1.5]) expect(ok({ ...text({ bind: "coverLine" }), n })).toBe(false);
    expect(ok(text({ bind: "chapterDescription", font: "body" }))).toBe(true);
    expect(ok(text({ bind: "coverTitle", font: "masthead" }))).toBe(true);
    expect(ok({ ...text(), font: "headline" })).toBe(false);
  });

  it("rotate: |r| ≤ SLOT_ROTATE_MAX as before, plus exactly 90 and -90", () => {
    const ok = (rotate: number) => LayoutTextSchema.safeParse(text({ rotate })).success;
    for (const r of [0, 3.5, -SLOT_ROTATE_MAX, SLOT_ROTATE_MAX, 90, -90]) expect(ok(r), String(r)).toBe(true);
    for (const r of [SLOT_ROTATE_MAX + 0.1, -13, 45, 89, 89.999, 90.001, -91, 180, 270, NaN, Infinity]) expect(ok(r), String(r)).toBe(false);
    // Slots keep the tilt-only rule.
    expect(LayoutSchema.safeParse({ ...PAGE, slots: PAGE.slots.map((s) => ({ ...s, rotate: 90 })) }).success).toBe(false);
  });
});

describe("M30 layoutIssues", () => {
  const issues = (l: Layout) => layoutIssues(l);

  it("blocks must lie inside the role area (page / cover 0..100, spread 0..200)", () => {
    expect(issues({ ...PAGE, blocks: [block()] })).toEqual([]);
    expect(issues({ ...PAGE, blocks: [block(), block({ box: { x: 60, y: 0, w: 41, h: 10 } })] })).toEqual(["block 1: outside the page area"]);
    expect(issues({ ...PAGE, blocks: [block({ box: { x: 0, y: 70, w: 100, h: 31 } })] })).toEqual(["block 0: outside the page area"]);
    expect(issues({ ...COVER, blocks: [block({ box: { x: 100, y: 0, w: 50, h: 10 } })] })).toEqual(["block 0: outside the cover area"]);
    expect(issues({ ...SPREAD, blocks: [block({ box: { x: 100, y: 0, w: 100, h: 100 } })] })).toEqual([]);
    expect(issues({ ...SPREAD, blocks: [block({ box: { x: 150, y: 0, w: 51, h: 100 } })] })).toEqual(["block 0: outside the spread area"]);
    // The layout schema reports the same issue.
    expect(LayoutSchema.safeParse({ ...PAGE, blocks: [block({ box: { x: 60, y: 0, w: 41, h: 10 } })] }).success).toBe(false);
  });

  it("blocks with points must not cross the fold on spreads; rect blocks may; each side alone is fine", () => {
    const across = { x: 50, y: 0, w: 100, h: 100 };
    expect(issues({ ...SPREAD, blocks: [block({ box: across })] })).toEqual([]);
    expect(issues({ ...SPREAD, blocks: [block({ box: across, points: TRIANGLE })] })).toEqual(["block 0: shaped block crosses the fold"]);
    expect(issues({ ...SPREAD, blocks: [block({ box: { x: 0, y: 0, w: 100, h: 100 }, points: TRIANGLE })] })).toEqual([]);
    expect(issues({ ...SPREAD, blocks: [block({ box: { x: 100, y: 0, w: 100, h: 100 }, points: TRIANGLE })] })).toEqual([]);
    // On a single page there is no fold.
    expect(issues({ ...PAGE, blocks: [block({ box: { x: 0, y: 0, w: 100, h: 100 }, points: TRIANGLE })] })).toEqual([]);
  });

  it("±90° text: the box is the final visual rect and must be SAFE_MM inside the trim", () => {
    const page = pageMm(PAGE.format);
    const safeX = (SAFE_MM / page.w) * 100;
    const safeY = (SAFE_MM / page.h) * 100;
    // A tall strip exactly on the safe margin: fine as a final rect (rotating it would leave the page).
    const strip = { x: safeX, y: safeY, w: 6, h: 100 - 2 * safeY };
    for (const rotate of [90, -90]) {
      expect(issues({ ...PAGE, texts: [text({ box: strip, rotate })] }), String(rotate)).toEqual([]);
      expect(issues({ ...PAGE, texts: [text({ box: { ...strip, x: safeX - 0.5 }, rotate })] })).toEqual([
        `text 0: rotated/plated text outside the ${SAFE_MM} mm safe zone`,
      ]);
      expect(issues({ ...PAGE, texts: [text({ box: { ...strip, y: safeY - 0.5 }, rotate })] })).toEqual([
        `text 0: rotated/plated text outside the ${SAFE_MM} mm safe zone`,
      ]);
      expect(issues({ ...PAGE, texts: [text({ box: { ...strip, x: 100 - 6 }, rotate })] })).toEqual([
        `text 0: rotated/plated text outside the ${SAFE_MM} mm safe zone`,
      ]);
    }
    // Unrotated text may still sit at the trim (rule unchanged); a small tilt keeps the rotated-bounds rule.
    expect(issues({ ...PAGE, texts: [text({ box: { x: 0, y: 0, w: 40, h: 10 } })] })).toEqual([]);
    expect(issues({ ...PAGE, texts: [text({ box: { x: 0, y: 0, w: 40, h: 10 }, rotate: 5 })] })).toHaveLength(1);
    // Vertical text may not cross the fold of a spread.
    expect(issues({ ...SPREAD, texts: [text({ box: { x: 96, y: 10, w: 8, h: 60 }, rotate: 90 })] })).toEqual(["text 0: plated text crosses the fold"]);
  });

  it("n only with bind coverLine", () => {
    expect(issues({ ...COVER, texts: [text({ bind: "coverLine", n: 2 })] })).toEqual([]);
    expect(issues({ ...COVER, texts: [text({ bind: "coverLine" })] })).toEqual([]);
    expect(issues({ ...COVER, texts: [text({ bind: "coverTitle", n: 0 })] })).toEqual(["text 0: n needs bind coverLine"]);
    expect(issues({ ...PAGE, texts: [text({ bind: "chapterTitle", n: 1 })] })).toEqual(["text 0: n needs bind coverLine"]);
  });

  it("coverLine only on cover layouts (text bind and block `when`)", () => {
    expect(issues({ ...PAGE, texts: [text({ bind: "coverLine", n: 0 })] })).toEqual(["text 0: coverLine needs a cover layout"]);
    expect(issues({ ...SPREAD, texts: [text({ bind: "coverLine" })] })).toEqual(["text 0: coverLine needs a cover layout"]);
    expect(issues({ ...PAGE, blocks: [block({ when: "coverLine" })] })).toEqual(["block 0: coverLine needs a cover layout"]);
    expect(issues({ ...COVER, blocks: [block({ when: "coverLine" })] })).toEqual([]);
  });

  it("chapterDescription not on covers (text bind and block `when`)", () => {
    expect(issues({ ...PAGE, texts: [text({ bind: "chapterDescription", font: "body" })], blocks: [block({ when: "chapterDescription" })] })).toEqual([]);
    expect(issues({ ...SPREAD, texts: [text({ bind: "chapterDescription", font: "body" })] })).toEqual([]);
    expect(issues({ ...COVER, texts: [text({ bind: "chapterDescription" })] })).toEqual(["text 0: chapterDescription is not for covers"]);
    expect(issues({ ...COVER, blocks: [block({ when: "chapterDescription" })] })).toEqual(["block 0: chapterDescription is not for covers"]);
  });
});
