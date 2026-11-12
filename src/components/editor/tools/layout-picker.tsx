"use client";

// Layout (M5 Task 9): switch the current page's layout. Each option is a small diagram drawn
// from the layout data itself (slots + caption area as % of the page) — no layout maths here.
// Photos re-flow in order (changeLayout); anything lost is announced in a toast with Undo.
// M10b A15: only layouts of the book's format + style (layoutsFor, D-063); two-page layouts in
// their own group, disabled with the reason when planChangeLayout says they can't start here
// (e.g. "Starts on a left page"); removing user captions asks first (confirmDropCaptions).
// M11 T14: docked under the page on phones (dockOnMobile) so the page stays visible while choosing;
// four diagrams per row keep each option ≥ 44 px at 375 px and more of them inside the 42dvh panel.
// M10c T14: shaped / tilted / framed slots draw their shape, tilt and frame card (diagramSlotLook)
// so geometric and scrapbook options are recognisable; decorations are left out. Plain slots keep
// their M5 markup.

import { LayoutTemplate } from "lucide-react";
import { useMemo, useState } from "react";
import { changeLayout, type ChangeLayoutResult } from "@/lib/book/edit-ops";
import { pageAspectStyle } from "@/lib/book/format-style";
import { paintOrder } from "@/lib/book/slot-geometry";
import type { BookFormat, Caption, Layout } from "@/lib/book/types";
import { layoutOptions, type LayoutOption } from "@/lib/editor/layout-options";
import { diagramSlotLook } from "@/lib/editor/shaped-slots";
import { splitNotice } from "@/lib/editor/pages";
import { layoutChangeNotice } from "@/lib/editor/photo-picker";
import { spreadAspectRatio } from "@/lib/editor/spreads";
import { EDIT_ERROR_COPY } from "@/lib/editor/store";
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

type Rect = { x: number; y: number; w: number; h: number };

/** CSS box of a layout rect; spreads use 0–200 % of a page width, drawn on a 2-page-wide box. */
function rectStyle(r: Rect, spread: boolean) {
  const k = spread ? 2 : 1;
  return { left: `${r.x / k}%`, top: `${r.y}%`, width: `${r.w / k}%`, height: `${r.h}%` };
}

/**
 * Small diagram of a layout, straight from its data, in the book's page shape (doc.format):
 * spreads two pages wide with a fold line, split-strip covers as their slices.
 */
export function LayoutDiagram({ layout, format, className }: { layout: Layout; format?: BookFormat | null; className?: string }) {
  const spread = layout.role === "spread";
  const boxes: readonly Rect[] = layout.slices ?? layout.slots;
  // Slots bottom → top as the page paints them (z); slices as they come.
  const order = layout.slices ? boxes.map((_, i) => i) : paintOrder(layout);
  return (
    <div
      className={cn("relative aspect-[148/210] w-full rounded-sm border border-border bg-white", className)}
      style={spread ? { aspectRatio: spreadAspectRatio(format) } : pageAspectStyle(format)}
      aria-hidden="true"
      data-kind={spread ? "spread" : undefined}
    >
      {order.map((i) => {
        const r = boxes[i];
        const look = layout.slices ? null : diagramSlotLook(layout, i, format);
        if (!look) return <div key={i} className="absolute rounded-[2px] bg-input/60" style={rectStyle(r, spread)} data-diagram-box="" />;
        const shapeStyle = {
          ...(look.borderRadius ? { borderRadius: look.borderRadius } : {}),
          ...(look.clipPath ? { clipPath: look.clipPath } : {}),
        };
        return (
          <div
            key={i}
            className={cn("absolute", look.photo ? "bg-white shadow-[0_0_0_1px_var(--color-border)]" : "bg-input/80")}
            style={{ ...rectStyle(r, spread), ...shapeStyle, ...(look.rotate ? { transform: `rotate(${look.rotate}deg)` } : {}) }}
            data-diagram-box=""
            data-diagram-shaped="true"
          >
            {look.photo ? <div className="absolute bg-input/80" style={{ ...rectStyle(look.photo, false), ...shapeStyle }} /> : null}
          </div>
        );
      })}
      {layout.caption ? (
        <div
          className="absolute flex flex-col items-center justify-center gap-[3px]"
          style={rectStyle(layout.caption, spread)}
          data-testid="layout-diagram-caption"
        >
          <span className="block h-[2px] w-3/4 rounded bg-border" />
          <span className="block h-[2px] w-1/2 rounded bg-border" />
        </div>
      ) : null}
      {spread ? <div className="absolute inset-y-0 left-1/2 w-px bg-border" data-testid="layout-diagram-fold" /> : null}
    </div>
  );
}

const photosLabel = (n: number) => (n === 1 ? "1 photo" : `${n} photos`);

/** Toast after a layout change: lost photos / caption, a split spread (D-064). */
export function layoutAppliedNotice(result: ChangeLayoutResult, splitOwnSpread: boolean): string | null {
  const parts = [
    splitOwnSpread ? "Two-page layout split into single pages" : null,
    layoutChangeNotice(result),
    splitNotice(result.splitCount),
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : null;
}

interface PendingConfirm {
  layout: Layout;
  captions: Caption[];
}

export function LayoutPickerPanel({ ctx, close }: EditorPanelProps) {
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pageIdx = layoutTargetPage(ctx);
  const doc = ctx.state.doc;
  const maxPages = ctx.book.maxPages;
  // M12 T6: layoutOptions dry-runs planChangeLayout for every layout — only redo it when its inputs change.
  const opts = useMemo(() => (pageIdx === null ? null : layoutOptions(doc, pageIdx, maxPages)), [doc, pageIdx, maxPages]);
  if (pageIdx === null || opts === null) return null;

  const apply = (layout: Layout, confirmed: boolean) => {
    if (ctx.readOnly) return;
    const base = ctx.state.doc;
    const found = [...opts.pages, ...opts.spreads].find((o) => o.layout.id === layout.id);
    const plan = found?.plan;
    if (!plan) return;
    if (!plan.ok) {
      setError(EDIT_ERROR_COPY[plan.code]);
      return;
    }
    if (plan.result.doc === base) {
      close();
      return;
    }
    if (plan.needsConfirm && !confirmed) {
      setConfirm({ layout, captions: plan.droppedUserCaptions });
      return;
    }
    const result = plan.result;
    ctx.actions.edit(
      (d) => (d === base ? result.doc : changeLayout(d, pageIdx, layout.id, { maxPages, confirmDropCaptions: confirmed }).doc),
      { goTo: result.pageIdx, select: null },
    );
    const notice = layoutAppliedNotice(result, opts.onSpread && layout.role !== "spread");
    if (notice) showEditorToast({ message: notice, actionLabel: "Undo", onAction: ctx.actions.undo, dismissOnEdit: true });
    close();
  };

  if (confirm) {
    const n = confirm.captions.length;
    return (
      <div role="alertdialog" aria-labelledby="layout-confirm-title" className="flex flex-col gap-3" data-testid="layout-confirm">
        <h3 id="layout-confirm-title" className="text-sm font-semibold">
          {n === 1 ? "Remove 1 caption?" : `Remove ${n} captions?`}
        </h3>
        <p className="text-sm text-muted-foreground">
          This two-page layout has room for one caption. {n === 1 ? "This caption" : "These captions"} will be removed:
        </p>
        <ul className="flex flex-col gap-2">
          {confirm.captions.map((c, i) => (
            <li key={i} dir="auto" className="break-words rounded-lg bg-muted px-3 py-2 text-sm" data-testid="layout-confirm-caption">
              {c.text}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setConfirm(null)}
            className="min-h-11 flex-1 rounded-lg border border-border bg-card px-4 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="layout-confirm-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => apply(confirm.layout, true)}
            className="min-h-11 flex-1 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            data-testid="layout-confirm-apply"
          >
            Remove and apply
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="layout-picker">
      <p className="text-sm text-muted-foreground">
        {photosLabel(opts.placed)} on this {opts.onSpread ? "two-page layout" : "page"}. Photos move into the new layout in order.
      </p>
      {error ? (
        <p role="alert" className="rounded-lg border border-destructive-border bg-destructive-soft px-3 py-2 text-sm text-destructive" data-testid="layout-error">
          {error}
        </p>
      ) : null}
      <ul className="grid grid-cols-4 gap-2 sm:gap-3 lg:grid-cols-3" aria-label="One-page layouts">
        {opts.pages.map((o) => (
          <OptionButton key={o.layout.id} o={o} format={doc.format} onChoose={() => apply(o.layout, false)} />
        ))}
      </ul>
      {opts.spreads.length > 0 ? (
        <section className="flex flex-col gap-2" aria-labelledby="layout-spreads-title" data-testid="layout-spreads">
          <h3 id="layout-spreads-title" className="text-sm font-semibold">
            Across two pages
          </h3>
          <ul className="grid grid-cols-2 gap-2 sm:gap-3" aria-label="Two-page layouts">
            {opts.spreads.map((o) => (
              <OptionButton key={o.layout.id} o={o} format={doc.format} onChoose={() => apply(o.layout, false)} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function OptionButton({ o, format, onChoose }: { o: LayoutOption; format: BookFormat; onChoose(): void }) {
  const l = o.layout;
  const spread = l.role === "spread";
  const label = [
    `${l.name}: ${photosLabel(l.photoCount)}`,
    spread ? "across two pages" : null,
    l.caption ? null : "no caption",
    o.loses > 0 ? `${o.loses} won't fit` : null,
    o.reason ? o.reason.toLowerCase() : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <li>
      <button
        type="button"
        onClick={onChoose}
        disabled={o.disabled}
        aria-pressed={o.current}
        aria-label={`${label}${o.current ? " (current)" : ""}`}
        className={cn(
          "flex min-h-11 w-full flex-col items-stretch gap-1 rounded-lg p-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
          o.current ? "bg-secondary ring-2 ring-primary" : "hover:bg-muted",
          o.disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
        )}
        data-testid="layout-option"
        data-layout-id={l.id}
        data-role={l.role}
        data-disabled={o.disabled ? "true" : undefined}
      >
        <LayoutDiagram layout={l} format={format} />
        <span className="text-xs font-medium tabular-nums">{photosLabel(l.photoCount)}</span>
        <span className="min-h-4 text-[11px] leading-tight text-muted-foreground">
          {o.reason ? (
            <span data-testid="layout-disabled-reason">{o.reason}</span>
          ) : (
            <>
              {!l.caption ? <span data-testid="layout-no-caption">No caption</span> : null}
              {!l.caption && o.loses > 0 ? " · " : null}
              {o.loses > 0 ? <span className="font-medium text-warning">−{photosLabel(o.loses)}</span> : null}
            </>
          )}
        </span>
      </button>
    </li>
  );
}

export const layoutPickerTool: EditorTool = {
  id: "layout",
  label: "Layout",
  icon: LayoutTemplate,
  scopes: ["slot", "caption", "none"],
  order: 20,
  // Primary for the page (nothing selected); behind More while a photo or caption is selected.
  tier: { none: "primary" },
  panelTitle: "Page layout",
  // M11: the page stays visible above the panel on phones while choosing.
  dockOnMobile: true,
  isAvailable: (ctx) => layoutTargetPage(ctx) !== null,
  Panel: LayoutPickerPanel,
};
