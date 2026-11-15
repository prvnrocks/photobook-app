"use client";

// Contents: chapters in reading order with their date; tap jumps to the chapter's first page.
// M23 T3: chapter card rows on the ivory sheet — the current chapter is the mint/emerald row
// (aria-current), each row ends in a "p. N" chip. Title and date are user text: dir="auto" on the
// inner spans, labelFontStyle (Cairo chain) on the title, no letter-spacing. The text block is
// text-left (absolute, inherited) so an Arabic title's dir="auto" doesn't flip it to the right while
// its date stays left — every row starts at the left edge like the band. The date is skipped when
// it repeats the title (chapterDate).

import { chapterDate, chapterStarts, labelFontStyle, type ChapterStart, type ViewerChapter } from "@/lib/viewer/chapters";
import { isMainlyArabic } from "@/lib/review/ui";
import { ViewerSheet } from "./ViewerSheet";
import { VW_LIST_ROW, VW_LIST_ROW_ACTIVE, VW_LIST_ROW_META, VW_MUTED, VW_PAGE_CHIP, VW_PAGE_CHIP_ACTIVE } from "./viewer-classes";

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
        <p className={`px-5 py-6 ${VW_MUTED}`}>This book has no chapters.</p>
      ) : (
        <ol className="flex flex-col gap-1 p-2 sm:p-3">
          {starts.map((s) => {
            const arabic = isMainlyArabic(s.chapter.title);
            const active = s.chapter.id === currentChapterId;
            const date = chapterDate(s.chapter);
            return (
              <li key={s.chapter.id}>
                <button
                  type="button"
                  className={active ? VW_LIST_ROW_ACTIVE : VW_LIST_ROW}
                  aria-current={active ? "true" : undefined}
                  data-testid="contents-item"
                  data-chapter-id={s.chapter.id}
                  onClick={() => onJump(s.flipIndex, s)}
                >
                  <span className="min-w-0 flex-1 text-left">
                    <span
                      dir="auto"
                      lang={arabic ? "ar" : undefined}
                      style={labelFontStyle(s.chapter.title)}
                      className={`block truncate ${active ? "font-semibold" : "font-medium"}`}
                    >
                      {s.chapter.title}
                    </span>
                    {date ? (
                      <span dir="auto" className={VW_LIST_ROW_META}>
                        {date}
                      </span>
                    ) : null}
                  </span>
                  <span className={active ? VW_PAGE_CHIP_ACTIVE : VW_PAGE_CHIP}>p. {s.firstPageIdx + 1}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </ViewerSheet>
  );
}
