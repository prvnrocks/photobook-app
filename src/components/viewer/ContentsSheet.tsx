"use client";

// Contents: chapters in reading order with their date; tap jumps to the chapter's first page.

import { chapterStarts, labelFontStyle, type ChapterStart, type ViewerChapter } from "@/lib/viewer/chapters";
import { isMainlyArabic } from "@/lib/review/ui";
import { ViewerSheet } from "./ViewerSheet";

export function ContentsSheet({
  open,
  onClose,
  doc,
  currentChapterId,
  onJump,
}: {
  open: boolean;
  onClose: () => void;
  doc: { chapters: readonly ViewerChapter[]; pages: readonly { chapterId: string | null }[] };
  currentChapterId: string | null;
  /** Called with the flip index of the chapter's first page (1 + firstPageIdx). */
  onJump: (flipIndex: number, start: ChapterStart) => void;
}) {
  const starts = chapterStarts(doc);
  return (
    <ViewerSheet open={open} onClose={onClose} title="Contents" testId="contents-sheet">
      {starts.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">This book has no chapters.</p>
      ) : (
        <ol className="divide-y divide-border">
          {starts.map((s) => {
            const arabic = isMainlyArabic(s.chapter.title);
            const active = s.chapter.id === currentChapterId;
            return (
              <li key={s.chapter.id}>
                <button
                  type="button"
                  className={`relative flex min-h-12 w-full items-center gap-3 px-4 py-3 text-start outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${active ? "bg-secondary" : ""}`}
                  aria-current={active ? "true" : undefined}
                  data-testid="contents-item"
                  data-chapter-id={s.chapter.id}
                  onClick={() => onJump(s.flipIndex, s)}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      dir="auto"
                      lang={arabic ? "ar" : undefined}
                      style={labelFontStyle(s.chapter.title)}
                      className={`block truncate text-sm text-foreground ${active ? "font-semibold" : "font-medium"}`}
                    >
                      {s.chapter.title}
                    </span>
                    {s.chapter.dateLabel ? (
                      <span dir="auto" className="block truncate text-xs text-muted-foreground">
                        {s.chapter.dateLabel}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">p. {s.firstPageIdx + 1}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </ViewerSheet>
  );
}
