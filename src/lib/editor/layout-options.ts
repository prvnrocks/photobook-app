// Layout picker options (M10b A15). Pure — no React. Which layouts the Layout tool offers for a
// page and whether each can be applied, straight from the catalogue (layoutsFor: the book's
// format + design style only, D-063) and a dry run of the edit op (planChangeLayout) — the picker
// never re-implements the spread rules (D-064) itself.

import { planChangeLayout, type ChangeLayoutPlan, type EditOpErrorCode } from "@/lib/book/edit-ops";
import { layoutsFor, spreadStartOf } from "@/lib/book/spreads";
import type { BookDoc, Layout } from "@/lib/book/types";

export interface LayoutOption {
  layout: Layout;
  /** The page (spread: both halves) already uses this layout. */
  current: boolean;
  /** Can't be applied here (reason says why). */
  disabled: boolean;
  /** Short reason shown under a disabled option, else null. */
  reason: string | null;
  /** Placed photos that would move to Not used. */
  loses: number;
  plan: ChangeLayoutPlan;
}

export interface LayoutOptions {
  /** Single-page layouts of the book's format + style. */
  pages: LayoutOption[];
  /** Two-page layouts of the book's format + style (own group in the picker). */
  spreads: LayoutOption[];
  /** Photos placed on the page (on a spread: on the whole spread). */
  placed: number;
  /** The page is a half of a spread. */
  onSpread: boolean;
}

/** Short label for a disabled option. */
export function disabledReason(code: EditOpErrorCode): string {
  switch (code) {
    case "spread_needs_left_page":
      return "Starts on a left page";
    case "page_limit":
      return "No room for another page";
    default:
      return "Not available here";
  }
}

function option(doc: BookDoc, pageIdx: number, layout: Layout, maxPages: number): LayoutOption {
  const plan = planChangeLayout(doc, pageIdx, layout.id, { maxPages });
  const current = doc.pages[pageIdx]?.layout === layout.id;
  if (!plan.ok) return { layout, current, disabled: true, reason: disabledReason(plan.code), loses: 0, plan };
  return { layout, current, disabled: false, reason: null, loses: plan.result.removedPhotoIds.length, plan };
}

/** The Layout tool's options for doc.pages[pageIdx] (book limit `maxPages`). */
export function layoutOptions(doc: BookDoc, pageIdx: number, maxPages: number): LayoutOptions {
  const page = doc.pages[pageIdx];
  if (!page) return { pages: [], spreads: [], placed: 0, onSpread: false };
  const style = doc.style.designStyle ?? "classic";
  const start = spreadStartOf(doc, pageIdx);
  const owner = doc.pages[start ?? pageIdx];
  return {
    pages: layoutsFor(doc.format, style, "page").map((l) => option(doc, pageIdx, l, maxPages)),
    spreads: layoutsFor(doc.format, style, "spread").map((l) => option(doc, pageIdx, l, maxPages)),
    placed: owner.slots.filter((s) => s.photoId !== null).length,
    onSpread: start !== null,
  };
}
