// The story plan (Task 6): a coherent OUTLINE — chapters made of moments, a title and a one-line
// arc per chapter, which moments get a paragraph, the hero photo of each chapter — plus the page
// skeleton computed in code (skeleton.ts). No page text. Pure: schema, chapter-count rules, the
// deterministic rule planner and the code-side validation of a model / client supplied outline.
//
// A StoryPlan is plain JSON. It is returned to the caller, may travel through a client, and is
// handed back to writeStory(), which trusts none of it: `checkPlanAgainstBook` re-validates the
// shape, the ids, the chapter rules, the grounding of every title / arc and re-computes the
// skeleton (a tampered share or page is a mismatch).

import { z } from "zod";
import { CAPTION_LANGS } from "@/lib/book/options";
import { NARRATIVE_KINDS, STORY_LIMITS, STORY_PAGE_KINDS } from "@/lib/storybook/schemas";
import { clipText } from "@/lib/text/clip";
import { ARC_MAX_CHARS, TITLE_MAX_CHARS, TITLE_MAX_WORDS, checkPlanText, type GroundingIssue, type PlanTextContext } from "./grounding";
import { pickChapterHero } from "./chapter-page";
import type { StoryInputs, StoryMoment } from "./inputs";
import { buildSkeleton, type Skeleton } from "./skeleton";
import { StoryBriefSchema, type StoryBrief } from "@/lib/storybook/brief";

export const STORY_PLAN_VERSION = 1;

export const PLAN_FALLBACK_REASONS = [
  "ai_off",
  "no_photos",
  "limit_reached", // plans per book
  "budget_exhausted", // daily AI budget
  "usage_unavailable", // migration 2600 not applied: live calls are refused
  "refused",
  "model_error", // timeout / rate limit / 5xx after retries
  "invalid_output", // the outline failed validation twice
] as const;
export type PlanFallbackReason = (typeof PLAN_FALLBACK_REASONS)[number];

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[1-9]\\d{0,3}$`));
const share = z.number().min(0).max(1);
const line = (max: number) =>
  z
    .string()
    .min(1)
    .refine((v) => [...v].length <= max && v.trim().length > 0, { message: "length" });

export const StoryPlanSchema = z
  .object({
    v: z.literal(STORY_PLAN_VERSION),
    bookId: uuid,
    source: z.enum(["ai", "rule"]),
    fallbackReason: z.enum(PLAN_FALLBACK_REASONS).nullable(),
    lang: z.enum(CAPTION_LANGS),
    photoCount: z.number().int().min(0).max(STORY_LIMITS.photosPerBook),
    /** Suggestion; the user's own book title always wins. */
    title: line(TITLE_MAX_CHARS).nullable(),
    subtitle: line(TITLE_MAX_CHARS).nullable(),
    moments: z
      .array(
        z
          .object({
            id: id("m"),
            photoIds: z.array(uuid).min(1).max(STORY_LIMITS.photosPerBook),
            label: z.string().min(1).max(STORY_LIMITS.shortText),
            dateLabel: z.string().min(1).max(40).nullable(),
            place: z.string().min(1).max(STORY_LIMITS.shortText).nullable(),
          })
          .strict(),
      )
      .max(STORY_LIMITS.momentsPerBook),
    chapters: z
      .array(
        z
          .object({
            id: id("c"),
            title: line(TITLE_MAX_CHARS),
            momentIds: z.array(id("m")).min(1).max(STORY_LIMITS.momentsPerBook),
            /** What the chapter is about — internal, never printed. */
            arc: line(ARC_MAX_CHARS),
            beats: z.object({ heroPhotoId: uuid, narrativeMomentIds: z.array(id("m")).max(STORY_LIMITS.momentsPerBook) }).strict(),
          })
          .strict(),
      )
      .max(STORY_LIMITS.chaptersPerBook),
    /** A closing reflection page (yes unless the book has fewer than 10 photos). */
    closing: z.boolean(),
    skeleton: z
      .object({
        pages: z
          .array(
            z
              .object({
                id: id("pg"),
                kind: z.enum(STORY_PAGE_KINDS),
                chapterId: id("c").nullable(),
                momentId: id("m").nullable(),
                photoIds: z.array(uuid).max(STORY_LIMITS.photosPerPage),
                blocks: z.array(z.object({ id: id("b"), kind: z.enum(NARRATIVE_KINDS) }).strict()).max(STORY_LIMITS.blocksPerPage),
                narrativeShare: share,
              })
              .strict(),
          )
          .max(STORY_LIMITS.pagesPerBook),
        omittedPhotos: z.number().int().min(0),
        balance: z.object({ pages: z.number().int().min(0), photoShare: share, narrativeShare: share, drift: z.number().min(-1).max(1) }).strict(),
      })
      .strict(),
    contextRev: z.number().int().min(1).nullable(),
    generator: z.object({ model: z.string().min(1).max(64).nullable(), promptVersion: z.string().min(1).max(40) }).strict(),
    /** v3: the validated StoryBrief the outline follows (absent on plans made before v3). */
    brief: StoryBriefSchema.optional(),
  })
  .strict();
export type StoryPlan = z.infer<typeof StoryPlanSchema>;
export type StoryPlanChapter = StoryPlan["chapters"][number];

/** The part of a plan a planner (model or rule) decides; everything else is derived in code. */
export type PlanOutline = { title: string | null; subtitle: string | null; chapters: StoryPlanChapter[] };

// ---------------------------------------------------------------------------- chapter counts

export type ChapterRange = { min: number; max: number; target: number };

/**
 * How many chapters a book may have. By kept photos: < 10 → 1; 10–19 → 1–2; 20–39 → 2–4 (about
 * 3); 40–60 → 3–4; > 60 → 4–6. Never more chapters than moments ("do not force unnecessary
 * chapters": one moment is one chapter, whatever the count says).
 */
export function chapterCountRange(photoCount: number, momentCount: number, visitCount?: number): ChapterRange {
  const base: ChapterRange =
    photoCount < 10
      ? { min: 1, max: 1, target: 1 }
      : photoCount < 20
        ? { min: 1, max: 2, target: 2 }
        : photoCount < 40
          ? { min: 2, max: 4, target: 3 }
          : photoCount <= 60
            ? { min: 3, max: 4, target: 4 }
            : { min: 4, max: 6, target: photoCount > 100 ? 6 : 5 };
  const cap = Math.max(1, momentCount);
  // v4: one visit (scenes of one day at one place) may be ONE chapter — the minimum and the rule
  // planner's target follow the visits; the planner may still split a long visit up to the cap
  const visits = Math.max(1, Math.min(cap, visitCount ?? cap));
  return { min: Math.min(base.min, visits), max: Math.min(base.max, cap), target: Math.min(base.target, visits) };
}

/**
 * v4: visits = moments that share a day and a place (scenes of one café visit are one visit). A
 * moment without a date is its own visit. One visit is one chapter (one chapter story page).
 */
export function visitCountOf(moments: readonly Pick<StoryMoment, "id" | "dateLabel" | "place">[]): number {
  return new Set(moments.map((m) => (m.dateLabel ? `${m.dateLabel}|${m.place ?? ""}` : m.id))).size;
}

export const wantsClosing = (photoCount: number) => photoCount >= 10;

/** Contiguous split of the moments into `count` groups with nearly equal photo counts. */
export function splitMoments(moments: readonly StoryMoment[], count: number): StoryMoment[][] {
  const k = Math.max(1, Math.min(count, moments.length));
  const total = moments.reduce((s, m) => s + m.photoIds.length, 0);
  const out: StoryMoment[][] = [];
  let at = 0;
  let done = 0;
  for (let g = 0; g < k; g++) {
    const group: StoryMoment[] = [];
    const want = (total - done) / (k - g);
    let size = 0;
    // at least one moment per group, and leave one for every group still to come
    while (at < moments.length && moments.length - at > k - g - 1) {
      const next = moments[at]!.photoIds.length;
      if (group.length > 0 && g < k - 1 && Math.abs(size + next - want) > Math.abs(size - want)) break;
      group.push(moments[at]!);
      size += next;
      at++;
    }
    done += size;
    out.push(group);
  }
  return out;
}

function defaultHero(moments: readonly StoryMoment[]): string {
  const biggest = [...moments].sort((a, b) => b.photoIds.length - a.photoIds.length)[0]!;
  return biggest.heroPhotoId ?? biggest.photoIds[0]!;
}

/**
 * v4: the chapter's hero = the photo that best shows who the story is about (chapter-page.ts
 * pickChapterHero over the chapter's analysed photos); `preferred` (the planner's / the moment's
 * pick) wins a tie. Falls back to the largest moment's hero when nothing is analysed.
 */
export function chapterHero(inputs: StoryInputs, momentIds: readonly string[], preferred: string | null, brief?: Pick<StoryBrief, "relationships"> | null): string {
  const ids = new Set(momentIds);
  const photos = inputs.photos.filter((p) => ids.has(p.momentId));
  const moments = inputs.moments.filter((m) => ids.has(m.id));
  const fallback = preferred && photos.some((p) => p.id === preferred) ? preferred : defaultHero(moments);
  return pickChapterHero(photos, inputs, { preferred: fallback, brief }) ?? fallback;
}

/** Neutral titles / arc used when a moment label cannot be a title (too long once clipped, a stock phrase …). */
const FALLBACK_TITLES: Record<"en" | "ar", readonly string[]> = {
  en: ["The beginning", "Along the way", "Later on", "Further on", "Near the end", "The last pages"],
  ar: ["البداية", "في الطريق", "بعد ذلك", "لاحقًا", "قرب النهاية", "الصفحات الأخيرة"],
};
const FALLBACK_ARC: Record<"en" | "ar", string> = { en: "Photos from this part of the book.", ar: "صور من هذا الجزء من الكتاب." };

/**
 * Deterministic outline without a model: chapters by an even split of the moments, titles and
 * arcs from the moments' own grounded labels (place from metadata, subject from what most photos
 * show, date from the timestamps, or the user's own label). Every title / arc passes the same
 * grounding check a model outline has to pass.
 */
export function ruleOutline(inputs: StoryInputs): PlanOutline {
  const range = chapterCountRange(inputs.photos.length, inputs.moments.length, visitCountOf(inputs.moments));
  const used = new Set<string>();
  const chapters = splitMoments(inputs.moments, range.target).map((group, i): StoryPlanChapter => {
    const momentIds = group.map((m) => m.id);
    const ctx = chapterTextContext(inputs, momentIds);
    const bySize = [...group].sort((a, b) => b.photoIds.length - a.photoIds.length);
    const fallbacks = FALLBACK_TITLES[inputs.lang];
    const candidates = [
      // v4: a long "<subject> · <place>" label also offers its subject alone (titles are ≤ 5 words)
      ...bySize.flatMap((m) => [m.label, ...(m.label.includes(" · ") ? [m.label.split(" · ")[0]!.trim()] : []), ...(m.dateLabel ? [`${m.label} · ${m.dateLabel}`] : [])]).filter((t) => t && [...t].length <= TITLE_MAX_CHARS),
      // v4: a neutral title reads better in the header band than a bare date
      fallbacks[i % fallbacks.length]!,
      ...bySize.flatMap((m) => (m.dateLabel ? [m.dateLabel] : [])),
    ];
    const title = candidates.find((t) => !used.has(t.toLowerCase()) && checkPlanText("t", "title", t, ctx).length === 0) ?? fallbacks[i % fallbacks.length]!;
    used.add(title.toLowerCase());
    const labels = clipText([...new Set(group.map((m) => m.label))].join("; "), ARC_MAX_CHARS, "");
    const arc = labels && checkPlanText("a", "arc", labels, ctx).length === 0 ? labels : FALLBACK_ARC[inputs.lang];
    return { id: `c${i + 1}`, title, momentIds, arc, beats: { heroPhotoId: chapterHero(inputs, momentIds, null), narrativeMomentIds: [] } };
  });
  return { title: null, subtitle: null, chapters };
}

// ---------------------------------------------------------------------------- validation

export const PLAN_ISSUE_CODES = ["chapter_count", "moments", "empty_chapter", "duplicate_title", "ungrounded", "title_length", "hero", "skeleton", "photos", "closing", "stale"] as const;
export type PlanIssueCode = (typeof PLAN_ISSUE_CODES)[number];
export type PlanIssue = { code: PlanIssueCode; chapterId?: string; grounding?: GroundingIssue[] };

/** Grounding context of one chapter's title / arc: all facts + the chapter's own metadata. */
export function chapterTextContext(inputs: StoryInputs, momentIds: readonly string[]): PlanTextContext {
  const ids = new Set(momentIds);
  const moments = inputs.moments.filter((m) => ids.has(m.id));
  const photos = inputs.photos.filter((p) => ids.has(p.momentId));
  return {
    lang: inputs.lang,
    facts: inputs.facts.map((f) => ({ kind: f.kind, text: f.text })),
    metadata: [...moments.flatMap((m) => [m.label, m.dateLabel, m.place]), ...photos.flatMap((p) => [p.place, p.dateLabel])].filter((x): x is string => !!x),
    evidence: photos.map((p) => [p.description ?? "", ...p.objects, ...p.activities].join(" . ")),
    avoid: inputs.avoid,
    maxWords: TITLE_MAX_WORDS,
  };
}

/**
 * Structure + grounding of an outline against the book's inputs. `chapters[].beats` must already
 * use photo uuids. Returns every problem found (empty = valid).
 */
export function checkOutline(outline: PlanOutline, inputs: StoryInputs, opts: { allowDuplicateTitles?: boolean } = {}): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const range = chapterCountRange(inputs.photos.length, inputs.moments.length, visitCountOf(inputs.moments));
  const n = outline.chapters.length;
  if (n < range.min || n > range.max) issues.push({ code: "chapter_count" });
  if (outline.chapters.some((c) => c.momentIds.length === 0)) issues.push({ code: "empty_chapter" });
  // every moment in exactly one chapter, in order
  const flat = outline.chapters.flatMap((c) => c.momentIds);
  const expected = inputs.moments.map((m) => m.id);
  if (flat.length !== expected.length || flat.some((mid, i) => mid !== expected[i])) issues.push({ code: "moments" });
  if (outline.chapters.some((c, i) => c.id !== `c${i + 1}`)) issues.push({ code: "moments" });

  const titles = new Set<string>();
  const photoMoment = new Map(inputs.photos.map((p) => [p.id, p.momentId]));
  for (const c of outline.chapters) {
    const key = c.title.trim().toLowerCase();
    if (titles.has(key) && !opts.allowDuplicateTitles) issues.push({ code: "duplicate_title", chapterId: c.id });
    titles.add(key);
    if ([...c.title.trim()].length > TITLE_MAX_CHARS) issues.push({ code: "title_length", chapterId: c.id });
    const heroMoment = photoMoment.get(c.beats.heroPhotoId);
    if (!heroMoment || !c.momentIds.includes(heroMoment)) issues.push({ code: "hero", chapterId: c.id });
    if (c.beats.narrativeMomentIds.some((m) => !c.momentIds.includes(m))) issues.push({ code: "hero", chapterId: c.id });
    const ctx = chapterTextContext(inputs, c.momentIds);
    const grounding = [...checkPlanText(`${c.id}:title`, "title", c.title, ctx), ...checkPlanText(`${c.id}:arc`, "arc", c.arc, ctx)];
    if (grounding.length) issues.push({ code: "ungrounded", chapterId: c.id, grounding });
  }
  return issues;
}

/** A grounded book title / subtitle suggestion, or null (a bad suggestion never fails the plan). */
export function acceptedBookTitle(text: string | null, inputs: StoryInputs): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  // the book title / subtitle keep the 60-character limit only (the 5-word limit is for chapter titles)
  const ctx = { ...chapterTextContext(inputs, inputs.moments.map((m) => m.id)), maxWords: undefined };
  return checkPlanText("title", "title", t, ctx).length === 0 ? t : null;
}

export function skeletonFor(outline: PlanOutline, inputs: StoryInputs, closing: boolean, maxPages: number): Skeleton {
  return buildSkeleton({
    moments: inputs.moments.map((m) => ({ id: m.id, photoIds: m.photoIds })),
    chapters: outline.chapters.map((c) => ({ id: c.id, momentIds: c.momentIds, heroPhotoId: c.beats.heroPhotoId, narrativeMomentIds: c.beats.narrativeMomentIds })),
    closing,
    maxPages,
  });
}

export function assemblePlan(args: {
  bookId: string;
  outline: PlanOutline;
  inputs: StoryInputs;
  maxPages: number;
  source: "ai" | "rule";
  fallbackReason: PlanFallbackReason | null;
  model: string | null;
  promptVersion: string;
  /** v3: the validated brief (stored with the plan, then with the storybook version). */
  brief?: StoryBrief;
}): StoryPlan {
  const { inputs, outline } = args;
  const closing = wantsClosing(inputs.photos.length);
  return {
    v: STORY_PLAN_VERSION,
    bookId: args.bookId,
    source: args.source,
    fallbackReason: args.fallbackReason,
    lang: inputs.lang,
    photoCount: inputs.photos.length,
    title: outline.title,
    subtitle: outline.subtitle,
    moments: inputs.moments.map((m) => ({ id: m.id, photoIds: [...m.photoIds], label: m.label, dateLabel: m.dateLabel, place: m.place })),
    chapters: outline.chapters,
    closing,
    skeleton: skeletonFor(outline, inputs, closing, args.maxPages),
    contextRev: inputs.contextRev,
    generator: { model: args.model, promptVersion: args.promptVersion },
    ...(args.brief ? { brief: args.brief } : {}),
  };
}

/**
 * v3 "Regenerate story": the chapter STRUCTURE of an earlier plan (moments per chapter, hero
 * photo, paragraph moments) — the layout — kept for a new brief + titles + arcs, when that plan
 * still describes the book's moments exactly. Null = the book changed: plan from scratch.
 */
export function pinnedStructure(pinned: StoryPlan | null | undefined, inputs: StoryInputs): StoryPlan["chapters"] | null {
  if (!pinned) return null;
  const parsed = StoryPlanSchema.safeParse(pinned);
  if (!parsed.success) return null;
  const expected = inputs.moments.map((m) => ({ id: m.id, photoIds: m.photoIds, label: m.label, dateLabel: m.dateLabel, place: m.place }));
  if (!same(parsed.data.moments, expected) || parsed.data.photoCount !== inputs.photos.length || parsed.data.lang !== inputs.lang) return null;
  return parsed.data.chapters;
}

/** New titles / arcs on the pinned structure (by position); a missing or ungrounded one keeps the old text. */
export function applyPinned(pinned: StoryPlan["chapters"], fresh: PlanOutline | null, inputs: StoryInputs): PlanOutline {
  const used = new Set<string>();
  const chapters = pinned.map((c, i) => {
    const f = fresh?.chapters[i];
    const ctx = chapterTextContext(inputs, c.momentIds);
    const okTitle = (t: string | undefined): t is string => !!t && [...t].length <= TITLE_MAX_CHARS && !used.has(t.toLowerCase()) && checkPlanText("t", "title", t, ctx).length === 0;
    const okArc = (t: string | undefined): t is string => !!t && [...t].length <= ARC_MAX_CHARS && checkPlanText("a", "arc", t, ctx).length === 0;
    const fallbacks = FALLBACK_TITLES[inputs.lang];
    const title = [f?.title, c.title, ...fallbacks.slice(i % fallbacks.length), ...fallbacks].find(okTitle) ?? fallbacks[i % fallbacks.length]!;
    used.add(title.toLowerCase());
    const arc = [f?.arc, c.arc].find(okArc) ?? FALLBACK_ARC[inputs.lang];
    return { ...c, title, arc, momentIds: [...c.momentIds], beats: { heroPhotoId: c.beats.heroPhotoId, narrativeMomentIds: [...c.beats.narrativeMomentIds] } };
  });
  return { title: fresh?.title ?? null, subtitle: fresh?.subtitle ?? null, chapters };
}

/** Structural equality of plain JSON values (key order does not matter). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Is this plan (possibly from a client) a valid plan for THIS book as it is now? Checks the
 * book id, that the moments are exactly the book's current moments (same photos, same labels —
 * a foreign or unknown photo id, or a stale grouping, fails), the chapter rules, the grounding of
 * every title and arc, and that the skeleton equals the one the code computes (tampered pages,
 * blocks or shares fail).
 */
export function checkPlanAgainstBook(plan: StoryPlan, bookId: string, inputs: StoryInputs, maxPages: number): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (plan.bookId !== bookId) return [{ code: "stale" }];
  const expectedMoments = inputs.moments.map((m) => ({ id: m.id, photoIds: m.photoIds, label: m.label, dateLabel: m.dateLabel, place: m.place }));
  if (!same(plan.moments, expectedMoments) || plan.photoCount !== inputs.photos.length) {
    const known = new Set(inputs.photos.map((p) => p.id));
    return [{ code: plan.moments.some((m) => m.photoIds.some((p) => !known.has(p))) ? "photos" : "stale" }];
  }
  if (plan.lang !== inputs.lang) issues.push({ code: "stale" });
  if (plan.closing !== wantsClosing(inputs.photos.length)) issues.push({ code: "closing" });
  const outline: PlanOutline = { title: plan.title, subtitle: plan.subtitle, chapters: plan.chapters };
  issues.push(...checkOutline(outline, inputs, { allowDuplicateTitles: true }));
  for (const t of [plan.title, plan.subtitle]) if (t !== null && acceptedBookTitle(t, inputs) === null) issues.push({ code: "ungrounded" });
  if (issues.length === 0 && !same(plan.skeleton, skeletonFor(outline, inputs, plan.closing, maxPages))) issues.push({ code: "skeleton" });
  return issues;
}
