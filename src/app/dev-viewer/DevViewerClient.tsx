"use client";

// Mounts the real flipbook with the fixture book (dev-only route). The bar below the book is a
// stand-in for the viewer controls (Task 5): page label + prev/next through the FlipbookApi.

import { useMemo, useRef, useState } from "react";
import { FlipbookLoader, type FlipbookApi } from "@/components/viewer/FlipbookLoader";
import { devViewerDoc, devViewerPhotos } from "@/lib/viewer/dev-fixture";

export function DevViewerClient({ paid, lang }: { paid: boolean; lang: "en" | "ar" }) {
  const doc = useMemo(() => devViewerDoc({ lang }), [lang]);
  const photos = useMemo(() => devViewerPhotos(), []);
  const api = useRef<FlipbookApi | null>(null);
  const [page, setPage] = useState(0);
  const [ready, setReady] = useState<string>("loading");
  const chapterId = page === 0 ? null : doc.pages[page - 1]?.chapterId;
  const chapter = doc.chapters.find((c) => c.id === chapterId);

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-neutral-100" data-paid={String(paid)} data-lang={lang}>
      <div className="min-h-0 flex-1 p-3">
        <FlipbookLoader
          doc={doc}
          photos={photos}
          captionLang={lang}
          currentPage={page}
          onFlip={setPage}
          onReady={(i) => setReady(`${i.pageCount} pages · ${i.spread ? "spread" : "single"}`)}
          apiRef={api}
        />
      </div>
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-t bg-white px-3 text-sm pb-[env(safe-area-inset-bottom)]">
        <button type="button" className="rounded-md border px-3 py-1.5" onClick={() => api.current?.prev()}>
          Prev
        </button>
        <span className="min-w-0 truncate text-center text-neutral-600" data-testid="dev-viewer-status">
          <span dir="auto">{page === 0 ? "Cover" : `Page ${page}${chapter ? ` · ${chapter.title}` : ""}`}</span>
          <span className="ml-2 text-xs text-neutral-400">{ready}</span>
        </span>
        <button type="button" className="rounded-md border px-3 py-1.5" onClick={() => api.current?.next()}>
          Next
        </button>
      </div>
    </main>
  );
}
