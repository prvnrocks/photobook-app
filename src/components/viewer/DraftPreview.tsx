"use client";

// Draft preview (the editor header's "Preview" button): the draft as readers will see it — the real
// flipbook (FlipbookLoader) fed with the editor's live doc, so unsaved edits and the free-book
// watermark show too. Full-screen modal over the editor; nothing here edits the doc.
// A viewer component on purpose (the paper paint stays viewer-only, M27): the editor only loads it
// on demand (next/dynamic in EditorShell), so page-flip and the viewer CSS stay out of the editor's
// first load. Keys: ← / → turn pages, Escape closes; Tab stays inside.

import "./viewer-motion.css";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RenderPhotos } from "@/components/book/BookPage";
import { Watermark } from "@/components/book/Watermark";
import type { BookDoc } from "@/lib/book/types";
import { FlipbookLoader, type FlipbookApi, type FlipbookReadyInfo } from "./FlipbookLoader";
import { VW_COUNTER_PILL, VW_NAV_BTN, VW_STAGE } from "./viewer-classes";
import { cx } from "@/lib/cx";
import { trapFocusIndex } from "@/lib/editor/roving";
import { pageCounterLabel } from "@/lib/viewer/pages";

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export type DraftPreviewProps = {
  doc: BookDoc;
  photos: RenderPhotos;
  captionLang: string;
  /** Unpaid books preview with the watermark readers will see. */
  isPaid: boolean;
  onClose: () => void;
};

export default function DraftPreview({ doc, photos, captionLang, isPaid, onClose }: DraftPreviewProps) {
  const api = useRef<FlipbookApi | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [current, setCurrent] = useState(0);
  const [info, setInfo] = useState<FlipbookReadyInfo | null>(null);
  const overlay = useMemo(() => (isPaid ? undefined : <Watermark />), [isPaid]);
  const onReady = useCallback((i: FlipbookReadyInfo) => setInfo(i), []);

  // Focus the close button; give focus back to whatever opened the preview.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    closeRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  // Capture phase: the editor's own shortcuts (arrows, undo, Escape) never see keys meant for the preview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const list = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest(".stf__parent"));
        e.preventDefault();
        list[trapFocusIndex(list.indexOf(document.activeElement as HTMLElement), list.length, e.shiftKey)]?.focus();
        return;
      }
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") api.current?.prev();
      else if (e.key === "ArrowRight") api.current?.next();
      else if ((e.metaKey || e.ctrlKey) && ["z", "y"].includes(e.key.toLowerCase())) {
        // No undo/redo behind the preview.
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const last = info ? info.pageCount - 1 : 0;
  const atEnd = info ? current >= last - (info.spread && current > 0 ? 1 : 0) : true;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Book preview"
      className="fixed inset-0 z-50 flex flex-col bg-[#f4ede0]"
      data-testid="editor-preview"
    >
      <header className="flex shrink-0 items-center gap-3 bg-[#0e3b2e] py-2 ps-[max(1rem,env(safe-area-inset-left))] pe-[max(0.5rem,env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))] text-[#f2e8d8]">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg leading-tight font-semibold">Preview</h2>
          <p className="text-xs leading-snug text-[#f2e8d8]/85" data-testid="editor-preview-note">
            {isPaid ? "This is how your book looks when you share it." : "This is how your book looks when you share it. Free books show a watermark."}
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close preview, back to editing"
          className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-[#f2e8d8]/45 px-4 text-sm font-semibold outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[#f2e8d8] motion-reduce:transition-none"
          data-testid="editor-preview-close"
        >
          <X className="size-4" aria-hidden="true" />
          <span className="sm:hidden">Close</span>
          <span className="hidden sm:inline">Back to editing</span>
        </button>
      </header>

      <div className={cx("relative min-h-0 flex-1 p-3 sm:p-6", VW_STAGE)} data-testid="editor-preview-stage">
        <FlipbookLoader
          doc={doc}
          photos={photos}
          captionLang={captionLang}
          onFlip={setCurrent}
          onReady={onReady}
          apiRef={api}
          pageOverlay={overlay}
        />
      </div>

      <div className="flex shrink-0 justify-center pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-1 rounded-full bg-white p-1 shadow-[0_14px_32px_-18px_rgb(14_59_46/0.55)] ring-1 ring-[#e9dfca]">
          <button type="button" onClick={() => api.current?.prev()} disabled={current <= 0} aria-label="Previous page" className={VW_NAV_BTN} data-testid="editor-preview-prev">
            <ChevronLeft className="size-5" aria-hidden="true" />
          </button>
          <span className={VW_COUNTER_PILL} aria-live="polite" data-testid="editor-preview-counter">
            {info ? pageCounterLabel(info.layout, current, info.spread) : "…"}
          </span>
          <button type="button" onClick={() => api.current?.next()} disabled={atEnd} aria-label="Next page" className={VW_NAV_BTN} data-testid="editor-preview-next">
            <ChevronRight className="size-5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
