"use client";

// Desktop page strip: vertical list of small <BookPage> thumbnails (view mode, 512px thumbs).
// Tap → jump to that page. Hidden below lg — on phones the carousel + counter do the job.
// Task 11's Pages sheet (reorder/delete) is separate; this strip only navigates.

import { useEffect, useRef } from "react";
import { BookPage } from "@/components/book/BookPage";
import { itemToPosition, positionToItem } from "@/lib/editor/store";
import { cn } from "@/lib/utils";
import { useEditor } from "./editor-context";

export function PageStrip({ className }: { className?: string }) {
  const { state, actions, photos, book } = useEditor();
  const current = positionToItem(state.page);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-item="${current}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const count = state.doc.pages.length + 1;
  return (
    <nav aria-label="Pages" className={cn("min-h-0 overflow-y-auto border-r bg-muted/30", className)} data-testid="page-strip">
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
                  "block w-full rounded-sm outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-primary",
                  active ? "ring-2 ring-primary" : "ring-1 ring-black/10 hover:ring-black/30",
                )}
              >
                <BookPage doc={state.doc} page={itemToPosition(item)} mode="view" photos={photos.thumbs} captionLang={book.captionLang} />
              </button>
              <span className="mt-1 block text-center text-xs text-muted-foreground">{item === 0 ? "Cover" : item}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
