// Flip-index layout of the viewer book. Pure (no React/DOM) and unit-tested.
// Flip indexes: 0 = cover, 1..D = doc.pages[0..D-1], then (viewer only) an optional blank filler
// and the end card. page-flip with showCover pairs [1,2], [3,4], … and shows an unpaired LAST
// page alone as a hard back cover — so in spread mode the total count is kept even (filler when
// D is odd) and the end card always stands alone. Phones show one page at a time: no filler.

import { visiblePages } from "./window";

export interface FlipLayout {
  /** Number of book pages (doc.pages.length). */
  docPages: number;
  /** Total flip pages (cover + pages + filler + end card). */
  count: number;
  /** Flip index of the end card, or null when there is none. */
  endIndex: number | null;
  /** Flip index of the blank filler page, or null. */
  fillerIndex: number | null;
}

export type FlipPageKind =
  | { kind: "cover" }
  | { kind: "page"; pageIdx: number }
  | { kind: "filler" }
  | { kind: "end" };

export function flipLayout(docPages: number, opts: { endCard: boolean; spread: boolean }): FlipLayout {
  const d = Math.max(0, Math.trunc(docPages) || 0);
  if (!opts.endCard) return { docPages: d, count: d + 1, endIndex: null, fillerIndex: null };
  const filler = opts.spread && d % 2 === 1;
  const fillerIndex = filler ? d + 1 : null;
  const endIndex = d + 1 + (filler ? 1 : 0);
  return { docPages: d, count: endIndex + 1, endIndex, fillerIndex };
}

export function flipPageKind(layout: FlipLayout, index: number): FlipPageKind {
  if (index <= 0) return { kind: "cover" };
  if (index <= layout.docPages) return { kind: "page", pageIdx: index - 1 };
  if (index === layout.fillerIndex) return { kind: "filler" };
  return { kind: "end" };
}

/**
 * Where a (re)mounted book starts when the previous instance was at `index`. Anything past the
 * last book page means the reader was at the end (filler/end card) → the new end card.
 */
export function startIndexFor(layout: FlipLayout, index: number): number {
  const i = Math.max(0, Math.trunc(index) || 0);
  if (i > layout.docPages) return layout.endIndex ?? layout.count - 1;
  return Math.min(i, layout.count - 1);
}

/** Counter text: "Cover", "5 / 20", spread "4–5 / 20", "End". */
export function pageCounterLabel(layout: FlipLayout, current: number, spread: boolean): string {
  const visible = visiblePages(current, layout.count, spread);
  if (visible.includes(0)) return "Cover";
  const nums: number[] = [];
  for (const i of visible) {
    const k = flipPageKind(layout, i);
    if (k.kind === "page") nums.push(k.pageIdx + 1);
  }
  if (nums.length === 0) return "End";
  const range = nums.length > 1 ? `${nums[0]}–${nums[nums.length - 1]}` : String(nums[0]);
  return `${range} / ${layout.docPages}`;
}

/** First book page index visible at `current` (null on cover / filler / end card). */
export function firstVisiblePageIdx(layout: FlipLayout, current: number, spread: boolean): number | null {
  for (const i of visiblePages(current, layout.count, spread)) {
    const k = flipPageKind(layout, i);
    if (k.kind === "page") return k.pageIdx;
  }
  return null;
}
