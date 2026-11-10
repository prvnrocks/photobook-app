"use client";

// Layout (M5 Task 9): switch the current page's layout. Each option is a small diagram drawn
// from the layout data itself (slots + caption area as % of the page) — no layout maths here.
// Photos re-flow in order (changeLayout); anything lost is announced in a toast with Undo.

import { LayoutTemplate } from "lucide-react";
import { changeLayout } from "@/lib/book/edit-ops";
import { pageAspectStyle } from "@/lib/book/format-style";
import type { BookFormat, Layout } from "@/lib/book/types";
import { layoutChangeNotice } from "@/lib/editor/photo-picker";
import { layoutsByRole } from "@/lib/layouts";
import { cn } from "@/lib/utils";
import type { EditorContextValue } from "../editor-context";
import { showEditorToast } from "../EditorToast";
import type { EditorPanelProps, EditorTool } from "./types";

/** Index of the page the Layout tool works on (selected slot/caption's page, else the shown page). */
export function layoutTargetPage(ctx: Pick<EditorContextValue, "state">): number | null {
  const { selection, page, doc } = ctx.state;
  const idx = selection && selection.kind !== "cover" ? selection.pageIdx : page;
  return typeof idx === "number" && idx >= 0 && idx < doc.pages.length ? idx : null;
}

/** Small page diagram of a layout, straight from its data, in the book's page shape (doc.format). */
export function LayoutDiagram({ layout, format, className }: { layout: Layout; format?: BookFormat | null; className?: string }) {
  return (
    <div
      className={cn("relative aspect-[148/210] w-full rounded-sm border bg-white", className)}
      style={pageAspectStyle(format)}
      aria-hidden="true"
    >
      {layout.slots.map((r, i) => (
        <div
          key={i}
          className="absolute rounded-[2px] bg-neutral-400"
          style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
        />
      ))}
      {layout.caption ? (
        <div
          className="absolute flex flex-col items-center justify-center gap-[3px]"
          style={{ left: `${layout.caption.x}%`, top: `${layout.caption.y}%`, width: `${layout.caption.w}%`, height: `${layout.caption.h}%` }}
          data-testid="layout-diagram-caption"
        >
          <span className="block h-[2px] w-3/4 rounded bg-neutral-300" />
          <span className="block h-[2px] w-1/2 rounded bg-neutral-300" />
        </div>
      ) : null}
    </div>
  );
}

export function LayoutPickerPanel({ ctx, close }: EditorPanelProps) {
  const pageIdx = layoutTargetPage(ctx);
  if (pageIdx === null) return null;
  const page = ctx.state.doc.pages[pageIdx];
  const placed = page.slots.filter((s) => s.photoId !== null).length;

  const choose = (layout: Layout) => {
    if (ctx.readOnly) return;
    const base = ctx.state.doc;
    const result = changeLayout(base, pageIdx, layout.id);
    if (result.doc === base) {
      close();
      return;
    }
    ctx.actions.edit((d) => (d === base ? result.doc : changeLayout(d, pageIdx, layout.id).doc), { goTo: pageIdx });
    const notice = layoutChangeNotice(result);
    if (notice) showEditorToast({ message: notice, actionLabel: "Undo", onAction: ctx.actions.undo, dismissOnEdit: true });
    close();
  };

  return (
    <div className="flex flex-col gap-3" data-testid="layout-picker">
      <p className="text-sm text-muted-foreground">
        {placed === 1 ? "1 photo" : `${placed} photos`} on this page. Photos move into the new layout in order.
      </p>
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
        {layoutsByRole("page").map((l) => {
          const current = l.id === page.layout;
          const loses = Math.max(0, placed - l.photoCount);
          return (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => choose(l)}
                aria-pressed={current}
                aria-label={`${l.name}: ${l.photoCount === 1 ? "1 photo" : `${l.photoCount} photos`}${l.caption ? "" : ", no caption"}${loses > 0 ? `, ${loses} won't fit` : ""}${current ? " (current)" : ""}`}
                className={cn(
                  "flex w-full flex-col items-stretch gap-1 rounded-lg p-1.5 text-left outline-none focus-visible:ring-4 focus-visible:ring-primary/60",
                  current ? "bg-primary/10 ring-2 ring-primary" : "hover:bg-muted",
                )}
                data-testid="layout-option"
                data-layout-id={l.id}
              >
                <LayoutDiagram layout={l} format={ctx.state.doc.format} />
                <span className="text-xs font-medium tabular-nums">
                  {l.photoCount === 1 ? "1 photo" : `${l.photoCount} photos`}
                </span>
                <span className="min-h-4 text-[11px] leading-tight text-muted-foreground">
                  {!l.caption ? <span data-testid="layout-no-caption">No caption</span> : null}
                  {!l.caption && loses > 0 ? " · " : null}
                  {loses > 0 ? <span className="text-amber-700">−{loses === 1 ? "1 photo" : `${loses} photos`}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const layoutPickerTool: EditorTool = {
  id: "layout",
  label: "Layout",
  icon: LayoutTemplate,
  scopes: ["slot", "caption", "none"],
  order: 20,
  panelTitle: "Page layout",
  isAvailable: (ctx) => layoutTargetPage(ctx) !== null,
  Panel: LayoutPickerPanel,
};
