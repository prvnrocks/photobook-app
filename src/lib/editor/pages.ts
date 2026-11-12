// Page-management helpers for the editor (M5 Task 11): Pages sheet, Add page, Page menu.
// Pure — no React. The doc changes themselves are the edit ops in src/lib/book/edit-ops.ts
// (movePage / addPage / deletePage / movePageToChapter, D-037 #5 chapter rules live there).
// Spreads (M10b A15, D-064): a spread is ONE unit in the Pages sheet (one 2-wide tile that drags
// as a whole) — pageUnits / unitMoveTarget map tiles to movePageResult's (from, to).

import { canAddPage, movePage, movePageToChapterResult, pageUnit } from "@/lib/book/edit-ops";
import type { BookDoc } from "@/lib/book/types";
import type { EditorPosition } from "./store";

export type AddPageDecision =
  /** Insert a page at index afterIdx + 1 (afterIdx -1 = before the first page, from the cover). */
  | { kind: "add"; afterIdx: number }
  /** Free book at its page limit: show the Upgrade sheet, never create the page. */
  | { kind: "upgrade" }
  /** Paid book at its page limit (100): nothing to offer — the button is disabled. */
  | { kind: "full" };

/** What tapping "Add page" does for the current doc / book / position. */
export function addPageDecision(
  doc: BookDoc,
  book: { isPaid: boolean; maxPages: number },
  page: EditorPosition,
): AddPageDecision {
  if (!canAddPage(doc, book.maxPages)) return book.isPaid ? { kind: "full" } : { kind: "upgrade" };
  const afterIdx = page === "cover" ? -1 : Math.min(Math.max(page, -1), doc.pages.length - 1);
  return { kind: "add", afterIdx };
}

/** Where the carousel position ends up after a page moved from `from` to `to` (it follows the same page). */
export function positionAfterMove(page: EditorPosition, from: number, to: number): EditorPosition {
  if (page === "cover" || from === to) return page;
  if (page === from) return to;
  if (from < page && page <= to) return page - 1;
  if (to <= page && page < from) return page + 1;
  return page;
}

/** One tile of the Pages sheet: a single page, or both halves of a spread (id = first page's id). */
export interface PageTileUnit {
  id: string;
  start: number;
  count: 1 | 2;
}

/** The book's pages as move/delete units, in order (a spread = one unit of 2 pages). */
export function pageUnits(doc: BookDoc): PageTileUnit[] {
  const out: PageTileUnit[] = [];
  for (let i = 0; i < doc.pages.length; ) {
    const u = pageUnit(doc, i);
    // A malformed pair (unit starting before i) can't happen after repair; fall back to one page.
    const unit = u.start === i ? u : { start: i, count: 1 as const };
    out.push({ id: doc.pages[i].id, start: unit.start, count: unit.count });
    i += unit.count;
  }
  return out;
}

/**
 * (from, to) for movePageResult when the tile of page `activeId` is dropped on the tile of page
 * `overId` (either may be a spread half): the moved unit ends up just past the target unit in the
 * drag direction. `to` is an index in the resulting list; edit-ops rounds spreads onto an even
 * index. null = unknown ids or the same unit.
 */
export function unitMoveTarget(doc: BookDoc, activeId: string, overId: string): { from: number; to: number } | null {
  const a = doc.pages.findIndex((p) => p.id === activeId);
  const o = doc.pages.findIndex((p) => p.id === overId);
  if (a < 0 || o < 0) return null;
  const active = pageUnit(doc, a);
  const over = pageUnit(doc, o);
  if (active.start === over.start) return null;
  if (over.start > active.start) {
    // Forward: the unit's first page lands where the target's last page ends up once the moving
    // pages are taken out.
    const overEnd = over.start + over.count - 1;
    return { from: active.start, to: overEnd - (active.count - 1) };
  }
  return { from: active.start, to: over.start };
}

/**
 * Move the tile of page `activeId` onto the tile of page `overId` (sortable drop; spreads move as a
 * unit). Resolved by id at apply time, so a stale index can never move the wrong page. Unknown ids
 * → no-op.
 */
export function movePageById(doc: BookDoc, activeId: string, overId: string, maxPages?: number): BookDoc {
  const t = unitMoveTarget(doc, activeId, overId);
  if (!t) return doc;
  return movePage(doc, t.from, t.to, maxPages);
}

/** Toast text when a structural change split later spreads (D-064), else null. */
export function splitNotice(splitCount: number): string | null {
  if (!(splitCount > 0)) return null;
  return splitCount === 1 ? "A two-page layout was split into single pages" : `${splitCount} two-page layouts were split into single pages`;
}

/** Index the page at `pageIdx` will have after "Move to chapter" (null if the move is invalid). */
export function indexAfterChapterMove(doc: BookDoc, pageIdx: number, chapterId: string, maxPages?: number): number | null {
  const page = doc.pages[pageIdx];
  if (!page) return null;
  try {
    const next = movePageToChapterResult(doc, pageIdx, chapterId, maxPages).doc;
    const idx = next.pages.findIndex((p) => p.id === page.id);
    return idx >= 0 ? idx : null;
  } catch {
    return null;
  }
}

/** Display name of a chapter (titles may be empty). */
export function chapterLabel(doc: BookDoc, chapterId: string | null): string | null {
  if (chapterId === null) return null;
  const c = doc.chapters.find((ch) => ch.id === chapterId);
  if (!c) return null;
  return c.title.trim() || "Untitled chapter";
}

/** "12 of 20 pages" (the book's limit) — shown in the Pages sheet. */
export function pageCountLabel(count: number, maxPages: number): string {
  return `${count} of ${maxPages} page${maxPages === 1 ? "" : "s"}`;
}
