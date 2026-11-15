"use client";

// One open spread of the facing-pages editor (M10a A9, ≥ md): the left + right page side by side
// like an open book (centre fold shadow, page edges), or the cover alone. Pages are the normal
// <EditablePage> (shared <BookPage>), so selection works exactly as in single-page mode — a
// selection carries its page index. Tapping anywhere on a page first makes it the current page
// (what page tools such as Layout / Page menu / Add page act on).
// Spread layouts (M10b A15): when the two pages are the halves of one spread layout, tapping
// either half makes the spread current — both halves highlight as one box; the right half's slots
// are the left page's (BookPage passes ownerPage), so they are editable there too.
// Box sizing: height-bound, never wider than the slide; the format's page ratio comes from
// src/lib/editor/spreads.ts / format-style.ts (no layout maths here).

import { pageAspectStyle } from "@/lib/book/format-style";
import { spreadStartOf } from "@/lib/book/spreads";
import { spreadAspectRatio, type EditorSpread } from "@/lib/editor/spreads";
import { cx } from "@/lib/cx";
import { useEditor } from "./editor-context";
import { ED_PAGE_FRAME } from "./editor-classes";
import { EditablePage } from "./EditablePage";

/** Stacked page edges + soft drop shadow under the open book. */
export const BOOK_SHADOW =
  "-3px 3px 0 -1px #fafaf9, -3px 3px 0 0 rgba(0,0,0,0.08), 3px 3px 0 -1px #fafaf9, 3px 3px 0 0 rgba(0,0,0,0.08), 0 12px 32px rgba(0,0,0,0.18)";

/**
 * The editor stage's open book (M22 T4): the same stacked page edges, with the drop shadow tinted
 * emerald like ED_PAGE_FRAME. BOOK_SHADOW above stays as is (SpreadPreviewSheet uses it).
 */
export const EDITOR_SPREAD_SHADOW =
  "-3px 3px 0 -1px #fdfaf3, -3px 3px 0 0 rgba(14,59,46,0.1), 3px 3px 0 -1px #fdfaf3, 3px 3px 0 0 rgba(14,59,46,0.1), 0 28px 50px -30px rgba(14,59,46,0.55), 0 2px 8px -2px rgba(14,59,46,0.12)";

/** Active page / spread outline: solid emerald (#0e3b2e, 12.47:1 on white — clear on any page). */
const ACTIVE_OUTLINE = "outline-2 outline-[#0e3b2e] outline-solid";

/** Gutter shading: darkest at the fold, fading out over ~4 % of the spread each side. */
export const FOLD_GRADIENT =
  "linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,0.06) 35%, rgba(0,0,0,0.2) 50%, rgba(0,0,0,0.06) 65%, rgba(0,0,0,0) 100%)";

export function EditorSpreadView({ spread, near, isCurrent }: { spread: EditorSpread; near: boolean; isCurrent: boolean }) {
  const { state } = useEditor();
  const format = state.doc.format;
  // The pair is one spread layout (left half at spread.left).
  const joined = spread.kind === "pages" && spread.left !== null && spreadStartOf(state.doc, spread.left) === spread.left;
  const spreadActive =
    joined && isCurrent && spread.kind === "pages" && (state.page === spread.left || state.page === spread.right);

  if (spread.kind === "cover") {
    const aspectStyle = pageAspectStyle(format);
    return (
      <div className="flex aspect-[148/210] h-full max-w-full items-center" style={aspectStyle} data-testid="editor-spread" data-kind="cover">
        <div className={cx(ED_PAGE_FRAME, "w-full")}>
          {near ? (
            <EditablePage page="cover" priority={isCurrent} />
          ) : (
            <div className="aspect-[148/210] w-full bg-[#fbf8f2]" style={aspectStyle} />
          )}
        </div>
      </div>
    );
  }

  return (
    // Height-bound open book: as tall as the slide allows, fitted to width (landscape books are wide).
    <div className="flex h-full max-w-full items-center" style={{ aspectRatio: spreadAspectRatio(format) }}>
      <div
        className={cx("relative grid w-full grid-cols-2 bg-white", spreadActive && `${ACTIVE_OUTLINE} outline-offset-2`)}
        style={{ boxShadow: EDITOR_SPREAD_SHADOW }}
        data-testid="editor-spread"
        data-kind="pages"
        data-spread-layout={joined ? "true" : undefined}
        data-spread-active={spreadActive ? "true" : undefined}
      >
        <SpreadSide pageIdx={spread.left} side="left" near={near} isCurrent={isCurrent} joinedActive={spreadActive} />
        <SpreadSide pageIdx={spread.right} side="right" near={near} isCurrent={isCurrent} joinedActive={spreadActive} />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/2 w-[8%] -translate-x-1/2"
          style={{ backgroundImage: FOLD_GRADIENT }}
          data-testid="spread-fold"
        />
      </div>
    </div>
  );
}

function SpreadSide({
  pageIdx,
  side,
  near,
  isCurrent,
  joinedActive = false,
}: {
  pageIdx: number | null;
  side: "left" | "right";
  near: boolean;
  isCurrent: boolean;
  /** Both halves of a current spread layout: highlighted together by the spread box. */
  joinedActive?: boolean;
}) {
  const { state, actions } = useEditor();
  if (pageIdx === null) {
    // Odd last page: the right-hand page stays blank (the flipbook adds a blank filler there).
    return <div aria-hidden="true" className="bg-[#fbf8f2]" data-testid="spread-blank" data-side={side} />;
  }
  const active = joinedActive || (isCurrent && state.page === pageIdx);
  return (
    <div
      // Capture: becomes the current page before the slot/caption tap selects (same page → no-op).
      onClickCapture={() => {
        if (state.page !== pageIdx) actions.goTo(pageIdx);
      }}
      className={cx("relative", active && !joinedActive && `z-[1] ${ACTIVE_OUTLINE}`)}
      data-testid="spread-page"
      data-side={side}
      data-page-idx={pageIdx}
      data-active={active ? "true" : "false"}
      aria-current={active ? "page" : undefined}
    >
      {near ? (
        <EditablePage page={pageIdx} priority={isCurrent} />
      ) : (
        <div className="aspect-[148/210] w-full bg-[#fbf8f2]" style={pageAspectStyle(state.doc.format)} />
      )}
    </div>
  );
}
