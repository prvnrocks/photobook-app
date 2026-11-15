"use client";

// "Page" tool (M5 Task 11): page-level actions for the page on screen (nothing selected).
// - Delete page → Undo toast (the toast's Undo is void once the doc changes again).
// - Move to chapter → appends the page to that chapter (D-037 #5, movePageToChapter);
//   chapters left empty are pruned by the op.
// - Spreads (M10b A15, D-064): on either half the menu acts on the whole spread (pageUnit) —
//   delete asks "Delete this 2-page spread?" first; ops get book.maxPages; later spreads the reflow
//   had to split are announced with Undo (splitCount).

import { Check, FileCog, Trash2 } from "lucide-react";
import { useState } from "react";
import { deletePageResult, movePageToChapterResult, pageUnit } from "@/lib/book/edit-ops";
import { chapterLabel, splitNotice } from "@/lib/editor/pages";
import { cx } from "@/lib/cx";
import { ED_DANGER_QUIET, ED_PANEL_EYEBROW } from "../editor-classes";
import { showEditorToast } from "../EditorToast";
import { TOOL_SECONDARY, TOOL_WELL_SURFACE } from "./tool-classes";
import type { EditorPanelProps, EditorTool } from "./types";

// M22 T6b (D-074): chapter rows in one white card, quiet danger delete, confirm as an ivory card
// (Cancel = outlined emerald, Delete = solid destructive pill — the only solid red, after a confirm).
const CHAPTER_ROW =
  "flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-start text-sm text-foreground transition-colors outline-none hover:bg-[#f3f7f4] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] disabled:cursor-default disabled:hover:bg-transparent motion-reduce:transition-none";
const CHAPTER_ROW_HERE =
  "flex min-h-11 w-full items-center gap-2 rounded-xl bg-[#e6efe9] px-3 text-start text-sm font-semibold text-[#0e3b2e] outline-none focus-visible:ring-2 focus-visible:ring-[#0e3b2e]";
const DANGER_SOLID =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-destructive px-4 text-sm font-semibold text-white transition-colors outline-none hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transition-none";

export function PageMenu({ ctx, close }: EditorPanelProps) {
  const { state, actions, readOnly, book } = ctx;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const doc = state.doc;
  const idx = state.page;
  if (idx === "cover" || !doc.pages[idx]) return null;
  const page = doc.pages[idx];
  const unit = pageUnit(doc, idx);
  const isSpread = unit.count === 2;
  const n = idx + 1;
  const unitLabel = isSpread ? `Pages ${unit.start + 1}–${unit.start + 2}` : `Page ${n}`;
  const chapter = chapterLabel(doc, page.chapterId);
  const maxPages = book.maxPages;

  const doDelete = () => {
    if (readOnly) return;
    const base = doc;
    let r: ReturnType<typeof deletePageResult>;
    try {
      r = deletePageResult(base, idx, maxPages);
    } catch {
      actions.edit((d) => deletePageResult(d, idx, maxPages).doc); // surfaces the error code
      return;
    }
    const restoreAt = unit.start;
    actions.edit((d) => (d === base ? r.doc : deletePageResult(d, idx, maxPages).doc), {
      select: null,
      goTo: r.pageIdx < 0 ? "cover" : r.pageIdx,
    });
    close();
    const undo = () => {
      actions.undo();
      actions.goTo(restoreAt); // back to the restored page
    };
    const message = [isSpread ? `${unitLabel} deleted` : `Page ${n} deleted`, splitNotice(r.splitCount)].filter(Boolean).join(" · ");
    showEditorToast({ message, action: { label: "Undo", run: undo }, dismissOnEdit: true });
  };

  const onDelete = () => {
    if (readOnly) return;
    if (isSpread) {
      setConfirmDelete(true);
      return;
    }
    doDelete();
  };

  const onMoveTo = (chapterId: string) => {
    if (readOnly || chapterId === page.chapterId) return;
    const base = doc;
    let r: ReturnType<typeof movePageToChapterResult>;
    try {
      r = movePageToChapterResult(base, idx, chapterId, maxPages);
    } catch {
      return;
    }
    if (r.doc === base) return;
    const to = r.pageIdx;
    const label = chapterLabel(doc, chapterId) ?? "chapter";
    actions.edit((d) => (d === base ? r.doc : movePageToChapterResult(d, idx, chapterId, maxPages).doc), {
      select: null,
      goTo: to,
    });
    close();
    showEditorToast({
      message: [`Moved to “${label}” (now page ${to + 1})`, splitNotice(r.splitCount)].filter(Boolean).join(" · "),
      action: { label: "Undo", run: actions.undo },
      dismissOnEdit: true,
    });
  };

  if (confirmDelete) {
    return (
      <div role="alertdialog" aria-labelledby="page-menu-confirm-title" className={cx(TOOL_WELL_SURFACE, "flex flex-col gap-3 p-4")} data-testid="page-menu-confirm">
        <h3 id="page-menu-confirm-title" className="font-display text-base leading-tight font-semibold text-[#0e3b2e]">
          Delete this two-page layout?
        </h3>
        <p className="text-sm text-muted-foreground">
          {unitLabel} share one layout, so both pages are deleted. Their photos move to Not used.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setConfirmDelete(false)}
            className={cx(TOOL_SECONDARY, "flex-1")}
            data-testid="page-menu-confirm-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={doDelete}
            className={cx(DANGER_SOLID, "flex-1")}
            data-testid="page-menu-confirm-delete"
          >
            Delete 2 pages
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="page-menu">
      <p className="text-sm text-muted-foreground">
        {unitLabel} of {doc.pages.length}
        {isSpread ? " · two-page layout" : null}
        {chapter ? (
          <>
            {" · "}
            <span dir="auto">{chapter}</span>
          </>
        ) : null}
      </p>

      {doc.chapters.length > 0 ? (
        <section className="flex flex-col gap-2" aria-labelledby="page-menu-chapters">
          <h3 id="page-menu-chapters" className={ED_PANEL_EYEBROW}>
            Move to chapter
          </h3>
          <ul className="flex flex-col gap-0.5 rounded-2xl border border-[#e9dfca] bg-white p-1 shadow-[0_10px_24px_-20px_rgb(14_59_46/0.5)]">
            {doc.chapters.map((c) => {
              const here = c.id === page.chapterId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onMoveTo(c.id)}
                    disabled={here || readOnly}
                    aria-current={here ? "true" : undefined}
                    className={here ? CHAPTER_ROW_HERE : CHAPTER_ROW}
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
        className={cx(ED_DANGER_QUIET, "w-full border border-destructive-border")}
        data-testid="page-menu-delete"
      >
        <Trash2 className="size-4" aria-hidden="true" />
        {isSpread ? `Delete pages ${unit.start + 1}–${unit.start + 2}` : `Delete page ${n}`}
      </button>
    </div>
  );
}

export const pageMenuTool: EditorTool = {
  id: "page-menu",
  label: "Page options",
  icon: FileCog,
  scopes: ["none"],
  order: 80,
  tier: "more",
  isAvailable: (ctx) => ctx.state.page !== "cover" && ctx.state.doc.pages.length > 0,
  Panel: PageMenu,
  panelTitle: "Page options",
};
