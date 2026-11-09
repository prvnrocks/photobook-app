import { describe, expect, it } from "vitest";
import { planToDoc, prunePlan, validatePlanAgainstPhotos } from "@/lib/ai/plan-to-doc";
import { effectiveMaxPages } from "@/lib/ai/story";
import { AlbumPlanStrictSchema, type AlbumPlan } from "@/lib/ai/schemas";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { aliasMaps, fixturePlan, RUN_ID, storyBook, storyPhotos } from "../helpers/story-fixtures";

const photos = storyPhotos();
const { aliasToId } = aliasMaps(photos);
const base = { aliasToId, photos, book: storyBook(), runId: RUN_ID, generatorVersion: 1 };

function okDoc(plan: AlbumPlan = fixturePlan(), over: Partial<typeof base> = {}): BookDoc {
  const r = planToDoc(plan, { ...base, ...over });
  if (!("doc" in r)) throw new Error(`expected a doc, got issues: ${r.issues.join("; ")}`);
  return r.doc;
}
function issuesOf(plan: AlbumPlan, over: Partial<typeof base> = {}): string[] {
  const r = planToDoc(plan, { ...base, ...over });
  if (!("issues" in r)) throw new Error("expected issues");
  return r.issues;
}

describe("planToDoc — valid plan", () => {
  it("fixture plan passes the strict schema", () => {
    expect(AlbumPlanStrictSchema.safeParse(fixturePlan()).success).toBe(true);
  });

  it("builds a doc that passes parseBookDoc + validateBookDoc, marked as AI", () => {
    const doc = okDoc();
    const parsed = parseBookDoc(doc);
    expect(parsed.ok).toBe(true);
    const kept = new Set(photos.filter((p) => p.keep).map((p) => p.id));
    expect(validateBookDoc(doc, { photoIds: kept, maxPages: 20 })).toEqual([]);
    expect(doc.meta).toEqual({ generator: "ai", generatorVersion: 1, runId: RUN_ID, userEdited: false });
  });

  it("de-aliases, numbers chapters c1.. and pages p1.., centres crops, leaves captions null", () => {
    const doc = okDoc();
    expect(doc.chapters.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(doc.pages.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
    expect(doc.pages[1].layout).toBe("three-mixed");
    expect(doc.pages[1].slots.map((s) => s.photoId)).toEqual([aliasToId.get("p3"), aliasToId.get("p2"), aliasToId.get("p4")]);
    expect(doc.pages.every((p) => p.caption === null)).toBe(true);
    expect(doc.pages.flatMap((p) => p.slots).every((s) => s.crop.x === 0.5 && s.crop.y === 0.5 && s.crop.zoom === 1)).toBe(true);
    expect(doc.pages.slice(0, 4).every((p) => p.chapterId === "c1")).toBe(true);
    expect(doc.cover).toMatchObject({ layout: "cover", photoId: aliasToId.get("p1"), title: "A Night to Remember", subtitle: "October 2026" });
    expect(doc.occasion).toBe("wedding");
    // The cover photo also on page 1 is allowed (once).
    expect(doc.pages[0].slots[0].photoId).toBe(doc.cover.photoId);
  });

  it("recomputes dateLabel from photo dates (never trusts the AI label)", () => {
    const plan = fixturePlan();
    plan.moments[0].dateLabel = "1 Jan 1999";
    const doc = okDoc(plan);
    expect(doc.chapters[0].dateLabel).toBe("12 Oct 2026");
    // m2 holds p12 (undated) plus 13 Oct photos.
    expect(doc.chapters[1].dateLabel).toBe("13 Oct 2026");
  });

  it("0-GPS input: an AI-invented place becomes null", () => {
    const plan = fixturePlan();
    plan.moments[0].place = "Paris";
    const doc = okDoc(plan);
    expect(doc.chapters.map((c) => c.place)).toEqual([null, null]);
    expect(JSON.stringify(doc)).not.toContain("Paris");
  });

  it("keeps a place only when it comes from the moment's own photos (normalised)", () => {
    const withPlace = storyPhotos({ 2: { place: "Abu Dhabi" }, 8: { place: "Dubai Marina" } });
    const plan = fixturePlan();
    plan.moments[0].place = "  abu   dhabi ";
    plan.moments[1].place = "Abu Dhabi"; // not a place of m2's photos
    const doc = okDoc(plan, { photos: withPlace });
    expect(doc.chapters[0].place).toBe("Abu Dhabi");
    expect(doc.chapters[1].place).toBeNull();
  });

  it("user books.title wins over the AI title", () => {
    expect(okDoc(fixturePlan(), { book: storyBook({ title: "  Sara & Omar  " }) }).cover.title).toBe("Sara & Omar");
    expect(okDoc(fixturePlan(), { book: storyBook({ title: "   " }) }).cover.title).toBe("A Night to Remember");
  });

  it("Arabic book → Cairo font; English → Playfair", () => {
    expect(okDoc(fixturePlan(), { book: storyBook({ captionLang: "ar" }) }).style).toEqual({ background: "#FFFFFF", font: "Cairo" });
    expect(okDoc().style.font).toBe("Playfair");
  });
});

describe("planToDoc — invalid plans → issues", () => {
  it("unknown layout", () => {
    const plan = fixturePlan();
    plan.moments[0].pages[0].layoutId = "five-collage";
    expect(issuesOf(plan)).toEqual(['moments[0].pages[0]: unknown layout "five-collage" (use only catalogue page layouts)']);
  });

  it("cover layout used as a page", () => {
    const plan = fixturePlan();
    plan.moments[0].pages[0].layoutId = "cover";
    expect(issuesOf(plan)[0]).toContain('layout "cover" is a cover layout');
  });

  it("wrong slot count", () => {
    const plan = fixturePlan();
    plan.moments[1].pages[0].photoIds = ["p8"]; // two-vertical needs 2 (p9 now unused, fine)
    expect(issuesOf(plan)).toEqual(['moments[1].pages[0]: layout "two-vertical" needs exactly 2 photos, got 1']);
  });

  it("unknown alias", () => {
    const plan = fixturePlan();
    plan.moments[1].pages[1].photoIds = ["p77"];
    expect(issuesOf(plan)).toEqual(['moments[1].pages[1].photoIds[0]: unknown photo "p77" (use only aliases from the photo list)']);
  });

  it("dropped photo used (page and cover)", () => {
    const plan = fixturePlan();
    plan.moments[1].pages[1].photoIds = ["p11"];
    plan.coverPhotoId = "p11";
    expect(issuesOf(plan)).toEqual([
      'moments[1].pages[1].photoIds[0]: photo "p11" was dropped and must not be used',
      'coverPhotoId: photo "p11" was dropped and must not be used',
    ]);
  });

  it("photo used twice (plan built in code, bypassing the strict schema)", () => {
    const plan = fixturePlan();
    plan.moments[1].pages[1].photoIds = ["p5"];
    expect(issuesOf(plan)).toEqual(['moments[1].pages[1].photoIds[0]: photo "p5" is used more than once']);
  });

  it("too many pages: limited by books.max_pages and by the plan limit", () => {
    expect(issuesOf(fixturePlan(), { book: storyBook({ maxPages: 5 }) })).toEqual(["plan: 7 pages exceeds the limit of 5 pages"]);
    expect(effectiveMaxPages({ isPaid: false, maxPages: 100 })).toBe(20);
    expect(effectiveMaxPages({ isPaid: true, maxPages: 100 })).toBe(100);
    expect(effectiveMaxPages({ isPaid: true, maxPages: 40 })).toBe(40);
  });

  it("issues never contain user text (titles, places, descriptions)", () => {
    const plan = fixturePlan();
    plan.title = "SECRET TITLE";
    plan.moments[0].title = "SECRET CHAPTER";
    plan.moments[0].place = "SECRET PLACE";
    plan.moments[0].pages[0].layoutId = 'x"SECRET';
    plan.moments[0].pages[1].photoIds = ["SECRET", "p2", "p4"];
    const issues = validatePlanAgainstPhotos(plan, { aliasToId, photos, maxPages: 20 });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join("\n")).not.toMatch(/SECRET/);
  });

  it("an invalid runId surfaces as a doc issue, not a throw", () => {
    const r = planToDoc(fixturePlan(), { ...base, runId: "not-a-uuid" });
    expect("issues" in r && r.issues.some((i) => i.startsWith("doc: meta.runId"))).toBe(true);
  });
});

describe("prunePlan — photos removed during the run", () => {
  const withDropped = (aliases: string[]) =>
    photos.map((p) => (aliases.some((a) => aliasToId.get(a) === p.id) ? { ...p, keep: false } : p));

  it("unchanged plan when every photo is still kept", () => {
    const plan = fixturePlan();
    const r = prunePlan(plan, { aliasToId, photos });
    expect(r).toEqual({ plan, removed: 0, changed: false });
  });

  it("removes the photo, re-picks a layout for the page's photo count, and the doc validates", () => {
    const plan = fixturePlan();
    // page 2 is three-mixed [p3, p2, p4]; drop p2 → 2 photos left
    const ps = withDropped(["p2"]);
    const r = prunePlan(plan, { aliasToId, photos: ps });
    expect(r.changed).toBe(true);
    expect(r.removed).toBe(1);
    const page = r.plan.moments[0].pages[1];
    expect(page.photoIds).toEqual(["p3", "p4"]);
    expect(["two-vertical", "two-horizontal"]).toContain(page.layoutId);
    const out = planToDoc(r.plan, { ...base, photos: ps });
    expect("doc" in out).toBe(true);
    expect(JSON.stringify(out)).not.toContain(aliasToId.get("p2")!);
  });

  it("drops emptied pages and moments; replaces a removed cover with the first photo left", () => {
    const plan = fixturePlan();
    const all = plan.moments[1].pages.flatMap((pg) => pg.photoIds);
    const ps = withDropped([...all, plan.coverPhotoId]);
    const r = prunePlan(plan, { aliasToId, photos: ps });
    expect(r.plan.moments).toHaveLength(plan.moments.length - 1);
    expect(r.plan.coverPhotoId).not.toBe(plan.coverPhotoId);
    expect(r.plan.coverPhotoId).toBe(r.plan.moments[0].pages[0].photoIds[0]);
    const out = planToDoc(r.plan, { ...base, photos: ps });
    expect("doc" in out).toBe(true);
  });

  it("everything removed → empty plan that planToDoc rejects (caller falls back to rule)", () => {
    const plan = fixturePlan();
    const used = plan.moments.flatMap((m) => m.pages.flatMap((pg) => pg.photoIds));
    const ps = withDropped([...used, plan.coverPhotoId]);
    const r = prunePlan(plan, { aliasToId, photos: ps });
    expect(r.plan.moments).toEqual([]);
    expect("issues" in planToDoc(r.plan, { ...base, photos: ps })).toBe(true);
  });
});
