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
import { cn } from "@/lib/utils";
import { useEditor } from "./editor-context";

export function PageStrip({ className }: { className?: string }) {
  const { state, actions, photos, book, spread } = useEditor();
  const current = positionToItem(state.page);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-item="${current}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const count = state.doc.pages.length + 1;

  const thumb = (item: number) => {
    const active = item === current;
    const pos: EditorPosition = itemToPosition(item);
    return (
      <div data-item={item} className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => actions.goTo(pos)}
          aria-current={active ? "page" : undefined}
          aria-label={item === 0 ? "Cover" : `Page ${item}`}
          className={cn(
            "block w-full rounded-sm outline-none ring-offset-2 ring-offset-muted focus-visible:ring-2 focus-visible:ring-ring",
            active ? "ring-2 ring-primary" : "ring-1 ring-border hover:ring-input",
          )}
        >
          <BookPage doc={state.doc} page={pos} mode="view" photos={photos.thumbs} captionLang={book.captionLang} />
        </button>
        <span className={cn("mt-1 block text-center text-xs", active ? "font-semibold text-foreground" : "text-muted-foreground")}>{item === 0 ? "Cover" : item}</span>
      </div>
    );
  };

  if (spread) {
    return (
      <nav aria-label="Pages" className={cn("min-h-0 overflow-y-auto border-r border-border bg-muted/40", className)} data-testid="page-strip" data-mode="spread">
        <ol ref={listRef} className="flex flex-col gap-4 p-3">
          {editorSpreads(state.doc).map((sp, i) => (
            <li
              key={sp.kind === "cover" ? "cover" : state.doc.pages[sp.left ?? 0]?.id ?? i}
              className={cn("flex gap-0.5", sp.kind === "cover" && "mx-auto w-1/2")}
              data-testid="strip-spread"
            >
              {sp.kind === "cover" ? (
                thumb(0)
              ) : (
                <>
                  {sp.left !== null ? thumb(sp.left + 1) : <div className="flex-1" />}
                  {sp.right !== null ? thumb(sp.right + 1) : <div className="flex-1" />}
                </>
              )}
            </li>
          ))}
        </ol>
      </nav>
    );
  }

  return (
    <nav aria-label="Pages" className={cn("min-h-0 overflow-y-auto border-r border-border bg-muted/40", className)} data-testid="page-strip">
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
                className={cn(
                  "block w-full rounded-sm outline-none ring-offset-2 ring-offset-muted focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "ring-2 ring-primary" : "ring-1 ring-border hover:ring-input",
                )}
              >
                <BookPage doc={state.doc} page={itemToPosition(item)} mode="view" photos={photos.thumbs} captionLang={book.captionLang} />
              </button>
              <span className={cn("mt-1 block text-center text-xs", active ? "font-semibold text-foreground" : "text-muted-foreground")}>{item === 0 ? "Cover" : item}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
