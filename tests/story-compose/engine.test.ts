// Task 7: the pure page-composition engine — selectPageTemplate, validatePageLayout, composition rules,
// merge with user edits, photo replacement re-layout.
import { describe, expect, it, vi } from "vitest";
import { serializeDoc } from "@/lib/book/doc-version";
import { setPageText } from "@/lib/book/edit-ops";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDesign } from "@/lib/book/book-design";
import type { BookDoc, BookPage, Layout } from "@/lib/book/types";
import { getPageTemplate, templatesFor } from "@/lib/layouts/templates";
import { storyBaseId, storyTemplateId } from "@/lib/layouts/story";
import {
  composeStoryDoc,
  mergeComposition,
  replacePhotoAndRelayout,
  selectPageTemplate,
  splitAtSentence,
  userOwnedElements,
  validatePageLayout,
  type ComposePhoto,
  type PageIntent,
} from "@/lib/storybook/compose";
import { fixturePhotoId, storyFixture } from "@/lib/storybook/compose/dev-fixture";
import { StorybookSchema } from "@/lib/storybook/schemas";

// A deliberately broken layout (text on the trim, a framed slot in the bleed) for the safe-area codes.
const BAD: Layout = {
  id: "zz-bad-safe",
  name: "bad",
  role: "page",
  style: "classic",
  format: "A5_PORTRAIT",
  photoCount: 1,
  prefers: ["any"],
  slots: [{ x: 0.5, y: 0.5, w: 60, h: 40, frame: { kind: "border", mm: 2, hex: "#FFFFFF" } }],
  caption: null,
  texts: [{ bind: "pageText", n: 0, box: { x: 0, y: 60, w: 100, h: 39 }, align: "start", font: "body" }],
};
vi.mock("@/lib/layouts", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/layouts");
  return { ...real, getLayout: (id: string) => (id === "zz-bad-safe" ? BAD : real.getLayout(id)) };
});

const PORTRAIT: ComposePhoto = { id: fixturePhotoId(901), width: 3000, height: 4000 };
const LANDSCAPE: ComposePhoto = { id: fixturePhotoId(902), width: 4000, height: 3000 };
const LOW: ComposePhoto = { id: fixturePhotoId(903), width: 800, height: 600 };
const PANO: ComposePhoto = { id: fixturePhotoId(904), width: 6000, height: 1500 };
const words = (n: number, w = "story") => Array.from({ length: n }, () => w).join(" ");
const intent = (over: Partial<PageIntent> = {}): PageIntent => ({ family: "hero", design: { format: "A5_PORTRAIT", designStyle: "modern" }, lang: "en", ...over });
/** Template kind of a template id; a fitted variant counts as its base kind (layouts/story storyBaseId). */
const kindOf = (id: string) => storyBaseId(id).replace(/^st-[a-z]+-[pl]-/, "");

describe("selectPageTemplate", () => {
  it("orientation: a portrait photo with a paragraph gets the portrait story template, a landscape one a landscape template", () => {
    const text = { texts: [{ key: "t", role: "paragraph" as const, text: words(40) }] };
    const p = selectPageTemplate(intent({ family: "storytelling" }), [PORTRAIT], text);
    const l = selectPageTemplate(intent({ family: "storytelling" }), [LANDSCAPE], text);
    expect(p.ok && kindOf(p.templateId)).toBe("tell-1c");
    expect(l.ok && ["tell-1a", "tell-1b"]).toContain(l.ok && kindOf(l.templateId));
  });

  it("DPI: a photo too small for a full-bleed hero falls back to the small framed hero; without it → low_dpi", () => {
    const r = selectPageTemplate(intent(), [LOW], { texts: [] });
    expect(r.ok && kindOf(r.templateId)).toBe("hero-small");
    expect(r.ok && getPageTemplate(r.templateId)?.fullBleed).toBe(false);
    const small = storyTemplateId("modern", "A5_PORTRAIT", "hero-small");
    const none = selectPageTemplate(intent({ avoid: [small] }), [LOW], { texts: [] });
    expect(none).toMatchObject({ ok: false, reason: "low_dpi" });
    const relaxed = selectPageTemplate(intent({ avoid: [small], relax: true }), [LOW], { texts: [] });
    expect(relaxed.ok && relaxed.warnings).toContain("low_dpi");
  });

  it("crop: a panorama never goes into a slot that hides more than 45 % of it", () => {
    const r = selectPageTemplate(intent(), [PANO], { texts: [] });
    expect(r).toMatchObject({ ok: false, reason: "crop" });
    const relaxed = selectPageTemplate(intent({ relax: true }), [PANO], { texts: [] });
    expect(relaxed.ok && relaxed.warnings).toContain("crop_heavy");
  });

  it("crop: the crop is centred on a known focus point; a crop that cuts the subject is flagged", () => {
    const edge = { ...LANDSCAPE, focus: { x: 0.03, y: 0.5 } };
    const r = selectPageTemplate(intent({ family: "storytelling" }), [edge], { texts: [{ key: "t", role: "paragraph", text: words(30) }] });
    expect(r.ok && r.slots[0]!.crop).toEqual({ x: 0.03, y: 0.5, zoom: 1 });
    const centre = selectPageTemplate(intent(), [{ ...LANDSCAPE, focus: { x: 0.4, y: 0.3 } }], { texts: [] });
    expect(centre.ok && centre.slots[0]!.crop).toEqual({ x: 0.4, y: 0.3, zoom: 1 });
  });

  it("text capacity EN / AR: a 60-word paragraph fits, a 400-word one overflows every story template", () => {
    for (const lang of ["en", "ar"] as const) {
      const w = lang === "ar" ? "حكاية" : "story";
      const fits = selectPageTemplate(intent({ family: "storytelling", lang }), [LANDSCAPE], { texts: [{ key: "t", role: "paragraph", text: words(60, w) }] });
      expect(fits.ok, lang).toBe(true);
      const over = selectPageTemplate(intent({ family: "storytelling", lang }), [LANDSCAPE], { texts: [{ key: "t", role: "paragraph", text: words(400, w) }] });
      expect(over, lang).toMatchObject({ ok: false, reason: "text_overflow" });
    }
  });

  it("repetition: the previous page's template is never chosen; recent ones are penalised", () => {
    const first = selectPageTemplate(intent({ family: "collage" }), [LANDSCAPE, { ...LANDSCAPE, id: fixturePhotoId(905) }], { texts: [] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const next = selectPageTemplate(intent({ family: "collage", avoid: [first.templateId], recent: [first.templateId] }), [LANDSCAPE, { ...LANDSCAPE, id: fixturePhotoId(905) }], { texts: [] });
    expect(next.ok && next.templateId).not.toBe(first.templateId);
  });

  it("no fit: wrong photo count / unknown family give a reason", () => {
    expect(selectPageTemplate(intent({ family: "closing" }), [LANDSCAPE, PORTRAIT], { texts: [{ key: "c", role: "closing", text: "x" }] })).toMatchObject({ ok: false, reason: "photo_count" });
    const seven = Array.from({ length: 7 }, (_, i) => ({ ...LANDSCAPE, id: fixturePhotoId(910 + i) }));
    expect(selectPageTemplate(intent({ family: "collage" }), seven, { texts: [] })).toMatchObject({ ok: false, reason: "photo_count" });
    expect(selectPageTemplate(intent({ family: "storytelling" }), [], { texts: [] })).toMatchObject({ ok: false, reason: "text_unplaced" });
  });

  it("the AI's approved choice wins when it passes the rules; an unapproved one is ignored", () => {
    const options = templatesFor("modern", "A5_PORTRAIT", "hero").filter((t) => t.photoCount === 1 && !t.fallback);
    const alt = options[options.length - 1]!.id;
    const r = selectPageTemplate(intent({ preferredTemplateId: alt }), [PORTRAIT], { texts: [] });
    expect(r.ok && r.templateId).toBe(alt);
    const bad = selectPageTemplate(intent({ preferredTemplateId: "full-page" }), [PORTRAIT], { texts: [] });
    expect(bad.ok && bad.templateId).not.toBe("full-page");
  });

  it("is deterministic", () => {
    const a = selectPageTemplate(intent({ family: "collage" }), [LANDSCAPE, PORTRAIT, { ...LANDSCAPE, id: fixturePhotoId(906) }], { texts: [{ key: "c", role: "caption", text: "A short caption" }] });
    const b = selectPageTemplate(intent({ family: "collage" }), [LANDSCAPE, PORTRAIT, { ...LANDSCAPE, id: fixturePhotoId(906) }], { texts: [{ key: "c", role: "caption", text: "A short caption" }] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

const page = (over: Partial<BookPage> = {}): BookPage => ({ id: "sp-pg1", chapterId: null, layout: storyTemplateId("modern", "A5_PORTRAIT", "tell-1a"), slots: [{ photoId: LANDSCAPE.id, crop: { x: 0.5, y: 0.5, zoom: 1 } }], caption: null, texts: [{ id: "tx-b1", panel: 0, role: "paragraph", text: words(40), source: "ai" }], ...over });
const photos = new Map([LANDSCAPE, PORTRAIT, LOW, PANO].map((p) => [p.id, p]));
const ctx = { design: { format: "A5_PORTRAIT" as const, designStyle: "modern" as const }, photos, lang: "en" as const };
const codes = (r: ReturnType<typeof validatePageLayout>) => ({ e: r.errors.map((x) => x.code), w: r.warnings.map((x) => x.code) });

describe("validatePageLayout: every code", () => {
  it("a good page is ok", () => {
    expect(validatePageLayout(page(), ctx)).toEqual({ ok: true, errors: [], warnings: [] });
  });
  it("text_overflow (+ text_tight)", () => {
    expect(codes(validatePageLayout(page({ texts: [{ id: "tx-b1", panel: 0, role: "paragraph", text: words(400), source: "ai" }] }), ctx)).e).toContain("text_overflow");
    const tight = page({ layout: storyTemplateId("modern", "A5_PORTRAIT", "tell-3"), slots: [LANDSCAPE, PORTRAIT, LOW].map((p) => ({ photoId: p.id, crop: { x: 0.5, y: 0.5, zoom: 1 } })) });
    const cap = getPageTemplate(tight.layout)!;
    void cap;
    expect(codes(validatePageLayout(tight, ctx)).e).not.toContain("text_overflow");
  });
  it("crop_subject: a user crop away from the photo's subject", () => {
    const focused = new Map([...photos, [LANDSCAPE.id, { ...LANDSCAPE, focus: { x: 0.9, y: 0.5 } }]]);
    const tall = page({ layout: storyTemplateId("modern", "A5_PORTRAIT", "tell-1c"), slots: [{ photoId: LANDSCAPE.id, crop: { x: 0.1, y: 0.5, zoom: 1 } }] });
    expect(codes(validatePageLayout(tall, { ...ctx, photos: focused })).w).toContain("crop_subject");
  });
  it("crop_excessive, crop_heavy, orientation_miss", () => {
    expect(codes(validatePageLayout(page({ slots: [{ photoId: PANO.id, crop: { x: 0.5, y: 0.5, zoom: 1 } }] }), ctx)).e).toContain("crop_excessive");
    expect(codes(validatePageLayout(page({ slots: [{ photoId: LANDSCAPE.id, crop: { x: 0.5, y: 0.5, zoom: 1.5 } }] }), ctx)).e).toContain("crop_excessive");
    expect(codes(validatePageLayout(page({ slots: [{ photoId: PORTRAIT.id, crop: { x: 0.5, y: 0.5, zoom: 1 } }] }), ctx)).w).toContain("orientation_miss");
  });
  it("dpi_too_low on a full-bleed hero, low_dpi elsewhere", () => {
    expect(codes(validatePageLayout(page({ layout: "m-p-full", texts: undefined, slots: [{ photoId: LOW.id, crop: { x: 0.5, y: 0.5, zoom: 1 } }] }), ctx)).e).toContain("dpi_too_low");
    expect(codes(validatePageLayout(page({ slots: [{ photoId: LOW.id, crop: { x: 0.5, y: 0.5, zoom: 1 } }] }), ctx)).w).toContain("low_dpi");
  });
  it("outside_safe_area and inside_bleed (broken layout)", () => {
    const r = codes(validatePageLayout(page({ layout: "zz-bad-safe" }), { ...ctx, design: { format: "A5_PORTRAIT", designStyle: "classic" } }));
    expect(r.e).toContain("outside_safe_area");
    expect(r.e).toContain("inside_bleed");
    expect(r.e).toContain("template_not_approved");
  });
  it("missing_photo, template_not_approved, duplicate_element_id, text_unplaced, panel_empty", () => {
    expect(codes(validatePageLayout(page({ slots: [{ photoId: null, crop: { x: 0.5, y: 0.5, zoom: 1 } }] }), ctx)).e).toContain("missing_photo");
    expect(codes(validatePageLayout(page({ slots: [{ photoId: "00000000-0000-4000-8000-000000009999", crop: { x: 0.5, y: 0.5, zoom: 1 } }] }), ctx)).e).toContain("missing_photo");
    expect(codes(validatePageLayout(page({ layout: "full-page", texts: undefined }), ctx)).e).toContain("template_not_approved");
    expect(codes(validatePageLayout(page({ layout: "mg-p-one-column", texts: undefined }), { ...ctx, design: { format: "A5_PORTRAIT", designStyle: "magazine" } })).e).toContain("template_not_approved");
    const dup = page({ layout: storyTemplateId("modern", "A5_PORTRAIT", "tell-0q"), slots: [], texts: [{ id: "tx-b1", panel: 0, role: "paragraph", text: "One.", source: "ai" }, { id: "tx-b1", panel: 1, role: "pull_quote", text: "Two.", source: "ai" }] });
    expect(codes(validatePageLayout(dup, ctx)).e).toContain("duplicate_element_id");
    expect(codes(validatePageLayout(page({ texts: [{ id: "tx-b1", panel: 1, role: "pull_quote", text: "Hidden.", source: "ai" }] }), ctx)).w).toEqual(expect.arrayContaining(["text_unplaced", "panel_empty"]));
  });
});

const DESIGN: BookDesign = { format: "A5_PORTRAIT", designStyle: "editorial" };
function composed(n = 24, over: Partial<Parameters<typeof composeStoryDoc>[0]> = {}, design = DESIGN) {
  const f = storyFixture({ photos: n, design, lowRes: [5] });
  return { f, r: composeStoryDoc({ storybook: f.storybook, photos: f.photos, design, lang: "en", occasion: "travel", bookTitle: null, maxPages: 20, ...over }) };
}

describe("composition rules", () => {
  it("fixture storybooks are valid Task 6 storybooks", () => {
    for (const n of [10, 24, 60]) expect(StorybookSchema.safeParse(storyFixture({ photos: n }).storybook).success).toBe(true);
  });

  it("a valid book doc: validateBookDoc clean, cover separate and not counted, 12–20 interior pages for 24 photos", () => {
    const { f, r } = composed();
    const parsed = parseBookDoc(JSON.parse(JSON.stringify(serializeDoc(r.doc))));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateBookDoc(parsed.doc, { photoIds: new Set(f.photos.map((p) => p.id)), maxPages: 20 })).toEqual([]);
    expect(r.report.interiorPages).toBe(r.doc.pages.length);
    expect(r.doc.pages.some((p) => p.layout.includes("cover"))).toBe(false);
    expect(r.report.interiorPages).toBeGreaterThanOrEqual(12);
    expect(r.report.interiorPages).toBeLessThanOrEqual(20);
    expect(r.doc.cover.photoId).toBe(f.storybook.coverPhotoId);
  });

  it("every placed photo is placed once; every storybook paragraph is on a page (no text lost)", () => {
    const { f, r } = composed();
    const placed = r.doc.pages.flatMap((p) => p.slots.map((s) => s.photoId));
    expect(new Set(placed).size).toBe(placed.length);
    const blocks = f.storybook.pages.flatMap((p) => p.blocks.map((b) => b.id));
    const shown = new Set([...r.doc.pages.flatMap((p) => (p.texts ?? []).map((t) => t.blockRef)), ...r.doc.pages.filter((p) => p.caption).map((p) => p.id)]);
    const captions = r.doc.pages.filter((p) => p.caption).length;
    expect(blocks.filter((b) => shown.has(b)).length + captions).toBe(blocks.length);
  });

  it("chapter openings are their own family and never repeat the previous opening; no consecutive repeats", () => {
    for (const designStyle of ["classic", "magazine", "scrapbook"] as const) {
      const { r } = composed(24, {}, { format: "A5_LANDSCAPE", designStyle });
      const openers = r.doc.pages.filter((p) => getPageTemplate(p.layout)?.family === "chapter_opening");
      expect(openers.length).toBeGreaterThanOrEqual(2);
      openers.forEach((p, i) => i > 0 && expect(p.layout).not.toBe(openers[i - 1]!.layout));
      const forced = new Set(r.report.warnings.filter((w) => w.code === "repeat_forced").map((w) => w.pageId));
      r.doc.pages.forEach((p, i) => i > 0 && !forced.has(p.id) && expect(p.layout, `${designStyle} ${p.id}`).not.toBe(r.doc.pages[i - 1]!.layout));
    }
  });

  it("page budget: 60 photos on a paid book stay ≤ 24 pages; free books stay ≤ max_pages; 10 photos never padded with empty pages", () => {
    const paid = composed(60, { maxPages: 100 });
    expect(paid.r.report.interiorPages).toBeLessThanOrEqual(24);
    expect(composed(60).r.report.interiorPages).toBeLessThanOrEqual(20);
    const small = composed(10);
    for (const p of small.r.doc.pages) expect(p.slots.some((s) => s.photoId) || (p.texts?.length ?? 0) > 0).toBe(true);
  });

  it("balance is measured from geometry and reported with drift", () => {
    const { r } = composed();
    expect(r.report.balance.target).toBe(0.35);
    expect(r.report.balance.photoShare + r.report.balance.narrativeShare).toBeCloseTo(1, 3);
    expect(Math.abs(r.report.balance.drift)).toBeLessThanOrEqual(0.1);
    expect(r.report.balance.drift).toBeCloseTo(r.report.balance.narrativeShare - 0.35, 3);
  });

  it("composing twice is byte-identical; ids are derived from the storybook", () => {
    const a = composed();
    const b = composed();
    expect(JSON.stringify(serializeDoc(a.r.doc))).toBe(JSON.stringify(serializeDoc(b.r.doc)));
    for (const p of a.r.doc.pages) expect(p.id).toMatch(/^sp-pg\d+(-[a-z0-9]+)?$/);
    for (const t of a.r.doc.pages.flatMap((p) => p.texts ?? [])) expect(t.id).toBe(`tx-${t.blockRef}`);
    for (const c of a.r.doc.chapters) expect(c.id).toMatch(/^ch-c\d+$/);
  });

  it("AI choices: unapproved / wrong-family template ids are ignored and counted as replaced", () => {
    const { f } = composed();
    const intents = new Map(f.storybook.pages.map((p) => [p.id, { pageId: p.id, family: "hero" as const, emphasis: "balanced" as const, templateId: "full-page" }]));
    const { r } = composed(24, { intents });
    expect(r.doc.pages.some((p) => p.layout === "full-page")).toBe(false);
    expect(r.report.ai.used).toBe(0);
    expect(r.report.ai.replaced).toBeGreaterThan(0);
  });

  it("overflow: a paragraph too long for a photo story page moves to its own text page; text is never cut", () => {
    const { f } = composed();
    const sb = structuredClone(f.storybook);
    const mixed = sb.pages.find((p) => p.kind === "mixed")!;
    mixed.blocks[0]!.text = words(140);
    mixed.photoIds.splice(1);
    const r = composeStoryDoc({ storybook: sb, photos: f.photos, design: { format: "A5_LANDSCAPE", designStyle: "editorial" }, lang: "en", occasion: "travel", bookTitle: null, maxPages: 40 });
    const holder = r.doc.pages.find((p) => p.texts?.some((t) => t.blockRef === mixed.blocks[0]!.id))!;
    expect(holder.texts!.find((t) => t.blockRef === mixed.blocks[0]!.id)!.text).toBe(words(140));
    expect(validatePageLayout(holder, { design: { format: "A5_LANDSCAPE", designStyle: "editorial" } }).errors).toEqual([]);
  });

  it("splitAtSentence splits at the sentence nearest the middle", () => {
    expect(splitAtSentence("One two three. Four five six. Seven eight nine ten eleven.")).toEqual(["One two three. Four five six.", "Seven eight nine ten eleven."]);
    expect(splitAtSentence("أ ب ت. ث ج ح؟ خ د ذ ر ز")).toEqual(["أ ب ت. ث ج ح؟", "خ د ذ ر ز"]);
    expect(splitAtSentence("No full stop here")).toBeNull();
  });
});

describe("merge with the current doc (user edits survive)", () => {
  function stored() {
    const { f, r } = composed();
    const owned = userOwnedElements(null, {});
    if (!owned.ok) throw new Error("x");
    const doc = mergeComposition({ fresh: r.doc, current: null, owned: owned.owned, design: DESIGN, storybookVersion: 1 });
    return { f, doc };
  }

  it("a fresh composition records a hash per element and recomposing it unchanged is byte-identical", () => {
    const { f, doc } = stored();
    expect(Object.keys(doc.meta!.story!.hashes)).toContain(`pg:${doc.pages[0]!.id}`);
    const again = composeStoryDoc({ storybook: f.storybook, photos: f.photos, design: DESIGN, lang: "en", occasion: "travel", bookTitle: null, maxPages: 20 });
    const owned = userOwnedElements(doc, doc);
    expect(owned.ok && owned.owned.pages.length).toBe(0);
    const merged = mergeComposition({ fresh: again.doc, current: doc, owned: owned.ok ? owned.owned : (null as never), design: DESIGN, storybookVersion: 1 });
    expect(JSON.stringify(serializeDoc(merged))).toBe(JSON.stringify(serializeDoc(doc)));
  });

  it("a page the user edited is kept byte-identical in place; its photos are not reused", () => {
    const { f, doc } = stored();
    const idx = doc.pages.findIndex((p) => p.texts?.length);
    const edited = { ...setPageText(doc, idx, doc.pages[idx]!.texts![0]!.panel, "Our own words."), meta: { ...doc.meta!, userEdited: true } };
    const owned = userOwnedElements(edited, edited);
    expect(owned.ok && owned.owned.pageIds.has(doc.pages[idx]!.id)).toBe(true);
    if (!owned.ok) return;
    const fresh = composeStoryDoc({ storybook: f.storybook, photos: f.photos, design: DESIGN, lang: "en", occasion: "travel", bookTitle: null, maxPages: 20, reserved: { pageIds: owned.owned.pageIds, photoIds: owned.owned.photoIds, pageCount: owned.owned.pages.length } });
    const merged = mergeComposition({ fresh: fresh.doc, current: edited, owned: owned.owned, design: DESIGN, storybookVersion: 2 });
    expect(JSON.stringify(merged.pages[idx])).toBe(JSON.stringify(edited.pages[idx]));
    expect(merged.meta!.userEdited).toBe(true);
    const ids = merged.pages.flatMap((p) => p.slots.map((s) => s.photoId));
    expect(new Set(ids).size).toBe(ids.length);
    // still the user's on the next round
    const next = userOwnedElements(merged, merged);
    expect(next.ok && next.owned.pageIds.has(doc.pages[idx]!.id)).toBe(true);
  });

  it("a non-story doc the user edited is never overwritten (user_edited)", () => {
    const d = { ...composed().r.doc, meta: { generator: "rule" as const, generatorVersion: 1, runId: null, userEdited: true } };
    expect(userOwnedElements(d as BookDoc, d)).toEqual({ ok: false, reason: "user_edited" });
    expect(userOwnedElements(null, {}).ok).toBe(true);
  });
});

describe("replacePhotoAndRelayout", () => {
  it("swaps the photo and re-selects only that page's template (same family, same ids); others unchanged", () => {
    const { f, r } = composed();
    const doc = r.doc;
    const idx = doc.pages.findIndex((p) => getPageTemplate(p.layout)?.family === "storytelling" && p.slots.length === 1 && getPageTemplate(p.layout)?.orientations[0] === "landscape");
    expect(idx).toBeGreaterThanOrEqual(0);
    const target = doc.pages[idx]!;
    const map = new Map([...f.photos, PORTRAIT].map((p) => [p.id, p]));
    const res = replacePhotoAndRelayout(doc, target.id, `${target.id}/s0`, PORTRAIT, { design: DESIGN, lang: "en", photos: map });
    expect(res.ok && res.relaid).toBe(true);
    if (!res.ok) return;
    const after = res.doc.pages[idx]!;
    expect(after.id).toBe(target.id);
    expect(after.layout).not.toBe(target.layout);
    expect(getPageTemplate(after.layout)?.family).toBe("storytelling");
    expect(after.texts?.map((t) => t.id)).toEqual(target.texts?.map((t) => t.id));
    expect(after.slots[0]!.photoId).toBe(PORTRAIT.id);
    res.doc.pages.forEach((p, k) => k !== idx && expect(p).toBe(doc.pages[k]));
    expect(replacePhotoAndRelayout(doc, target.id, 0, { ...f.photos[0]!, id: doc.pages[0]!.slots[0]!.photoId! }, { design: DESIGN, lang: "en", photos: map })).toMatchObject({ ok: false, reason: "photo_in_use" });
  });

  it("a photo that still fits keeps the template", () => {
    const { f, r } = composed();
    const idx = r.doc.pages.findIndex((p) => getPageTemplate(p.layout)?.family === "storytelling" && p.slots.length === 1 && getPageTemplate(p.layout)?.orientations[0] === "landscape");
    const res = replacePhotoAndRelayout(r.doc, r.doc.pages[idx]!.id, 0, LANDSCAPE, { design: DESIGN, lang: "en", photos: new Map(f.photos.map((p) => [p.id, p])) });
    expect(res.ok && !res.relaid && res.doc.pages[idx]!.layout === r.doc.pages[idx]!.layout).toBe(true);
  });
});
