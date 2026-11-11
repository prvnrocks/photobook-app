// "Update album" (D-028): re-lay out the CURRENT album after keep/drop changes on the review
// screen, with the rule-based filler — free, unlimited, never an AI call or an AI rebuild.
// Pure, deterministic, no I/O. Safe on client and server.
//
// Rules:
// 1. Removal: every slot photo that is no longer kept (dropped, deleted, or a repeat) is removed.
//    An affected page gets the best page layout for the photos left on it (bestPageLayout — same
//    fitting as prunePlan; photo order and crops kept; caption kept only when source "user" and
//    the new layout has a caption area — a page with a user caption prefers layouts that have
//    one, D-031), or is dropped when empty. A chapter that loses all its
//    pages is dropped. Untouched pages are returned as-is (layout, crops, captions, ids).
// 2. Additions: kept photos not on any page and not the cover go to the chapter whose time range
//    (min..max of its current photos) contains them (first in doc order); else the nearest dated
//    chapter by time (tie → earlier chapter); undated photos go to the last all-undated chapter.
//    Otherwise to ONE new trailing chapter "More moments". Per chapter the new photos are
//    appended as new pages right after the chapter's last page, filled by the autolayout greedy
//    filler (fillPages: orientation-aware, no opener, doesn't repeat the chapter's last layout).
//    Duplicate groups are NOT re-applied: the photo status (AI/rule curation + user override) is
//    the final decision, so a kept duplicate shown as "Kept" on the review screen is added.
// 3. Page cap = min(limitsFor(isPaid).maxPages, books.max_pages) (effectiveMaxPages). Over the
//    cap → newly added photos are dropped one at a time, blurriest first (blurScore null = 0, then
//    smallest pixel area, then largest id), until the album fits. Only if the existing pages alone
//    are over the cap (e.g. the cap shrank) are trailing pages removed — the one case where photos
//    that were already in the album are dropped (unavoidable).
// 4. Chapters whose photos changed get dateLabel recomputed from their photo dates (Asia/Dubai,
//    as autolayout/planToDoc) when any is dated, and `place` set to null when no remaining photo
//    has that place (grounding). Chapter titles, cover title/subtitle, style, occasion and meta
//    (generator, version, runId, userEdited) are kept as they are.
// 5. Cover: kept as is when its photo is still kept; otherwise (or when null) the best photo on
//    the pages — portrait first, then sharpest, largest, smallest id — or null when none is left.
// 6. Backgrounds (M10a, D-062): a photo background may use any ready photo of the book, kept or
//    dropped, so dropping a background photo on review keeps the background. A background whose
//    photo no longer exists at all (deleted) is removed: book default → white colour, page
//    override → removed (stripMissingBackgrounds). That alone counts as a change.
//    AI backgrounds (M10c T11, D-068): an AI photo background (source "ai") whose photo is no longer
//    KEPT (dropped or deleted), or that is no longer on its chapter's first page, is removed
//    (pruneAiBackgrounds: page → book default; an AI photo book background → style default). User
//    backgrounds and every colour / texture background are kept on their pages.
// 7. No change → the input doc object is returned with changed:false.
// 8. Design (M10b A10, D-063/D-064): every layout comes from the doc's own format + design style
//    (doc.format / doc.style.designStyle — the caller stamps them from the book's columns first):
//    bestPageLayout / fillPages with that design. Spreads: an untouched spread stays as is. A
//    spread that loses photos becomes a spread of the same style with exactly that many photos
//    when one fits every photo's orientation (a one-photo spread only for a panorama, aspect ≥
//    PANORAMA_RATIO; caption rules as rule 1), else its photos split into
//    its two halves (slot by the half its rect lies in, the caption with the caption rect's half)
//    and each non-empty half gets the best single-page layout (an empty half is dropped). New
//    pages are single pages. Over the cap, a trailing spread is removed as one unit. Finally
//    repairSpreads (D-064) splits any spread pushed onto a right-hand page into its twins — so the
//    result is always spread-aligned. Classic A5 portrait docs have no spreads: output unchanged.
// The removal step (rules 1 + 8) is exported as removeSlotPhotos: the photo-delete reflow
// (strip-photos.ts, M10b A19) reuses it, with keepUserCaptionPages so a user caption never goes.
// A design style without layouts (none since M10c T10; kept for unknown styles) throws UnsupportedDesignError.
// The result is checked with parseBookDoc + validateBookDoc (photoIds = kept, backgroundPhotoIds =
// every photo passed in, maxPages = cap);
// a failure throws RelayoutError (issue strings only, no user data) — the caller keeps the
// current album and reports a generic error.

import { dayRange, fillPages, PANORAMA_RATIO, parseTime } from "@/lib/autolayout";
import { dubaiDay, effectiveMaxPages, orientationOf, placeKey } from "@/lib/ai/story";
import { getLayout } from "@/lib/layouts";
import { bestPageLayout, designFitScore } from "@/lib/layouts/fit";
import { pruneAiBackgrounds } from "@/lib/design/background-suggest";
import { assertSupportedDesign, type BookDesign } from "./book-design";
import { clipText } from "@/lib/text/clip";
import type { CaptionLang } from "./options";
import { parseBookDoc, validateBookDoc } from "./schema";
import { rectHalf, repairSpreads } from "./spreads";
import { stripMissingBackgrounds } from "./strip-backgrounds";
import type { BookDoc, BookPage, Chapter, Crop, Slot } from "./types";

export interface RelayoutPhoto {
  id: string;
  width: number;
  height: number;
  takenAt: string | null;
  status: "kept" | "dropped";
  place: string | null;
  dupGroup: number | null;
  blurScore: number | null;
}

export interface RelayoutOptions {
  isPaid: boolean;
  /** books.max_pages (server-set). */
  maxPages: number;
  /** Accepted for symmetry with autolayout; the re-layout writes no language-dependent text. */
  captionLang: CaptionLang;
  /** The doc's meta (incl. runId) is kept as is; a re-layout is not a run. */
  runId?: null;
}

export interface RelayoutResult {
  doc: BookDoc;
  changed: boolean;
  /** Photos newly placed on pages. */
  added: number;
  /** Slot photos removed from pages (dropped/deleted photos, plus trailing pages over the cap). */
  removed: number;
  /** Kept photos that could not be added because of the page cap. */
  skipped: number;
}

export class RelayoutError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`relayout produced an invalid doc (${issues.length} issues)`);
    this.name = "RelayoutError";
    this.issues = issues;
  }
}

export const MORE_MOMENTS_TITLE = "More moments";

const CENTER: Crop = { x: 0.5, y: 0.5, zoom: 1 };
const ID_RE = /^[\s\S]{1,64}$/;
/** Key of the new trailing chapter in the assignment map (never a real chapter id: ids are ≤ 64). */
const NEW_CHAPTER = Symbol("new-chapter");
type ChapterKey = string | typeof NEW_CHAPTER;

const cmpId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sharpOf = (p: RelayoutPhoto) => (Number.isFinite(p.blurScore) ? (p.blurScore as number) : 0);
const areaOf = (p: RelayoutPhoto) =>
  (Number.isFinite(p.width) && p.width > 0 ? p.width : 0) * (Number.isFinite(p.height) && p.height > 0 ? p.height : 0);

const ratioOf = (p: Pick<RelayoutPhoto, "width" | "height">) => {
  const w = Number.isFinite(p.width) && p.width > 0 ? p.width : 0;
  const h = Number.isFinite(p.height) && p.height > 0 ? p.height : 0;
  return w > 0 && h > 0 ? w / h : 1;
};

/** Negative = a is the better photo (sharper, larger, smaller id). */
function betterFirst(a: RelayoutPhoto, b: RelayoutPhoto): number {
  return sharpOf(b) - sharpOf(a) || areaOf(b) - areaOf(a) || cmpId(a.id, b.id);
}

/** Sequential ids ("p7", "c3") that don't clash with existing ones. */
function idAllocator(prefix: string, used: Iterable<string>, start: number): () => string {
  const taken = new Set(used);
  let n = start;
  return () => {
    while (taken.has(`${prefix}${n}`)) n++;
    const id = `${prefix}${n}`;
    taken.add(id);
    return id;
  };
}

function dateLabelOf(photos: RelayoutPhoto[]): string | null {
  const days: number[] = [];
  for (const p of photos) {
    const ms = parseTime(p.takenAt);
    if (ms !== null) days.push(dubaiDay(ms));
  }
  return days.length ? clipText(dayRange(Math.min(...days), Math.max(...days)), 40) : null;
}

export function relayoutDoc(doc: BookDoc, photos: readonly RelayoutPhoto[], opts: RelayoutOptions): RelayoutResult {
  const maxPages = effectiveMaxPages({ isPaid: opts.isPaid, maxPages: opts.maxPages });

  const byId = new Map<string, RelayoutPhoto>();
  for (const p of photos) if (typeof p.id === "string" && ID_RE.test(p.id) && !byId.has(p.id)) byId.set(p.id, p);
  const isKept = (id: string | null): id is string => id !== null && byId.get(id)?.status === "kept";
  const photo = (id: string) => byId.get(id) as RelayoutPhoto; // only called for kept ids

  const nextPageId = idAllocator("p", doc.pages.map((p) => p.id), doc.pages.length + 1);
  const nextChapterId = idAllocator("c", doc.chapters.map((c) => c.id), doc.chapters.length + 1);

  // ---- 1. removals ---------------------------------------------------------------------------
  const design: BookDesign = { format: doc.format, designStyle: doc.style.designStyle ?? "classic" };
  assertSupportedDesign(design); // review S1: typed UnsupportedDesignError, before any change
  const removal = removeSlotPhotos(doc, { keep: isKept, photo, design, nextPageId });
  let removed = removal.removed;
  const touched = removal.touched; // chapter ids whose photo set changed
  let pages: BookPage[] = removal.pages;

  // ---- 2. additions --------------------------------------------------------------------------
  const onPages = new Set<string>();
  for (const pg of pages) for (const s of pg.slots) if (s.photoId !== null) onPages.add(s.photoId);
  const coverKept = isKept(doc.cover.photoId);
  const newPhotos = [...byId.values()]
    .filter((p) => p.status === "kept" && !onPages.has(p.id) && !(coverKept && p.id === doc.cover.photoId))
    .sort((a, b) => cmpId(a.id, b.id));

  const assignment = assignChapters(newPhotos, pages, doc.chapters, photo);

  // Page cap: drop the blurriest new photos until everything fits.
  let candidates = newPhotos;
  let fills = fillByChapter(candidates, assignment, pages, design);
  const worstFirst = [...newPhotos].sort((a, b) => -betterFirst(a, b));
  let wi = 0;
  while (candidates.length > 0 && pages.length + countPages(fills) > maxPages) {
    if (pages.length >= maxPages) {
      candidates = [];
    } else {
      const worst = worstFirst[wi++];
      candidates = candidates.filter((p) => p !== worst);
    }
    fills = fillByChapter(candidates, assignment, pages, design);
  }
  const added = candidates.length;
  const skipped = newPhotos.length - added;

  // Insert new pages after each chapter's last page; the new chapter's pages go last.
  const lastIndex = new Map<string, number>();
  pages.forEach((pg, i) => {
    if (pg.chapterId !== null) lastIndex.set(pg.chapterId, i);
  });
  const newChapters: Chapter[] = [];
  const merged: BookPage[] = [];
  const toPage = (chapterId: string, pg: { layout: string; photoIds: string[] }): BookPage => ({
    id: nextPageId(),
    chapterId,
    layout: pg.layout,
    slots: pg.photoIds.map((id) => ({ photoId: id, crop: { ...CENTER } })),
    caption: null,
  });
  pages.forEach((pg, i) => {
    merged.push(pg);
    if (pg.chapterId === null || lastIndex.get(pg.chapterId) !== i) return;
    const fill = fills.get(pg.chapterId);
    if (!fill?.length) return;
    touched.add(pg.chapterId);
    for (const np of fill) merged.push(toPage(pg.chapterId, np));
  });
  const trailing = fills.get(NEW_CHAPTER);
  if (trailing?.length) {
    const chapterId = nextChapterId();
    const ps = trailing.flatMap((pg) => pg.photoIds.map(photo));
    const place = ps.map((p) => p.place?.replace(/\s+/g, " ").trim() ?? "").find(Boolean) ?? null;
    newChapters.push({
      id: chapterId,
      title: MORE_MOMENTS_TITLE,
      dateLabel: dateLabelOf(ps) ?? "",
      place: place ? clipText(place, 80) : null,
    });
    for (const np of trailing) merged.push(toPage(chapterId, np));
  }
  pages = merged;

  // Existing pages alone over the cap (cap shrank): trailing pages go — unavoidable.
  // A trailing spread goes as one unit (its right half alone would leave a half spread).
  while (pages.length > maxPages) {
    const gone = pages.pop() as BookPage;
    const leftHalf = pages[pages.length - 1];
    const unit =
      gone.side === "right" && leftHalf?.side === "left" && leftHalf.layout === gone.layout
        ? [gone, pages.pop() as BookPage]
        : [gone];
    for (const g of unit) {
      removed += g.slots.filter((s) => s.photoId !== null).length;
      if (g.chapterId !== null) touched.add(g.chapterId);
    }
  }

  // ---- 4. chapters ---------------------------------------------------------------------------
  const hadPages = new Set(doc.pages.map((p) => p.chapterId));
  const photosOf = new Map<string, RelayoutPhoto[]>();
  for (const pg of pages) {
    if (pg.chapterId === null) continue;
    const list = photosOf.get(pg.chapterId) ?? [];
    for (const s of pg.slots) if (s.photoId !== null) list.push(photo(s.photoId));
    photosOf.set(pg.chapterId, list);
  }
  const chapters: Chapter[] = [];
  const isNew = new Set(newChapters.map((c) => c.id));
  for (const c of [...doc.chapters, ...newChapters]) {
    const ps = photosOf.get(c.id);
    if (!ps && (hadPages.has(c.id) || isNew.has(c.id))) continue; // lost all its pages
    if (!ps || !touched.has(c.id)) {
      chapters.push(c);
      continue;
    }
    const dateLabel = dateLabelOf(ps) ?? c.dateLabel;
    const placeOk = c.place !== null && ps.some((p) => placeKey(p.place) === placeKey(c.place));
    chapters.push({ ...c, dateLabel, place: placeOk ? c.place : null });
  }

  // ---- 5. cover ------------------------------------------------------------------------------
  let coverId = doc.cover.photoId;
  if (!isKept(coverId)) {
    let best: RelayoutPhoto | null = null;
    for (const pg of pages) {
      for (const s of pg.slots) {
        if (s.photoId === null) continue;
        const p = photo(s.photoId);
        if (!best) best = p;
        else {
          const pp = orientationOf(p.width, p.height) === "portrait" ? 0 : 1;
          const bp = orientationOf(best.width, best.height) === "portrait" ? 0 : 1;
          if (pp < bp || (pp === bp && betterFirst(p, best) < 0)) best = p;
        }
      }
    }
    coverId = best?.id ?? null;
  }
  const coverChanged = coverId !== doc.cover.photoId;

  // ---- 6. backgrounds ------------------------------------------------------------------------
  const exists = (id: string) => byId.has(id);
  // M10c T11: AI photo backgrounds need a KEPT photo on their chapter's first page (D-062/D-068).
  const bgChanged = stripMissingBackgrounds(doc, exists).changed || pruneAiBackgrounds(doc, isKept).changed;

  // ---- 7. result -----------------------------------------------------------------------------
  if (removed === 0 && added === 0 && !coverChanged && !bgChanged) {
    return { doc, changed: false, added: 0, removed: 0, skipped };
  }
  // Removed / inserted pages may push a later spread onto a right-hand page (D-064); the AI photo
  // backgrounds are checked after that (a split spread or a moved opener may leave one off its place).
  const stripped = stripMissingBackgrounds(
    { ...doc, cover: { ...doc.cover, photoId: coverId }, chapters, pages },
    exists,
  ).doc;
  const out = pruneAiBackgrounds(repairSpreads(stripped).doc, isKept).doc;

  const parsed = parseBookDoc(out);
  if (!parsed.ok) throw new RelayoutError(parsed.issues);
  const keptIds = new Set([...byId.values()].filter((p) => p.status === "kept").map((p) => p.id));
  const issues = validateBookDoc(parsed.doc, { photoIds: keptIds, backgroundPhotoIds: new Set(byId.keys()), maxPages });
  if (issues.length) throw new RelayoutError(issues);
  return { doc: parsed.doc, changed: true, added, removed, skipped };
}

export interface RemoveSlotPhotosOptions {
  /** True when a slot photo stays (relayout: kept; photo delete: not the deleted photo). */
  keep: (photoId: string) => boolean;
  /** Photo data for a kept id (orientation, panorama ratio, filler order). */
  photo: (photoId: string) => RelayoutPhoto;
  /** The doc's own format + design style; every refit stays inside it. */
  design: BookDesign;
  nextPageId: () => string;
  /**
   * Photo delete (strip-photos, M10b A19): a page / spread left with NO photos keeps the user's
   * caption instead of disappearing — a single page stays with its emptied slots; a spread becomes
   * the single-page twin of its caption half (when that twin has a caption area, else the spread
   * stays with emptied slots). Relayout (D-028) leaves this off: empty pages always go.
   */
  keepUserCaptionPages?: boolean;
}

export interface RemoveSlotPhotosResult {
  pages: BookPage[];
  /** Slot photos removed. */
  removed: number;
  /** Chapter ids whose photo set changed. */
  touched: Set<string>;
}

/**
 * Rule 1 (+ rule 8 for spreads) on its own: every slot photo `keep` rejects (and any repeat) leaves
 * its page; an affected single page refits to the best layout of `design` for the photos left
 * (refit: order + crops kept, caption kept only when it is the user's and fits); an affected spread
 * becomes a smaller spread of the design or splits into its halves; an empty page / spread is
 * dropped as one unit (see keepUserCaptionPages). Untouched pages are returned as the same objects.
 * Does NOT repair spread alignment — callers run repairSpreads on the final page list.
 * Throws UnsupportedDesignError (via bestPageLayout) when the design has no layouts.
 */
export function removeSlotPhotos(doc: BookDoc, opts: RemoveSlotPhotosOptions): RemoveSlotPhotosResult {
  const { keep, photo, design, nextPageId } = opts;
  const keepCaption = opts.keepUserCaptionPages === true;
  const orient = (id: string) => orientationOf(photo(id).width, photo(id).height);
  let removed = 0;
  const touched = new Set<string>();
  const seen = new Set<string>();
  const pages: BookPage[] = [];
  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i];
    const left: Slot[] = [];
    const leftIdx: number[] = []; // original slot index of each slot in `left`
    let lost = 0;
    page.slots.forEach((slot, j) => {
      if (slot.photoId === null) return;
      if (keep(slot.photoId) && !seen.has(slot.photoId)) {
        seen.add(slot.photoId);
        left.push(slot);
        leftIdx.push(j);
      } else lost++;
    });
    if (lost === 0) {
      pages.push(page);
      continue;
    }
    removed += lost;
    if (page.chapterId !== null) touched.add(page.chapterId);
    const userCaption = page.caption?.source === "user";
    const emptied = (): BookPage => ({
      ...page,
      slots: page.slots.map((s, j) => (s.photoId !== null && !leftIdx.includes(j) ? { ...s, photoId: null } : s)),
    });

    const layout = getLayout(page.layout);
    if (layout?.role === "spread" && page.side === "left") {
      const next = doc.pages[i + 1];
      const right = next && next.side === "right" && next.layout === page.layout ? next : null;
      if (right) i++; // the right half is handled here
      if (left.length === 0) {
        if (!(keepCaption && userCaption)) continue; // whole spread goes
        // Keep the user's words: the caption half's single-page twin, slots emptied.
        const half = layout.caption && rectHalf(layout.caption) === "right" ? 1 : 0;
        const twinId = layout.twin?.[half];
        const twin = twinId ? getLayout(twinId) : undefined;
        if (twin && twin.caption) {
          const single: BookPage = {
            ...page,
            layout: twin.id,
            slots: twin.slots.map(() => ({ photoId: null, crop: { ...CENTER } })),
          };
          delete single.side;
          pages.push(single);
        } else {
          pages.push(emptied());
          if (right) pages.push(right);
        }
        continue;
      }
      const orients = left.map((s) => orient(s.photoId as string));
      const ratios = left.map((s) => ratioOf(photo(s.photoId as string)));
      const smaller = bestPageLayout(orients, { preferCaption: userCaption, design, role: "spread", ratios });
      const smallerLayout = smaller ? getLayout(smaller) : undefined;
      // Only a spread every photo fits (shape-aware for geometric / scrapbook, M10c T10); a
      // one-photo spread only for a real panorama.
      const smallerOk =
        smallerLayout !== undefined &&
        designFitScore(smallerLayout, orients, design, ratios) === orients.length &&
        (orients.length > 1 || ratioOf(photo(left[0].photoId as string)) >= PANORAMA_RATIO);
      if (smallerOk && right) {
        pages.push(refit(page, smallerLayout.id, left), { ...right, layout: smallerLayout.id });
        continue;
      }
      // Split into the halves the photos were on (rule 8).
      const halves: Slot[][] = [[], []];
      left.forEach((s, k) => {
        const rect = layout.slots[leftIdx[k]];
        halves[rect && rectHalf(rect) === "right" ? 1 : 0].push(s);
      });
      // The caption stays with its rect's half — or the other half when that one is empty.
      const rectCaptionHalf = layout.caption && rectHalf(layout.caption) === "right" ? 1 : 0;
      const captionHalf = halves[rectCaptionHalf].length > 0 ? rectCaptionHalf : 1 - rectCaptionHalf;
      const bases: BookPage[] = [page, right ?? page];
      let firstOut = true;
      for (const h of [0, 1] as const) {
        if (halves[h].length === 0) continue;
        const base = bases[h];
        const src: BookPage = {
          ...base,
          id: firstOut ? page.id : (right?.id ?? nextPageId()),
          chapterId: page.chapterId,
          caption: h === captionHalf ? page.caption : null,
        };
        delete src.side;
        firstOut = false;
        pages.push(...fitSingles(src, halves[h], design, orient, photo, nextPageId));
      }
      continue;
    }
    if (left.length === 0) {
      if (keepCaption && userCaption) pages.push(emptied());
      continue;
    }
    pages.push(...fitSingles(page, left, design, orient, photo, nextPageId));
  }
  return { pages, removed, touched };
}

/** Page with a new layout and the slots left on it; caption only if it is the user's and fits. */
function refit(page: BookPage, layoutId: string, slots: Slot[]): BookPage {
  const layout = getLayout(layoutId);
  const hasCaptionArea = layout?.caption != null;
  const caption = page.caption && page.caption.source === "user" && hasCaptionArea ? page.caption : null;
  const out: BookPage = {
    ...page,
    layout: layoutId,
    slots: slots.map((s) => ({ photoId: s.photoId, crop: { ...s.crop } })),
    caption,
  };
  if (layout?.role !== "spread") delete out.side;
  return out;
}

/**
 * Rule 1 for one single page's remaining slots: the best page layout of the design for them
 * (caption-preferring when the user wrote the caption), else split with the filler.
 */
function fitSingles(
  page: BookPage,
  left: Slot[],
  design: BookDesign,
  orient: (id: string) => ReturnType<typeof orientationOf>,
  photo: (id: string) => RelayoutPhoto,
  nextPageId: () => string,
): BookPage[] {
  // A page with the user's caption re-fits onto a layout with a caption area when one exists,
  // so Update album never loses the user's words (D-031).
  const layoutId = bestPageLayout(
    left.map((s) => orient(s.photoId as string)),
    { preferCaption: page.caption?.source === "user", design, ratios: left.map((s) => ratioOf(photo(s.photoId as string))) },
  );
  if (layoutId) return [refit(page, layoutId, left)];
  // More photos left than any layout holds (e.g. a big spread half): split.
  return fillPages(left.map((s) => photo(s.photoId as string)), { prevLayout: null, design }).map((pg, i) => {
    const slots = pg.photoIds.map((id) => left.find((s) => s.photoId === id) as Slot);
    return refit({ ...page, id: i === 0 ? page.id : nextPageId() }, pg.layout, slots);
  });
}

/** Rule 2: which chapter each new photo goes to (computed once from the pages after removal). */
function assignChapters(
  newPhotos: RelayoutPhoto[],
  pages: BookPage[],
  chapters: readonly Chapter[],
  photo: (id: string) => RelayoutPhoto,
): Map<string, ChapterKey> {
  const ranges: { id: string; min: number | null; max: number | null }[] = [];
  for (const c of chapters) {
    let min: number | null = null;
    let max: number | null = null;
    let any = false;
    for (const pg of pages) {
      if (pg.chapterId !== c.id) continue;
      for (const s of pg.slots) {
        if (s.photoId === null) continue;
        any = true;
        const ms = parseTime(photo(s.photoId).takenAt);
        if (ms === null) continue;
        min = min === null ? ms : Math.min(min, ms);
        max = max === null ? ms : Math.max(max, ms);
      }
    }
    if (any) ranges.push({ id: c.id, min, max });
  }
  const dated = ranges.filter((r) => r.min !== null) as { id: string; min: number; max: number }[];
  const undatedOnly = ranges.filter((r) => r.min === null);
  const lastUndated = undatedOnly[undatedOnly.length - 1]?.id;

  const out = new Map<string, ChapterKey>();
  for (const p of newPhotos) {
    const ms = parseTime(p.takenAt);
    if (ms === null) {
      out.set(p.id, lastUndated ?? NEW_CHAPTER);
      continue;
    }
    const inside = dated.find((r) => ms >= r.min && ms <= r.max);
    if (inside) {
      out.set(p.id, inside.id);
      continue;
    }
    let best: { id: string; d: number } | null = null;
    for (const r of dated) {
      const d = ms < r.min ? r.min - ms : ms - r.max;
      if (!best || d < best.d) best = { id: r.id, d };
    }
    out.set(p.id, best?.id ?? NEW_CHAPTER);
  }
  return out;
}

function fillByChapter(
  candidates: RelayoutPhoto[],
  assignment: Map<string, ChapterKey>,
  pages: BookPage[],
  design: BookDesign,
): Map<ChapterKey, { layout: string; photoIds: string[] }[]> {
  const groups = new Map<ChapterKey, RelayoutPhoto[]>();
  for (const p of candidates) {
    const key = assignment.get(p.id) ?? NEW_CHAPTER;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  const lastLayout = new Map<string, string>();
  for (const pg of pages) if (pg.chapterId !== null) lastLayout.set(pg.chapterId, pg.layout);
  const out = new Map<ChapterKey, { layout: string; photoIds: string[] }[]>();
  for (const [key, ps] of groups) {
    const prevLayout = typeof key === "string" ? (lastLayout.get(key) ?? null) : null;
    out.set(key, fillPages(ps, { opener: key === NEW_CHAPTER, prevLayout, design }));
  }
  return out;
}

function countPages(fills: Map<ChapterKey, unknown[]>): number {
  let n = 0;
  for (const f of fills.values()) n += f.length;
  return n;
}
