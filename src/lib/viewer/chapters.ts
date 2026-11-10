// Chapter helpers for the viewer label + Contents sheet (D-040: chapters are shown in viewer
// chrome, never on pages). Pure (no React/DOM) and unit-tested.

import type { CSSProperties } from "react";
import { captionFontFamily } from "@/lib/book/fonts";
import { isMainlyArabic } from "@/lib/review/ui";

/** The chapter fields the viewer uses (public docs keep only these). */
export interface ViewerChapter {
  id: string;
  title: string;
  dateLabel: string | null;
}

interface ChapterDoc {
  chapters: readonly ViewerChapter[];
  pages: readonly { chapterId: string | null }[];
}

export interface ChapterStart {
  chapter: ViewerChapter;
  /** Index into doc.pages of the chapter's first page. */
  firstPageIdx: number;
  /** Flip index to jump to (1 + firstPageIdx; 0 is the cover). */
  flipIndex: number;
}

/** Chapter of doc.pages[pageIdx], or null (no chapter / unknown id / out of range). */
export function chapterForPage(doc: ChapterDoc, pageIdx: number | null): ViewerChapter | null {
  if (pageIdx === null || pageIdx < 0 || pageIdx >= doc.pages.length) return null;
  const id = doc.pages[pageIdx]?.chapterId;
  if (!id) return null;
  return doc.chapters.find((c) => c.id === id) ?? null;
}

/** Chapters in reading order (first appearance), each with its first page. Empty chapters skipped. */
export function chapterStarts(doc: ChapterDoc): ChapterStart[] {
  const byId = new Map(doc.chapters.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out: ChapterStart[] = [];
  doc.pages.forEach((p, i) => {
    if (!p.chapterId || seen.has(p.chapterId)) return;
    const chapter = byId.get(p.chapterId);
    if (!chapter) return;
    seen.add(p.chapterId);
    out.push({ chapter, firstPageIdx: i, flipIndex: i + 1 });
  });
  return out;
}

/** "title · dateLabel" (either part may be missing; "" when both are). */
export function chapterLabel(ch: Pick<ViewerChapter, "title" | "dateLabel"> | null): string {
  if (!ch) return "";
  return [ch.title.trim(), (ch.dateLabel ?? "").trim()].filter(Boolean).join(" · ");
}

/** Inline font for UI text that may be Arabic (chapter titles, book title): Cairo when mainly Arabic. */
export function labelFontStyle(text: string): CSSProperties | undefined {
  return isMainlyArabic(text) ? { fontFamily: captionFontFamily("Cairo") } : undefined;
}
