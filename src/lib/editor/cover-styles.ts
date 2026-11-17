// "Cover style" tool logic (M29 T7). Pure: no React/DOM. The tool lists every cover layout of the
// book's format + design style (coverStylesFor — pre-M29 covers first, then the M29 ones; the AI
// never picks the M29 ones, the user may) and applies one with setCoverLayout, which keeps the
// cover photo, title and subtitle. Each option carries a preview doc (the user's book with that
// cover layout) so the panel can render a live <BookPage page="cover"> thumbnail.

import { setCoverLayout } from "@/lib/book/edit-ops";
import { coverStylesFor } from "@/lib/book/spreads";
import type { BookDoc, Layout } from "@/lib/book/types";
import type { EditorPosition } from "./store";

export interface CoverStyleOption {
  layout: Layout;
  /** The cover's layout now. */
  current: boolean;
  /** The doc with this cover layout (the same object for the current one). */
  preview: BookDoc;
}

/** Every cover style for the book's format + design style, in catalogue order. */
export function coverStyleOptions(doc: BookDoc): CoverStyleOption[] {
  return coverStylesFor(doc.format, doc.style.designStyle ?? "classic").map((layout) => ({
    layout,
    current: layout.id === doc.cover.layout,
    preview: layout.id === doc.cover.layout ? doc : setCoverLayout(doc, layout.id),
  }));
}

/** The tool shows on the cover only, and only when there is a choice to make. */
export function coverStyleAvailable(doc: BookDoc, page: EditorPosition): boolean {
  return page === "cover" && coverStylesFor(doc.format, doc.style.designStyle ?? "classic").length > 1;
}

/** Plain-words name for an option ("Cover: split" → "Split"). */
export function coverStyleName(layout: Pick<Layout, "name">): string {
  const n = layout.name.replace(/^cover:\s*/i, "").trim();
  return n && n.toLowerCase() !== "cover" ? n.charAt(0).toUpperCase() + n.slice(1) : "Photo + title";
}
