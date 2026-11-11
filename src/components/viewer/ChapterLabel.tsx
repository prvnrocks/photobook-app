// Current chapter "title · dateLabel" (D-040: chapter headings live in viewer chrome only).
// dir="auto" for Arabic titles, rendered in Cairo when the title is mainly Arabic.

import { chapterLabel, labelFontStyle, type ViewerChapter } from "@/lib/viewer/chapters";
import { isMainlyArabic } from "@/lib/review/ui";

export function ChapterLabel({ chapter, className }: { chapter: ViewerChapter | null; className?: string }) {
  const text = chapterLabel(chapter);
  const arabic = chapter ? isMainlyArabic(chapter.title) : false;
  return (
    <p
      dir="auto"
      lang={arabic ? "ar" : undefined}
      style={labelFontStyle(chapter?.title ?? "")}
      className={`truncate text-xs text-muted-foreground ${className ?? ""}`}
      data-testid="chapter-label"
      data-chapter-id={chapter?.id ?? ""}
    >
      {chapter && text ? (
        <>
          {/* Title stays un-isolated so dir="auto" detects its direction; the date is isolated,
              otherwise "12 Feb" after an Arabic title reorders to "Feb 12". */}
          {chapter.title.trim()}
          {chapter.title.trim() && chapter.dateLabel?.trim() ? " · " : null}
          {chapter.dateLabel?.trim() ? <bdi>{chapter.dateLabel.trim()}</bdi> : null}
        </>
      ) : (
        "\u00a0"
      )}
    </p>
  );
}
