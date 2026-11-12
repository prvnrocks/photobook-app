"use client";

// Chapter title editor (M5 Task 10): renames the chapter of the page the selection is on
// (caption or photo selected). setChapterTitle clips to 80 units.

import { BookmarkPlus } from "lucide-react";
import { useId, useState } from "react";
import { CHAPTER_TITLE_MAX, setChapterTitle } from "@/lib/book/edit-ops";
import type { Chapter } from "@/lib/book/types";
import { captionInputLang } from "@/lib/editor/caption-tools";
import type { EditorContextValue } from "../editor-context";
import type { EditorPanelProps, EditorTool } from "./types";

/** Chapter of the page the current selection is on (slot or caption), or null. */
export function currentChapter(ctx: Pick<EditorContextValue, "state">): { chapter: Chapter; pageIdx: number } | null {
  const sel = ctx.state.selection;
  if (sel?.kind !== "caption" && sel?.kind !== "slot") return null;
  const page = ctx.state.doc.pages[sel.pageIdx];
  const chapter = page?.chapterId ? ctx.state.doc.chapters.find((c) => c.id === page.chapterId) : undefined;
  return chapter ? { chapter, pageIdx: sel.pageIdx } : null;
}

let sessionSeq = 0;

function ChapterTitlePanel({ ctx }: EditorPanelProps) {
  const id = useId();
  const [session] = useState(() => ++sessionSeq);
  const current = currentChapter(ctx);
  if (!current) return null;
  const { chapter } = current;
  const pages = ctx.state.doc.pages.filter((p) => p.chapterId === chapter.id).length;
  return (
    <div className="flex flex-col gap-1" data-testid="chapter-editor">
      <label htmlFor={`${id}-chapter`} className="text-sm font-medium">
        Chapter title
      </label>
      <input
        id={`${id}-chapter`}
        dir="auto"
        lang={captionInputLang(chapter.title, ctx.book.captionLang)}
        value={chapter.title}
        maxLength={CHAPTER_TITLE_MAX}
        disabled={ctx.readOnly}
        placeholder="Chapter title"
        onChange={(e) =>
          ctx.actions.edit((d) => setChapterTitle(d, chapter.id, e.target.value), {
            coalesceKey: `chapter:${chapter.id}:${session}`,
          })
        }
        className="min-h-11 w-full rounded-lg border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-primary"
        data-testid="chapter-title-input"
      />
      <p className="text-xs text-muted-foreground">
        Used for {pages} {pages === 1 ? "page" : "pages"} in this chapter.
      </p>
    </div>
  );
}

export const chapterTitleTool: EditorTool = {
  id: "chapter",
  label: "Chapter",
  icon: BookmarkPlus,
  scopes: ["caption", "slot"],
  order: 40,
  tier: "more",
  panelTitle: "Chapter",
  isAvailable: (ctx) => currentChapter(ctx) !== null,
  Panel: ChapterTitlePanel,
};
