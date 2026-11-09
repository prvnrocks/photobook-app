"use client";

// "Page" tool (M5 Task 11): page-level actions for the page on screen (nothing selected).
// - Delete page → Undo toast (the toast's Undo is void once the doc changes again).
// - Move to chapter → appends the page to that chapter (D-037 #5, movePageToChapter);
//   chapters left empty are pruned by the op.

import { Check, FileCog, Trash2 } from "lucide-react";
import { deletePage, movePageToChapter } from "@/lib/book/edit-ops";
import { chapterLabel, indexAfterChapterMove } from "@/lib/editor/pages";
import { cn } from "@/lib/utils";
import { showEditorToast } from "../EditorToast";
import type { EditorPanelProps, EditorTool } from "./types";

export function PageMenu({ ctx, close }: EditorPanelProps) {
  const { state, actions, readOnly } = ctx;
  const doc = state.doc;
  const idx = state.page;
  if (idx === "cover" || !doc.pages[idx]) return null;
  const page = doc.pages[idx];
  const n = idx + 1;
  const chapter = chapterLabel(doc, page.chapterId);

  const onDelete = () => {
    if (readOnly) return;
    actions.edit((d) => deletePage(d, idx), { select: null });
    close();
    const undo = () => {
      actions.undo();
      actions.goTo(idx); // back to the restored page
    };
    showEditorToast({ message: `Page ${n} deleted`, action: { label: "Undo", run: undo }, dismissOnEdit: true });
  };

  const onMoveTo = (chapterId: string) => {
    if (readOnly || chapterId === page.chapterId) return;
    const to = indexAfterChapterMove(doc, idx, chapterId);
    if (to === null) return;
    const label = chapterLabel(doc, chapterId) ?? "chapter";
    actions.edit((d) => movePageToChapter(d, idx, chapterId), { select: null, goTo: to });
    close();
    showEditorToast({
      message: `Moved to “${label}” (now page ${to + 1})`,
      action: { label: "Undo", run: actions.undo },
      dismissOnEdit: true,
    });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="page-menu">
      <p className="text-sm text-muted-foreground">
        Page {n} of {doc.pages.length}
        {chapter ? (
          <>
            {" · "}
            <span dir="auto">{chapter}</span>
          </>
        ) : null}
      </p>

      {doc.chapters.length > 0 ? (
        <section className="flex flex-col gap-1" aria-labelledby="page-menu-chapters">
          <h3 id="page-menu-chapters" className="text-sm font-semibold">
            Move to chapter
          </h3>
          <ul className="flex flex-col">
            {doc.chapters.map((c) => {
              const here = c.id === page.chapterId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onMoveTo(c.id)}
                    disabled={here || readOnly}
                    aria-current={here ? "true" : undefined}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted",
                      here && "font-medium",
                    )}
                    data-testid="page-menu-chapter"
                  >
                    <span dir="auto" className="min-w-0 flex-1 truncate">
                      {chapterLabel(doc, c.id)}
                    </span>
                    {c.dateLabel ? (
                      <span dir="auto" className="shrink-0 text-xs text-muted-foreground">
                        {c.dateLabel}
                      </span>
                    ) : null}
                    {here ? <Check className="size-4 shrink-0" aria-label="Current chapter" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <button
        type="button"
        onClick={onDelete}
        disabled={readOnly}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-4 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
        data-testid="page-menu-delete"
      >
        <Trash2 className="size-4" aria-hidden="true" />
        Delete page {n}
      </button>
    </div>
  );
}

export const pageMenuTool: EditorTool = {
  id: "page-menu",
  label: "Page",
  icon: FileCog,
  scopes: ["none"],
  order: 80,
  isAvailable: (ctx) => ctx.state.page !== "cover" && ctx.state.doc.pages.length > 0,
  Panel: PageMenu,
  panelTitle: "Page",
};
