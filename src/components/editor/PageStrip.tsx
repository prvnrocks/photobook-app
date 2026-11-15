"use client";

// Desktop page strip: vertical list of small <BookPage> thumbnails (view mode, 512px thumbs).
// Tap → jump to that page. Hidden below lg — on phones the carousel + counter do the job.
// Task 11's Pages sheet (reorder/delete) is separate; this strip only navigates.
// Facing pages (M10a A9, ctx.spread): thumbnails grouped as the book opens — cover alone, then
// pairs [1,2], [3,4], … side by side (src/lib/editor/spreads.ts).

import { useEffect, useRef } from "react";
import { BookPage } from "@/components/book/BookPage";
import { editorSpreads } from "@/lib/editor/spreads";
import { itemToPosition, positionToItem, type EditorPosition } from "@/lib/editor/store";
import { cx } from "@/lib/cx";
import { cn } from "@/lib/utils";
import { useEditor } from "./editor-context";
import { ED_STAGE_LABEL, ED_THUMB, ED_THUMB_ACTIVE } from "./editor-classes";

// M22 T4: thumbnail cards on a cream strip. ED_THUMB / ED_THUMB_ACTIVE are alternatives (never both);
// the current page gets the emerald ring + glow (box-shadow only) and a bold emerald label.
// Width comes from the caller (EditorShell: w-44 spread / w-36 single, same as its placeholder).
const STRIP = "min-h-0 overflow-y-auto border-r border-[#e5dccb] bg-[#f4ede0]";
/** Current page label: emerald #0e3b2e on the strip 10.9:1. */
const LABEL_ACTIVE = "text-xs font-bold text-[#0e3b2e]";
/**
 * Thumbnail card: the recipe's rounded-xl is too round at thumbnail size, so cn (tailwind-merge)
 * swaps it for rounded-md; a spread pair's inner corners stay square so the pair reads as one book.
 */
const thumbClass = (active: boolean, side?: "left" | "right") =>
  cn(active ? ED_THUMB_ACTIVE : ED_THUMB, "w-full rounded-md", side === "left" && "rounded-e-none", side === "right" && "rounded-s-none");
const labelClass = (active: boolean) => cx("mt-1.5 block text-center", active ? LABEL_ACTIVE : ED_STAGE_LABEL);

export function PageStrip({ className }: { className?: string }) {
  const { state, actions, photos, book, spread } = useEditor();
  const current = positionToItem(state.page);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-item="${current}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const count = state.doc.pages.length + 1;

  const thumb = (item: number, side?: "left" | "right") => {
    const active = item === current;
    const pos: EditorPosition = itemToPosition(item);
    return (
      <div data-item={item} className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => actions.goTo(pos)}
          aria-current={active ? "page" : undefined}
          aria-label={item === 0 ? "Cover" : `Page ${item}`}
          className={thumbClass(active, side)}
        >
          <BookPage doc={state.doc} page={pos} mode="view" photos={photos.thumbs} captionLang={book.captionLang} />
        </button>
        <span className={labelClass(active)}>{item === 0 ? "Cover" : item}</span>
      </div>
    );
  };

  if (spread) {
    return (
      <nav aria-label="Pages" className={cx(STRIP, className)} data-testid="page-strip" data-mode="spread">
        <ol ref={listRef} className="flex flex-col gap-4 p-3">
          {editorSpreads(state.doc).map((sp, i) => (
            <li
              key={sp.kind === "cover" ? "cover" : state.doc.pages[sp.left ?? 0]?.id ?? i}
              className={cx("flex gap-0.5", sp.kind === "cover" && "mx-auto w-1/2")}
              data-testid="strip-spread"
            >
              {sp.kind === "cover" ? (
                thumb(0)
              ) : (
                <>
                  {sp.left !== null ? thumb(sp.left + 1, "left") : <div className="flex-1" />}
                  {sp.right !== null ? thumb(sp.right + 1, "right") : <div className="flex-1" />}
                </>
              )}
            </li>
          ))}
        </ol>
      </nav>
    );
  }

  return (
    <nav aria-label="Pages" className={cx(STRIP, className)} data-testid="page-strip">
      <ol ref={listRef} className="flex flex-col gap-3 p-3">
        {Array.from({ length: count }, (_, item) => {
          const active = item === current;
          return (
            <li key={item === 0 ? "cover" : state.doc.pages[item - 1].id} data-item={item}>
              <button
                type="button"
                onClick={() => actions.goTo(itemToPosition(item))}
                aria-current={active ? "page" : undefined}
                aria-label={item === 0 ? "Cover" : `Page ${item}`}
                className={thumbClass(active)}
              >
                <BookPage doc={state.doc} page={itemToPosition(item)} mode="view" photos={photos.thumbs} captionLang={book.captionLang} />
              </button>
              <span className={labelClass(active)}>{item === 0 ? "Cover" : item}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
