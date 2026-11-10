// Facing-pages ("open book") structure of the editor (M10a A9). Pure: no React/DOM.
// Same pairing as the flipbook viewer (src/lib/viewer/pages.ts + window.ts, page-flip showCover):
// the cover stands alone, then doc.pages [0,1], [2,3], … — an odd last page stands alone on the
// left. Spread index 0 = cover, spread k ≥ 1 = pages 2(k-1) and 2(k-1)+1.
//
// The store keeps ONE current position (the page tools act on); in spread mode that is the page
// the user last tapped inside the shown spread (default: its left page).

import { pageMm } from "@/lib/book/format";
import type { BookDoc, BookFormat } from "@/lib/book/types";
import type { EditorPosition } from "./store";

export type EditorSpread =
  | { kind: "cover" }
  | { kind: "pages"; left: number | null; right: number | null };

/** Number of spreads for a book with `pageCount` pages (cover + ceil(pages / 2)). */
export function spreadCount(pageCount: number): number {
  const n = Math.max(0, Math.trunc(pageCount) || 0);
  return 1 + Math.ceil(n / 2);
}

export function spreadsFor(pageCount: number): EditorSpread[] {
  const n = Math.max(0, Math.trunc(pageCount) || 0);
  const out: EditorSpread[] = [{ kind: "cover" }];
  for (let left = 0; left < n; left += 2) {
    out.push({ kind: "pages", left, right: left + 1 < n ? left + 1 : null });
  }
  return out;
}

/** [{kind:'cover'}, {left:0,right:1}, {left:2,right:3}, …] for the doc. */
export function editorSpreads(doc: Pick<BookDoc, "pages">): EditorSpread[] {
  return spreadsFor(doc.pages.length);
}

/** Spread index of doc.pages[idx] (≥ 1). */
export function spreadOfPage(idx: number): number {
  return Math.floor(Math.max(0, Math.trunc(idx) || 0) / 2) + 1;
}

/** Spread index of an editor position (cover → 0). */
export function spreadOfPosition(page: EditorPosition): number {
  return page === "cover" ? 0 : spreadOfPage(page);
}

/** Page indexes shown in spread `s` (cover → []). */
export function pagesOfSpread(s: number, pageCount: number): number[] {
  if (s <= 0) return [];
  const left = (Math.trunc(s) - 1) * 2;
  if (left >= pageCount) return [];
  return left + 1 < pageCount ? [left, left + 1] : [left];
}

/** Where the editor lands when spread `s` is shown: the cover, or the spread's left page. */
export function spreadToPosition(s: number, pageCount: number): EditorPosition {
  const max = spreadCount(pageCount) - 1;
  const k = Math.min(Math.max(Math.trunc(s) || 0, 0), max);
  return k === 0 ? "cover" : (k - 1) * 2;
}

/** Position after moving `delta` spreads from `page` (clamped; lands on the left page). */
export function stepSpread(page: EditorPosition, delta: number, pageCount: number): EditorPosition {
  return spreadToPosition(spreadOfPosition(page) + delta, pageCount);
}

/** Counter text in spread mode: "Cover · 6 pages", "1–2 / 6", "7 / 7" (odd last page). */
export function spreadCounterLabel(s: number, pageCount: number): string {
  if (s <= 0) return `Cover · ${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
  const pages = pagesOfSpread(s, pageCount);
  if (pages.length === 0) return `${pageCount} / ${pageCount}`;
  const range = pages.length > 1 ? `${pages[0] + 1}–${pages[1] + 1}` : String(pages[0] + 1);
  return `${range} / ${pageCount}`;
}

/** Accessible slide label: "Cover", "Pages 1–2 of 6", "Page 7 of 7". */
export function spreadAriaLabel(s: number, pageCount: number): string {
  if (s <= 0) return "Cover";
  const pages = pagesOfSpread(s, pageCount);
  if (pages.length > 1) return `Pages ${pages[0] + 1}–${pages[1] + 1} of ${pageCount}`;
  return `Page ${(pages[0] ?? pageCount - 1) + 1} of ${pageCount}`;
}

/** CSS aspect-ratio of an open spread (two trim pages side by side), e.g. "296 / 210". */
export function spreadAspectRatio(format?: BookFormat | null): string {
  const p = pageMm(format);
  return `${p.w * 2} / ${p.h}`;
}
