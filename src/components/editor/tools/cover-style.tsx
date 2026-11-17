"use client";

// Cover style (M29 T7): pick the cover's layout from every cover of the book's format + design
// style (coverStylesFor). Each option is a live <BookPage page="cover"> thumbnail of THIS book —
// its cover photo, title and subtitle — so the user sees exactly what they get; the current one
// carries the emerald ring + check (D-074, same tiles as Layout). Applying = one setCoverLayout
// edit = one undo step; photo, title and subtitle stay. Docked under the page on phones and kept
// open after a tap, so the big cover updates above while the user compares styles.

import { Check, LayoutTemplate } from "lucide-react";
import { useMemo } from "react";
import { BookPage } from "@/components/book/BookPage";
import { setCoverLayout } from "@/lib/book/edit-ops";
import { coverStyleAvailable, coverStyleName, coverStyleOptions, type CoverStyleOption } from "@/lib/editor/cover-styles";
import type { EditorContextValue } from "../editor-context";
import { CHECK_BADGE, TOOL_TILE, TOOL_TILE_ACTIVE } from "./tool-classes";
import type { EditorPanelProps, EditorTool } from "./types";

/** Apply a cover style: one edit (one undo step); a no-op for the current style or read-only. */
export function applyCoverStyle(ctx: Pick<EditorContextValue, "readOnly" | "actions">, layoutId: string): void {
  if (ctx.readOnly) return;
  ctx.actions.edit((d) => setCoverLayout(d, layoutId));
}

export function CoverStylePanel({ ctx }: EditorPanelProps) {
  const doc = ctx.state.doc;
  const options = useMemo(() => coverStyleOptions(doc), [doc]);
  const landscape = doc.format === "A5_LANDSCAPE";
  return (
    <div className="flex flex-col gap-3" data-testid="cover-style-picker">
      <p className="text-sm text-muted-foreground">Your photo and title stay. Tap a style to try it.</p>
      <ul
        className={landscape ? "grid grid-cols-2 gap-2 sm:gap-3" : "grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-2"}
        aria-label="Cover styles"
      >
        {options.map((o) => (
          <CoverStyleButton key={o.layout.id} o={o} ctx={ctx} />
        ))}
      </ul>
    </div>
  );
}

function CoverStyleButton({ o, ctx }: { o: CoverStyleOption; ctx: EditorContextValue }) {
  const name = coverStyleName(o.layout);
  return (
    <li>
      <button
        type="button"
        onClick={() => applyCoverStyle(ctx, o.layout.id)}
        disabled={ctx.readOnly}
        aria-pressed={o.current}
        aria-label={`${name}${o.current ? " (current)" : ""}`}
        className={o.current ? TOOL_TILE_ACTIVE : TOOL_TILE}
        data-testid="cover-style-option"
        data-layout-id={o.layout.id}
        data-current={o.current ? "true" : undefined}
      >
        {o.current ? (
          <span className={CHECK_BADGE} aria-hidden="true">
            <Check className="size-3" strokeWidth={3} />
          </span>
        ) : null}
        <span className="pointer-events-none block overflow-hidden rounded-lg" aria-hidden="true">
          <BookPage doc={o.preview} page="cover" mode="view" photos={ctx.photos.thumbs} captionLang={ctx.book.captionLang} />
        </span>
      </button>
    </li>
  );
}

export const coverStyleTool: EditorTool = {
  id: "cover-style",
  label: "Cover style",
  icon: LayoutTemplate,
  // Where Layout sits for a page: primary on the cover with nothing selected, behind More while
  // the cover photo or title is selected.
  scopes: ["none", "cover"],
  order: 20,
  tier: { none: "primary" },
  panelTitle: "Cover style",
  dockOnMobile: true,
  isAvailable: (ctx) => coverStyleAvailable(ctx.state.doc, ctx.state.page),
  Panel: CoverStylePanel,
};
