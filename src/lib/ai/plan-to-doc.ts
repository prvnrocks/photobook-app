// AlbumPlan (Storyteller output, aliases) → BookDoc (real photo ids). Pure, deterministic, no I/O.
//
// Code validation step ⑤ of docs/AI-AGENTS.md. The plan is untrusted: every alias must map to a
// known, KEPT photo; layouts must exist with role "page" and the exact photoCount; no photo twice
// in pages (the cover photo may appear once more, on a page); pages ≤ effectiveMaxPages(book).
// Any problem → `{ issues }` (strings with indices, layout ids and aliases only — never user text),
// which the orchestrator feeds back to the Storyteller once (attempt 2), then falls back to the
// rule-based album.
//
// Grounding (CLAUDE.md "never invent places/facts"): chapter `place` is kept only when it equals
// (case/space-insensitive) a place of a photo in that moment, else null; `dateLabel` is recomputed
// from the moment's photo dates (Asia/Dubai days, same format as autolayout), never taken from AI.
// The user's books.title always wins over the AI title (D-018). Captions are null (written in M4).

import { dayRange, DEFAULT_TITLES } from "@/lib/autolayout";
import { DEFAULT_BOOK_DESIGN, type BookDesign } from "@/lib/book/book-design";
import { BOOK_TITLE_MAX_CODE_POINTS } from "@/lib/book/options";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc, BookPage, Chapter, Crop } from "@/lib/book/types";
import { COVER_LAYOUT_ID, getLayout } from "@/lib/layouts";
import { bestPageLayout } from "@/lib/layouts/fit";
import { clipCodePoints, clipText } from "@/lib/text/clip";
import { AI_TEXT_LIMITS, LAYOUT_ID_RE, PHOTO_ALIAS_RE, type AlbumPlan } from "./schemas";
import { dubaiDay, effectiveMaxPages, orientationOf, photoMs, placeKey, type StoryBook, type StoryPhoto } from "./story";

export interface PlanToDocOptions {
  /** Alias ("p7") → real photo id. */
  aliasToId: ReadonlyMap<string, string>;
  /** All photos of the book (kept and dropped). */
  photos: readonly StoryPhoto[];
  book: StoryBook;
  /** agent_runs.id (uuid). */
  runId: string | null;
  /** Stored in doc.meta.generatorVersion — use STORYTELLER_PROMPT_VERSION. */
  generatorVersion: number;
  /**
   * books.format / books.design_style (bookDesignOf, D-063): doc.format / doc.style.designStyle,
   * and what the plan's layouts are validated against. Omitted → classic A5 portrait.
   */
  design?: BookDesign;
}

export type PlanToDocResult = { doc: BookDoc } | { issues: string[] };

const CENTER: Crop = { x: 0.5, y: 0.5, zoom: 1 };

/** Echo an alias in an issue only when it has the alias shape (no user text leaks). */
function safeAlias(a: unknown): string {
  return typeof a === "string" && PHOTO_ALIAS_RE.test(a) ? a : "?";
}
function safeLayoutId(id: unknown): string {
  return typeof id === "string" && LAYOUT_ID_RE.test(id) ? id : "?";
}

export interface PlanCheckOptions {
  aliasToId: ReadonlyMap<string, string>;
  photos: readonly StoryPhoto[];
  maxPages: number;
}

/** Plan-level checks against the photo set. [] = valid. */
export function validatePlanAgainstPhotos(plan: AlbumPlan, { aliasToId, photos, maxPages }: PlanCheckOptions): string[] {
  const issues: string[] = [];
  const byId = new Map(photos.map((p) => [p.id, p]));

  const resolve = (alias: string, at: string): StoryPhoto | null => {
    const id = aliasToId.get(alias);
    const photo = id === undefined ? undefined : byId.get(id);
    if (!photo) {
      issues.push(`${at}: unknown photo "${safeAlias(alias)}" (use only aliases from the photo list)`);
      return null;
    }
    if (!photo.keep) {
      issues.push(`${at}: photo "${safeAlias(alias)}" was dropped and must not be used`);
      return null;
    }
    return photo;
  };

  if (plan.moments.length === 0) issues.push("plan: no moments");

  let pageCount = 0;
  const used = new Set<string>();
  plan.moments.forEach((m, mi) => {
    if (m.pages.length === 0) issues.push(`moments[${mi}]: moment has no pages`);
    m.pages.forEach((pg, pi) => {
      pageCount++;
      const at = `moments[${mi}].pages[${pi}]`;
      const layout = getLayout(pg.layoutId);
      if (!layout) {
        issues.push(`${at}: unknown layout "${safeLayoutId(pg.layoutId)}" (use only catalogue page layouts)`);
      } else if (layout.role !== "page") {
        issues.push(`${at}: layout "${layout.id}" is a cover layout, not a page layout`);
      } else if (pg.photoIds.length !== layout.photoCount) {
        issues.push(`${at}: layout "${layout.id}" needs exactly ${layout.photoCount} photo${layout.photoCount === 1 ? "" : "s"}, got ${pg.photoIds.length}`);
      }
      pg.photoIds.forEach((alias, si) => {
        const photo = resolve(alias, `${at}.photoIds[${si}]`);
        if (!photo) return;
        if (used.has(photo.id)) issues.push(`${at}.photoIds[${si}]: photo "${safeAlias(alias)}" is used more than once`);
        used.add(photo.id);
      });
    });
  });

  if (pageCount === 0) issues.push("plan: no pages");
  if (pageCount > maxPages) issues.push(`plan: ${pageCount} pages exceeds the limit of ${maxPages} pages`);

  resolve(plan.coverPhotoId, "coverPhotoId");
  return issues;
}

/** Cover title kept whole up to the schema limits (code points, then UTF-16 units). */
function coverTitle(s: string): string {
  return clipText(clipCodePoints(s, BOOK_TITLE_MAX_CODE_POINTS), BOOK_TITLE_MAX_CODE_POINTS * 2);
}

function groundedPlace(aiPlace: string | null, momentPhotos: StoryPhoto[]): string | null {
  const key = placeKey(aiPlace);
  if (key === null) return null;
  const match = momentPhotos.find((p) => placeKey(p.place) === key);
  return match?.place ? clipText(match.place.replace(/\s+/g, " ").trim(), AI_TEXT_LIMITS.place) : null;
}

function dateLabelFor(momentPhotos: StoryPhoto[]): string {
  const days: number[] = [];
  for (const p of momentPhotos) {
    const ms = photoMs(p);
    if (ms !== null) days.push(dubaiDay(ms));
  }
  return days.length ? clipText(dayRange(Math.min(...days), Math.max(...days)), AI_TEXT_LIMITS.dateLabel) : "";
}

export function planToDoc(plan: AlbumPlan, opts: PlanToDocOptions): PlanToDocResult {
  const { aliasToId, photos, book, runId, generatorVersion, design = DEFAULT_BOOK_DESIGN } = opts;
  const maxPages = effectiveMaxPages(book);

  const planIssues = validatePlanAgainstPhotos(plan, { aliasToId, photos, maxPages });
  if (planIssues.length) return { issues: planIssues };

  const byId = new Map(photos.map((p) => [p.id, p]));
  const idOf = (alias: string) => aliasToId.get(alias) as string; // validated above

  const chapters: Chapter[] = [];
  const pages: BookPage[] = [];
  plan.moments.forEach((m, mi) => {
    const chapterId = `c${mi + 1}`;
    const momentPhotos = m.pages.flatMap((pg) => pg.photoIds.map((a) => byId.get(idOf(a)) as StoryPhoto));
    const dateLabel = dateLabelFor(momentPhotos);
    const title = clipText(m.title.trim(), AI_TEXT_LIMITS.chapterTitle) || dateLabel || "Our moments";
    chapters.push({ id: chapterId, title, dateLabel, place: groundedPlace(m.place, momentPhotos) });
    for (const pg of m.pages) {
      pages.push({
        id: `p${pages.length + 1}`,
        chapterId,
        layout: pg.layoutId,
        slots: pg.photoIds.map((a) => ({ photoId: idOf(a), crop: { ...CENTER } })),
        caption: null,
      });
    }
  });

  const userTitle = book.title?.trim() ?? "";
  const doc: BookDoc = {
    version: 2,
    format: design.format,
    occasion: book.occasion,
    cover: {
      layout: COVER_LAYOUT_ID,
      photoId: idOf(plan.coverPhotoId),
      title: coverTitle(userTitle || plan.title.trim() || DEFAULT_TITLES[book.occasion]),
      subtitle: clipText(plan.subtitle.trim(), AI_TEXT_LIMITS.subtitle),
    },
    chapters,
    pages,
    style: {
      background: { kind: "color", hex: "#FFFFFF" },
      designStyle: design.designStyle,
      font: book.captionLang === "ar" ? "Cairo" : "Playfair",
    },
    meta: { generator: "ai", generatorVersion, runId, userEdited: false },
  };

  const parsed = parseBookDoc(doc);
  if (!parsed.ok) return { issues: parsed.issues.map((i) => `doc: ${i}`) };
  const kept = new Set(photos.filter((p) => p.keep).map((p) => p.id));
  const docIssues = validateBookDoc(parsed.doc, { photoIds: kept, maxPages });
  if (docIssues.length) return { issues: docIssues.map((i) => `doc: ${i}`) };
  return { doc: parsed.doc };
}

// ---------------------------------------------------------------------------------------------
// Pruning a validated plan when photos changed during the run (review toggles while building)

export interface PrunePlanOptions {
  aliasToId: ReadonlyMap<string, string>;
  /** Current photos of the book (kept and dropped). */
  photos: readonly StoryPhoto[];
}

export interface PrunedPlan {
  plan: AlbumPlan;
  /** Slots removed (photos no longer kept / gone). */
  removed: number;
  /** False = the input plan is returned unchanged. */
  changed: boolean;
}

/**
 * Removes photos that are no longer kept (e.g. the user removed them on the review screen while
 * the run was going) from an AI plan instead of discarding the whole plan: their slots go, an
 * affected page gets the best-fitting page layout for the photos left on it (or is dropped when
 * empty), empty moments are dropped and a removed cover is replaced by the first photo left.
 * Pure. The result still has to pass planToDoc (+ validateBookDoc); if it does not, the caller
 * falls back to the rule-based album.
 */
export function prunePlan(plan: AlbumPlan, { aliasToId, photos }: PrunePlanOptions): PrunedPlan {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const photoOf = (alias: string) => {
    const id = aliasToId.get(alias);
    return id === undefined ? undefined : byId.get(id);
  };
  const usable = (alias: string) => photoOf(alias)?.keep === true;
  const orientOf = (alias: string) => {
    const p = photoOf(alias);
    return p ? orientationOf(p.width, p.height) : ("square" as const);
  };

  let removed = 0;
  const moments: AlbumPlan["moments"] = [];
  for (const m of plan.moments) {
    const pages: AlbumPlan["moments"][number]["pages"] = [];
    for (const pg of m.pages) {
      const left = pg.photoIds.filter(usable);
      removed += pg.photoIds.length - left.length;
      if (left.length === 0) continue;
      if (left.length === pg.photoIds.length) {
        pages.push(pg);
        continue;
      }
      const layoutId = bestPageLayout(left.map(orientOf));
      if (layoutId) pages.push({ ...pg, layoutId, photoIds: left });
      else removed += left.length; // no layout for this count: drop the page
    }
    if (pages.length) moments.push({ ...m, pages });
  }
  if (removed === 0 && usable(plan.coverPhotoId)) return { plan, removed: 0, changed: false };

  const firstLeft = moments[0]?.pages[0]?.photoIds[0];
  const coverPhotoId = usable(plan.coverPhotoId) ? plan.coverPhotoId : (firstLeft ?? plan.coverPhotoId);
  return { plan: { ...plan, coverPhotoId, moments }, removed, changed: true };
}
