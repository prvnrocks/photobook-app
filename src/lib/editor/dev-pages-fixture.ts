// Dev-only (/dev-editor?pages=N, 404 in production): grow the fixture doc to N pages in three
// chapters, to exercise the Pages sheet, Move to chapter and the free 20-page limit (Task 11).
// Extra pages reuse the fixture layouts with EMPTY slots (a photo may appear only once per doc).

import type { BookDoc, Chapter } from "@/lib/book/types";
import type { EditorShellData } from "./types";

export const DEV_PAGE_COUNTS = [20] as const;

const CHAPTERS: Chapter[] = [
  { id: "ch-ceremony", title: "The ceremony", dateLabel: "12 Feb", place: null },
  { id: "ch-dinner", title: "عشاء العائلة", dateLabel: "12 Feb", place: null },
  { id: "ch-party", title: "The party", dateLabel: "13 Feb", place: null },
];

export function withDevPages(doc: BookDoc, count: number): BookDoc {
  const base = doc.pages;
  if (base.length === 0) return doc;
  const pages = Array.from({ length: count }, (_, i) => {
    const src = base[i % base.length];
    const chapterId = CHAPTERS[Math.min(Math.floor((i * CHAPTERS.length) / count), CHAPTERS.length - 1)].id;
    if (i < base.length) return { ...src, chapterId };
    return {
      ...src,
      id: `pgx${i}`,
      chapterId,
      slots: src.slots.map((s) => ({ ...s, photoId: null })),
    };
  });
  return { ...doc, chapters: CHAPTERS, pages };
}

export function withDevPagesData(data: EditorShellData, count: number | null): EditorShellData {
  return count === null ? data : { ...data, doc: withDevPages(data.doc, count) };
}

export function parseDevPages(v: unknown): number | null {
  const n = Number(v);
  return (DEV_PAGE_COUNTS as readonly number[]).includes(n) ? n : null;
}
