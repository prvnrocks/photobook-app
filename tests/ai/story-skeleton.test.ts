import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/ai/limits";
import type { StoryInputs, StoryMoment } from "@/lib/ai/story/inputs";
import { assemblePlan, chapterCountRange, checkPlanAgainstBook, ruleOutline, splitMoments, StoryPlanSchema, wantsClosing } from "@/lib/ai/story/plan";
import { buildSkeleton, SKELETON_SHARES, type SkeletonInput } from "@/lib/ai/story/skeleton";
import { isBalanced } from "@/lib/storybook/balance";
import { STORY_BALANCE, StoryPageSchema } from "@/lib/storybook/schemas";

// Task 6: chapter-count rules, the rule planner and the page skeleton (pure, deterministic).

const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** `sizes[i]` photos in moment i+1, photo uuids numbered in order. */
function inputsOf(sizes: number[], over: Partial<StoryInputs> = {}): StoryInputs {
  let n = 0;
  const moments: StoryMoment[] = sizes.map((size, i) => {
    const photoIds = Array.from({ length: size }, () => pid(++n));
    return { id: `m${i + 1}`, photoIds, label: `Scenery ${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${i >= 26 ? "x" : ""}`, dateLabel: null, place: null, heroPhotoId: photoIds[0]! };
  });
  let a = 0;
  const photos = moments.flatMap((m) =>
    m.photoIds.map((id) => ({ alias: `p${++a}`, id, momentId: m.id, dateLabel: null, place: null, description: "A quiet view of a garden.", scene: "landscape", objects: ["garden"], activities: [], storyRole: "establishing", atmosphere: "calm" })),
  );
  return { photos, moments, facts: [], avoid: [], lang: "en", occasion: "other", storyTone: null, narrator: "third", contextRev: null, mode: "observational", ...over };
}

/** n photos spread over `moments` moments as evenly as possible. */
const spread = (n: number, moments: number) => Array.from({ length: moments }, (_, i) => Math.floor(n / moments) + (i < n % moments ? 1 : 0)).filter((x) => x > 0);

function skeletonInput(inputs: StoryInputs, maxPages: number): SkeletonInput {
  const outline = ruleOutline(inputs);
  return {
    moments: inputs.moments,
    chapters: outline.chapters.map((c) => ({ id: c.id, momentIds: c.momentIds, heroPhotoId: c.beats.heroPhotoId, narrativeMomentIds: c.beats.narrativeMomentIds })),
    closing: wantsClosing(inputs.photos.length),
    maxPages,
  };
}

describe("chapter-count rules", () => {
  it.each([
    [5, { min: 1, max: 1, target: 1 }],
    [9, { min: 1, max: 1, target: 1 }],
    [10, { min: 1, max: 2, target: 2 }],
    [19, { min: 1, max: 2, target: 2 }],
    [20, { min: 2, max: 4, target: 3 }],
    [39, { min: 2, max: 4, target: 3 }],
    [40, { min: 3, max: 4, target: 4 }],
    [60, { min: 3, max: 4, target: 4 }],
    [61, { min: 4, max: 6, target: 5 }],
    [100, { min: 4, max: 6, target: 5 }],
    [140, { min: 4, max: 6, target: 6 }],
  ])("%i photos with plenty of moments → %o", (photos, range) => {
    expect(chapterCountRange(photos, 50)).toEqual(range);
  });

  it("never more chapters than moments: one moment is one chapter whatever the photo count", () => {
    for (const photos of [5, 10, 19, 20, 39, 40, 60, 100]) expect(chapterCountRange(photos, 1)).toEqual({ min: 1, max: 1, target: 1 });
    expect(chapterCountRange(60, 2)).toEqual({ min: 2, max: 2, target: 2 });
    expect(chapterCountRange(100, 3)).toEqual({ min: 3, max: 3, target: 3 });
  });

  it("a closing reflection is planned from 10 photos on", () => {
    expect(wantsClosing(9)).toBe(false);
    expect(wantsClosing(10)).toBe(true);
  });
});

describe("rule planner", () => {
  it.each([5, 10, 19, 20, 39, 40, 60, 100])("%i photos: chapter count in range, every moment once and in order, no empty chapter", (n) => {
    const inputs = inputsOf(spread(n, Math.max(1, Math.round(n / 4))));
    const outline = ruleOutline(inputs);
    const range = chapterCountRange(n, inputs.moments.length);
    expect(outline.chapters.length).toBe(range.target);
    expect(outline.chapters.flatMap((c) => c.momentIds)).toEqual(inputs.moments.map((m) => m.id));
    for (const c of outline.chapters) {
      expect(c.momentIds.length).toBeGreaterThan(0);
      expect(c.title.length).toBeLessThanOrEqual(60);
      const own = inputs.moments.filter((m) => c.momentIds.includes(m.id)).flatMap((m) => m.photoIds);
      expect(own).toContain(c.beats.heroPhotoId);
    }
    expect(new Set(outline.chapters.map((c) => c.title)).size).toBe(outline.chapters.length);
  });

  it("one moment of 100 photos stays one chapter", () => {
    expect(ruleOutline(inputsOf([100])).chapters).toHaveLength(1);
  });

  it("splits by photo count, not by moment count", () => {
    const groups = splitMoments(inputsOf([20, 1, 1, 1, 1]).moments, 2);
    expect(groups.map((g) => g.map((m) => m.id))).toEqual([["m1"], ["m2", "m3", "m4", "m5"]]);
  });

  it("titles come from the moments' own labels and are grounded; a label that cannot be a title falls back to a neutral one", () => {
    const inputs = inputsOf([6, 6]);
    inputs.moments[0]!.label = "Walking on a beach · Abu Dhabi";
    inputs.moments[0]!.place = "Abu Dhabi";
    inputs.moments[1]!.label = "A day to remember"; // a user label that is a stock phrase
    const outline = ruleOutline(inputs);
    expect(outline.chapters.map((c) => c.title)).toEqual(["Walking on a beach · Abu Dhabi", "Along the way"]);
    const plan = assemblePlan({ bookId: BOOK, outline, inputs, maxPages: 20, source: "rule", fallbackReason: "ai_off", model: null, promptVersion: "story-plan-1" });
    expect(StoryPlanSchema.safeParse(plan).success).toBe(true);
    expect(checkPlanAgainstBook(plan, BOOK, inputs, 20)).toEqual([]);
  });

  it("is deterministic", () => {
    const a = inputsOf(spread(37, 9));
    expect(ruleOutline(a)).toEqual(ruleOutline(inputsOf(spread(37, 9))));
  });
});

describe("page skeleton", () => {
  const FREE = LIMITS.free.maxPages;
  const PAID = LIMITS.paid.maxPages;

  it("is deterministic and block / page ids are sequential", () => {
    const input = skeletonInput(inputsOf(spread(24, 6)), FREE);
    const a = buildSkeleton(input);
    expect(buildSkeleton(input)).toEqual(a);
    expect(a.pages.map((p) => p.id)).toEqual(a.pages.map((_, i) => `pg${i + 1}`));
    expect(a.pages.flatMap((p) => p.blocks.map((b) => b.id))).toEqual(a.pages.flatMap((p) => p.blocks).map((_, i) => `b${i + 1}`));
  });

  it("24 photos in 3 chapters: an opener with the intro per chapter, mixed pages with one paragraph, photo pages, one closing page", () => {
    const inputs = inputsOf(spread(24, 6));
    const sk = buildSkeleton(skeletonInput(inputs, FREE));
    const kinds = sk.pages.map((p) => p.kind);
    expect(kinds.filter((k) => k === "chapter_opener")).toHaveLength(3);
    expect(kinds.filter((k) => k === "closing")).toHaveLength(1);
    expect(kinds[kinds.length - 1]).toBe("closing");
    expect(kinds.filter((k) => k === "mixed").length).toBeGreaterThan(0);
    for (const p of sk.pages) {
      if (p.kind === "chapter_opener") expect(p).toMatchObject({ narrativeShare: SKELETON_SHARES.opener, blocks: [{ kind: "intro" }] });
      if (p.kind === "mixed") expect(p).toMatchObject({ narrativeShare: SKELETON_SHARES.mixed, blocks: [{ kind: "paragraph" }] });
      if (p.kind === "closing") expect(p).toMatchObject({ narrativeShare: 1, photoIds: [], blocks: [{ kind: "closing" }] });
      if (p.kind === "photo") expect(p.narrativeShare === 0 ? p.blocks.length === 0 : ["caption", "pull_quote"].includes(p.blocks[0]!.kind)).toBe(true);
    }
    expect(sk.omittedPhotos).toBe(0);
    expect(sk.pages.flatMap((p) => p.photoIds).sort()).toEqual(inputs.photos.map((p) => p.id).sort());
  });

  it("balance lands within tolerance of 35 % narrative for 10–60 photos, whatever the grouping and the page limit", () => {
    for (let n = 10; n <= 60; n++) {
      for (const moments of [1, 2, 3, 5, 8, 13, n]) {
        for (const max of [FREE, PAID]) {
          const inputs = inputsOf(spread(n, Math.min(moments, n)));
          const sk = buildSkeleton(skeletonInput(inputs, max));
          expect(isBalanced(sk.balance), `${n} photos / ${moments} moments / ${max} pages → ${sk.balance.narrativeShare}`).toBe(true);
          expect(Math.abs(sk.balance.drift)).toBeLessThanOrEqual(STORY_BALANCE.tolerance);
          expect(sk.pages.length).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it.each([5, 10, 19, 20, 39, 40, 60, 100])("%i photos: every page is a valid story page with content; no page exists only for the ratio", (n) => {
    for (const max of [FREE, PAID]) {
      const sk = buildSkeleton(skeletonInput(inputsOf(spread(n, Math.max(1, Math.round(n / 3)))), max));
      expect(sk.pages.length).toBeLessThanOrEqual(max);
      for (const p of sk.pages) {
        // content = photos, or the closing reflection
        expect(p.photoIds.length > 0 || p.kind === "closing").toBe(true);
        expect(p.photoIds.length).toBeLessThanOrEqual(6);
        expect(p.blocks.length).toBeLessThanOrEqual(1);
        const asPage = { ...p, blocks: p.blocks.map((b) => ({ id: b.id, kind: b.kind, text: "x", lang: "en", provenance: { source: "ai", rev: 1, aiVersion: 1, editedAt: null }, groundedIn: [] })), layoutId: null, userLocked: false };
        expect(StoryPageSchema.safeParse(asPage).success, `${p.kind} ${p.narrativeShare}`).toBe(true);
      }
      expect(sk.pages.filter((p) => p.kind === "closing")).toHaveLength(n >= 10 ? 1 : 0);
      expect(new Set(sk.pages.flatMap((p) => p.photoIds)).size).toBe(sk.pages.flatMap((p) => p.photoIds).length);
    }
  });

  it("page limits: 100 photos fit the free 20 pages (denser pages, the rest reported as omitted) and all fit the paid 100", () => {
    const inputs = inputsOf(spread(100, 20));
    const free = buildSkeleton(skeletonInput(inputs, FREE));
    expect(free.pages.length).toBe(FREE);
    expect(free.omittedPhotos).toBe(100 - free.pages.flatMap((p) => p.photoIds).length);
    expect(isBalanced(free.balance)).toBe(true);
    const paid = buildSkeleton(skeletonInput(inputs, PAID));
    expect(paid.pages.length).toBeLessThanOrEqual(PAID);
    expect(paid.omittedPhotos).toBe(0);
    expect(isBalanced(paid.balance)).toBe(true);
  });

  it("many tiny moments are merged onto shared pages before any photo is left out", () => {
    const sk = buildSkeleton(skeletonInput(inputsOf(spread(40, 40)), FREE));
    expect(sk.pages.length).toBeLessThanOrEqual(FREE);
    expect(sk.omittedPhotos).toBe(0);
  });

  it("a handful of photos: no closing page, no filler page — the nearest balance is returned with its drift", () => {
    const one = buildSkeleton(skeletonInput(inputsOf([1]), FREE));
    expect(one.pages.map((p) => p.kind)).toEqual(["chapter_opener"]);
    expect(one.balance.drift).toBeCloseTo(0.15, 5);
    const five = buildSkeleton(skeletonInput(inputsOf([5]), FREE));
    expect(five.pages.some((p) => p.kind === "closing" || p.kind === "narrative")).toBe(false);
    expect(five.pages.every((p) => p.photoIds.length > 0)).toBe(true);
  });

  it("paragraphs go first to the moments the outline marked", () => {
    const inputs = inputsOf([7, 7, 7]);
    const input = skeletonInput(inputs, PAID);
    const chapters = input.chapters.map((c) => ({ ...c, narrativeMomentIds: c.momentIds.includes("m3") ? ["m3"] : [] }));
    const sk = buildSkeleton({ ...input, chapters });
    const firstOfM3 = sk.pages.find((p) => p.momentId === "m3" && p.kind !== "chapter_opener")!;
    expect(firstOfM3.kind).toBe("mixed");
  });

  it("a tampered skeleton, a foreign photo or a stale grouping is not a valid plan for the book", () => {
    const inputs = inputsOf(spread(24, 6));
    const plan = assemblePlan({ bookId: BOOK, outline: ruleOutline(inputs), inputs, maxPages: FREE, source: "rule", fallbackReason: "ai_off", model: null, promptVersion: "story-plan-1" });
    expect(checkPlanAgainstBook(plan, BOOK, inputs, FREE)).toEqual([]);
    const shares = structuredClone(plan);
    shares.skeleton.pages[1]!.narrativeShare = 0;
    expect(checkPlanAgainstBook(shares, BOOK, inputs, FREE).map((i) => i.code)).toEqual(["skeleton"]);
    const extraPage = structuredClone(plan);
    extraPage.skeleton.pages.push({ id: "pg99", kind: "closing", chapterId: null, momentId: null, photoIds: [], blocks: [{ id: "b99", kind: "closing" }], narrativeShare: 1 });
    expect(checkPlanAgainstBook(extraPage, BOOK, inputs, FREE).map((i) => i.code)).toEqual(["skeleton"]);
    const foreign = structuredClone(plan);
    foreign.moments[0]!.photoIds[0] = pid(9999);
    expect(checkPlanAgainstBook(foreign, BOOK, inputs, FREE).map((i) => i.code)).toEqual(["photos"]);
    expect(checkPlanAgainstBook(plan, BOOK, inputsOf(spread(24, 5)), FREE).map((i) => i.code)).toEqual(["stale"]);
    expect(checkPlanAgainstBook(plan, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", inputs, FREE).map((i) => i.code)).toEqual(["stale"]);
    const title = structuredClone(plan);
    title.chapters[0]!.title = "A week in Lisbon";
    expect(checkPlanAgainstBook(title, BOOK, inputs, FREE)[0]).toMatchObject({ code: "ungrounded", chapterId: "c1" });
    const paidPages = checkPlanAgainstBook(plan, BOOK, inputs, PAID);
    expect(paidPages).toEqual([]); // 24 photos fit both limits: the same skeleton
  });
});
