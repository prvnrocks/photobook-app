// Page skeleton of a Balanced Storybook (Task 6; story v4 2026-11-19). Pure and deterministic: the
// same outline always gives the same pages, block ids and shares.
//
// Story v4 — "a story book, not a photo tour": every chapter opens on ONE chapter story page
// (header band with the chapter title and a subtitle, the hero photo, a headline, ONE paragraph
// about why the moment matters and a closing line); the rest of the chapter is photo-led — no
// paragraph narration, only short captions where they add meaning. The book closes on the closing
// reflection page (books with ≥ 10 photos). Page area model (src/lib/storybook/balance.ts): every
// inner page counts once and `narrativeShare` is the part of it given to text.
//
//   chapter_opener   chapter story page: subtitle, headline, intro, closing_line  share 0.60
//   photo            photos, optionally with a short caption                      share 0.10 / 0
//   closing          the closing reflection (no photos)                           share 1.00
//
// Steps: (1) one chapter story page per chapter, the remaining photos of each moment on photo
// pages — 2 per page, more per page (up to 6) when the book's page limit needs it, then
// neighbouring pages are merged, and only as a last resort the last pages of the largest moments
// are left out (reported in `omittedPhotos`); (2) captions towards the 35 % narrative target, at
// most one on every second photo page of a chapter (photo-led pages stay photo-led). The 65 / 35
// target is now a CEILING the skeleton approaches, not a promise: with text only on the chapter
// page and short captions a photo-rich book lands below it, and `balance.drift` says by how much
// (D-109). No page is ever created to hit the ratio.

import { balanceOf, type StoryBalance } from "@/lib/storybook/balance";
import { STORY_BALANCE, STORY_LIMITS } from "@/lib/storybook/schemas";
import type { NarrativeKind, StoryPageKind } from "@/lib/storybook/types";

/** Bumped when the page skeleton changes (stored plans with another skeleton are re-planned). 4 = chapter story pages. */
export const SKELETON_VERSION = 4;
export const SKELETON_SHARES = { opener: 0.6, mixed: 0.4, caption: 0.1, closing: 1 } as const;
/** The chapter story page's lines (block ids follow this order; the paragraph first — it is the page's main text, the template places each line by its kind). */
export const CHAPTER_STORY_BLOCKS: readonly NarrativeKind[] = ["intro", "subtitle", "headline", "closing_line"];
export const SKELETON_PHOTOS_PER_PAGE = { preferred: 2, max: STORY_LIMITS.photosPerPage } as const;

export type SkeletonMoment = { id: string; photoIds: readonly string[] };
export type SkeletonChapter = { id: string; momentIds: readonly string[]; heroPhotoId: string; narrativeMomentIds: readonly string[] };
export type SkeletonInput = { moments: readonly SkeletonMoment[]; chapters: readonly SkeletonChapter[]; closing: boolean; maxPages: number };

export type SkeletonBlock = { id: string; kind: NarrativeKind };
export type SkeletonPage = {
  id: string;
  kind: StoryPageKind;
  chapterId: string | null;
  momentId: string | null;
  photoIds: string[];
  blocks: SkeletonBlock[];
  narrativeShare: number;
};
export type Skeleton = { pages: SkeletonPage[]; omittedPhotos: number; balance: StoryBalance };

type Draft = { kind: StoryPageKind; chapterId: string | null; momentId: string | null; photoIds: string[]; blocks: NarrativeKind[]; hundredths: number };

/** Splits `items` into ceil(n / per) groups of nearly equal size, in order. */
function chunk<T>(items: readonly T[], per: number): T[][] {
  if (items.length === 0) return [];
  const groups = Math.ceil(items.length / per);
  const out: T[][] = [];
  let at = 0;
  for (let g = 0; g < groups; g++) {
    const size = Math.ceil((items.length - at) / (groups - g));
    out.push(items.slice(at, at + size));
    at += size;
  }
  return out;
}

function layOut(input: SkeletonInput, per: number): Draft[] {
  const momentById = new Map(input.moments.map((m) => [m.id, m]));
  const pages: Draft[] = [];
  for (const c of input.chapters) {
    const heroMoment = c.momentIds.find((id) => momentById.get(id)?.photoIds.includes(c.heroPhotoId)) ?? c.momentIds[0] ?? null;
    pages.push({ kind: "chapter_opener", chapterId: c.id, momentId: heroMoment, photoIds: [c.heroPhotoId], blocks: [...CHAPTER_STORY_BLOCKS], hundredths: Math.round(SKELETON_SHARES.opener * 100) });
    for (const mid of c.momentIds) {
      const rest = (momentById.get(mid)?.photoIds ?? []).filter((id) => id !== c.heroPhotoId);
      for (const photoIds of chunk(rest, per)) pages.push({ kind: "photo", chapterId: c.id, momentId: mid, photoIds, blocks: [], hundredths: 0 });
    }
  }
  if (input.closing) pages.push({ kind: "closing", chapterId: null, momentId: null, photoIds: [], blocks: ["closing"], hundredths: 100 });
  return pages;
}

/** Brings the page count down to `maxPages`: merge neighbours first, then leave pages out. */
function fit(pages: Draft[], maxPages: number): number {
  let omitted = 0;
  while (pages.length > maxPages) {
    let best = -1;
    let bestSize = Infinity;
    for (let i = 0; i + 1 < pages.length; i++) {
      const a = pages[i]!;
      const b = pages[i + 1]!;
      if (a.kind !== "photo" || b.kind !== "photo" || a.chapterId !== b.chapterId) continue;
      const size = a.photoIds.length + b.photoIds.length;
      if (size <= SKELETON_PHOTOS_PER_PAGE.max && size < bestSize) {
        best = i;
        bestSize = size;
      }
    }
    if (best >= 0) {
      pages[best]!.photoIds.push(...pages[best + 1]!.photoIds);
      pages.splice(best + 1, 1);
      continue;
    }
    // nothing left to merge: drop the last page of the moment with the most pages (later moment on a tie)
    const count = new Map<string, number>();
    for (const p of pages) if (p.kind === "photo") count.set(`${p.chapterId}/${p.momentId}`, (count.get(`${p.chapterId}/${p.momentId}`) ?? 0) + 1);
    let victim = -1;
    let most = 0;
    pages.forEach((p, i) => {
      if (p.kind !== "photo") return;
      const n = count.get(`${p.chapterId}/${p.momentId}`)!;
      if (n >= most) {
        most = n;
        victim = i;
      }
    });
    if (victim >= 0) {
      omitted += pages[victim]!.photoIds.length;
      pages.splice(victim, 1);
      continue;
    }
    const closing = pages.findIndex((p) => p.kind === "closing");
    if (closing >= 0) pages.splice(closing, 1);
    else break; // only chapter openers are left
  }
  return omitted;
}

/**
 * Captions towards the narrative target: on photo pages only, at most one on every second photo
 * page of a chapter (spread evenly through it), none when the book is already at the target.
 * The writer may leave a caption out when it would not add meaning (service.ts).
 */
function balancePages(pages: Draft[]): void {
  const targetHundredths = Math.round(STORY_BALANCE.narrativeShare * 100) * pages.length;
  let gap = targetHundredths - pages.reduce((s, p) => s + p.hundredths, 0);
  const captionStep = Math.round(SKELETON_SHARES.caption * 100);
  if (gap < captionStep / 2) return;
  const chapters = [...new Set(pages.filter((p) => p.kind === "photo").map((p) => p.chapterId))];
  // candidates: every second photo page of each chapter (the 2nd, 4th …), chapters interleaved
  const perChapter = chapters.map((c) => pages.filter((p) => p.kind === "photo" && p.chapterId === c).filter((_, i) => i % 2 === 1));
  const order: Draft[] = [];
  for (let i = 0; perChapter.some((l) => i < l.length); i++) for (const l of perChapter) if (l[i]) order.push(l[i]!);
  for (const p of order) {
    if (gap < captionStep / 2) break;
    p.blocks = ["caption"];
    p.hundredths = captionStep;
    gap -= captionStep;
  }
}

export function buildSkeleton(input: SkeletonInput): Skeleton {
  const maxPages = Math.max(1, Math.min(STORY_LIMITS.pagesPerBook, Math.floor(input.maxPages)));
  let drafts = layOut(input, SKELETON_PHOTOS_PER_PAGE.preferred);
  for (let per = SKELETON_PHOTOS_PER_PAGE.preferred + 1; drafts.length > maxPages && per <= SKELETON_PHOTOS_PER_PAGE.max; per++) drafts = layOut(input, per);
  const omittedPhotos = fit(drafts, maxPages);
  balancePages(drafts);

  let block = 0;
  const pages: SkeletonPage[] = drafts.map((d, i) => ({
    id: `pg${i + 1}`,
    kind: d.kind,
    chapterId: d.chapterId,
    momentId: d.momentId,
    photoIds: [...d.photoIds],
    blocks: d.blocks.map((kind) => ({ id: `b${++block}`, kind })),
    narrativeShare: d.hundredths / 100,
  }));
  return { pages, omittedPhotos, balance: balanceOf(pages) };
}
