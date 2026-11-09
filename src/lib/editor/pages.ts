// Page-management helpers for the editor (M5 Task 11): Pages sheet, Add page, Page menu.
// Pure — no React. The doc changes themselves are the edit ops in src/lib/book/edit-ops.ts
// (movePage / addPage / deletePage / movePageToChapter, D-037 #5 chapter rules live there).

import { canAddPage, movePage, movePageToChapter } from "@/lib/book/edit-ops";
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

/**
 * Move the page with id `activeId` to the spot of the page with id `overId` (sortable drop).
 * Resolved by id at apply time, so a stale index can never move the wrong page. Unknown ids → no-op.
 */
export function movePageById(doc: BookDoc, activeId: string, overId: string): BookDoc {
  const from = doc.pages.findIndex((p) => p.id === activeId);
  const to = doc.pages.findIndex((p) => p.id === overId);
  if (from < 0 || to < 0 || from === to) return doc;
  return movePage(doc, from, to);
}

/** Index the page at `pageIdx` will have after "Move to chapter" (null if the move is invalid). */
export function indexAfterChapterMove(doc: BookDoc, pageIdx: number, chapterId: string): number | null {
  const page = doc.pages[pageIdx];
  if (!page) return null;
  try {
    const next = movePageToChapter(doc, pageIdx, chapterId);
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
