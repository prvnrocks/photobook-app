// Page skeleton of a Balanced Storybook (Task 6). Pure and deterministic: the same outline
// always gives the same pages, block ids and shares.
//
// The 65 / 35 photo / narrative balance is met BY CONSTRUCTION here, in code — the model never
// decides page kinds or shares. Page area model (see src/lib/storybook/balance.ts): every inner
// page counts once and `narrativeShare` is the part of it given to text.
//
//   chapter_opener   the chapter's hero photo + the chapter intro            share 0.50
//   mixed            photos of one moment + one paragraph                    share 0.40
//   photo            photos, optionally with a short caption / pull quote    share 0.10 / 0
//   closing          the closing reflection (no photos)                      share 1.00
//
// Steps: (1) one opener per chapter, the remaining photos of each moment on photo pages —
// 2 per page, more per page (up to 6) when the book's page limit needs it, then neighbouring
// pages are merged, and only as a last resort the last pages of the largest moments are left out
// (reported in `omittedPhotos`); (2) photo pages are turned into mixed pages, first in the
// moments the outline marked for a paragraph, until the narrative area is within one page-step
// of 35 %; (3) captions close the rest of the gap. No page is ever created to hit the ratio:
// when the photos do not allow it (a handful of photos) the nearest result is returned and
// `balance.drift` says how far off it is.

import { balanceOf, type StoryBalance } from "@/lib/storybook/balance";
import { STORY_BALANCE, STORY_LIMITS } from "@/lib/storybook/schemas";
import type { NarrativeKind, StoryPageKind } from "@/lib/storybook/types";

export const SKELETON_SHARES = { opener: 0.5, mixed: 0.4, caption: 0.1, closing: 1 } as const;
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

type Draft = { kind: StoryPageKind; chapterId: string | null; momentId: string | null; photoIds: string[]; block: NarrativeKind | null; hundredths: number };

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
    pages.push({ kind: "chapter_opener", chapterId: c.id, momentId: heroMoment, photoIds: [c.heroPhotoId], block: "intro", hundredths: 50 });
    for (const mid of c.momentIds) {
      const rest = (momentById.get(mid)?.photoIds ?? []).filter((id) => id !== c.heroPhotoId);
      for (const photoIds of chunk(rest, per)) pages.push({ kind: "photo", chapterId: c.id, momentId: mid, photoIds, block: null, hundredths: 0 });
    }
  }
  if (input.closing) pages.push({ kind: "closing", chapterId: null, momentId: null, photoIds: [], block: "closing", hundredths: 100 });
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

function balancePages(pages: Draft[], input: SkeletonInput): void {
  const targetHundredths = Math.round(STORY_BALANCE.narrativeShare * 100) * pages.length;
  let gap = targetHundredths - pages.reduce((s, p) => s + p.hundredths, 0);
  const photoPages = () => pages.filter((p) => p.kind === "photo" && p.block === null);

  // paragraph candidates, in priority order
  const wanted = new Set(input.chapters.flatMap((c) => c.narrativeMomentIds.map((m) => `${c.id}/${m}`)));
  const firstOfMoment = new Map<string, Draft>();
  const sizeOfMoment = new Map<string, number>();
  for (const p of pages) {
    if (p.kind !== "photo") continue;
    const key = `${p.chapterId}/${p.momentId}`;
    if (!firstOfMoment.has(key)) firstOfMoment.set(key, p);
    sizeOfMoment.set(key, (sizeOfMoment.get(key) ?? 0) + p.photoIds.length);
  }
  const firsts = [...firstOfMoment.entries()];
  const order: Draft[] = [
    ...firsts.filter(([k]) => wanted.has(k)).map(([, p]) => p),
    ...firsts
      .filter(([k]) => !wanted.has(k))
      .map(([k, p], i) => ({ p, size: sizeOfMoment.get(k)!, i }))
      .sort((a, b) => b.size - a.size || a.i - b.i)
      .map((x) => x.p),
  ];
  const taken = new Set(order);
  const others = pages.filter((p) => p.kind === "photo" && !taken.has(p));
  // the remaining pages alternate (every second one first) so paragraphs spread through the book
  order.push(...others.filter((_, i) => i % 2 === 0), ...others.filter((_, i) => i % 2 === 1));

  const mixedStep = Math.round(SKELETON_SHARES.mixed * 100);
  const captionStep = Math.round(SKELETON_SHARES.caption * 100);
  for (const p of order) {
    if (gap < mixedStep) break; // a smaller gap is closed with captions
    p.kind = "mixed";
    p.block = "paragraph";
    p.hundredths = mixedStep;
    gap -= mixedStep;
  }
  const free = photoPages();
  const captions = Math.max(0, Math.min(free.length, Math.round(gap / captionStep)));
  for (let i = 0; i < captions; i++) {
    const p = free[Math.floor((i * free.length) / captions)]!;
    p.block = "caption";
    p.hundredths = captionStep;
    gap -= captionStep;
  }
  if (gap >= mixedStep / 2) {
    const p = pages.find((x) => x.kind === "photo");
    if (p) {
      gap -= mixedStep - p.hundredths;
      p.kind = "mixed";
      p.block = "paragraph";
      p.hundredths = mixedStep;
    }
  }
  // one pull quote per chapter that has at least two captions (the second one)
  const seen = new Map<string | null, number>();
  for (const p of pages) {
    if (p.block !== "caption") continue;
    const n = (seen.get(p.chapterId) ?? 0) + 1;
    seen.set(p.chapterId, n);
    if (n === 2) p.block = "pull_quote";
  }
}

export function buildSkeleton(input: SkeletonInput): Skeleton {
  const maxPages = Math.max(1, Math.min(STORY_LIMITS.pagesPerBook, Math.floor(input.maxPages)));
  let drafts = layOut(input, SKELETON_PHOTOS_PER_PAGE.preferred);
  for (let per = SKELETON_PHOTOS_PER_PAGE.preferred + 1; drafts.length > maxPages && per <= SKELETON_PHOTOS_PER_PAGE.max; per++) drafts = layOut(input, per);
  const omittedPhotos = fit(drafts, maxPages);
  balancePages(drafts, input);

  let block = 0;
  const pages: SkeletonPage[] = drafts.map((d, i) => ({
    id: `pg${i + 1}`,
    kind: d.kind,
    chapterId: d.chapterId,
    momentId: d.momentId,
    photoIds: [...d.photoIds],
    blocks: d.block ? [{ id: `b${++block}`, kind: d.block }] : [],
    narrativeShare: d.hundredths / 100,
  }));
  return { pages, omittedPhotos, balance: balanceOf(pages) };
}
