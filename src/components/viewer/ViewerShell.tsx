"use client";

// Public viewer chrome around the flipbook (D-040): top bar (title, chapter label, fullscreen),
// the book stage, bottom bar (prev / counter / next, Contents, Share), free-book footer,
// watermark over pages and an end card as the last page. Full-height column (h-dvh) that
// respects safe-area insets; works at 375 px. Renders from the render doc (publicDocToRenderDoc).

import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Ellipsis, List, Share2 } from "lucide-react";
import type { RenderPhotos } from "@/components/book/BookPage";
import { Watermark } from "@/components/book/Watermark";
import type { BookDoc } from "@/lib/book/types";
import { chapterForPage, labelFontStyle } from "@/lib/viewer/chapters";
import { endCardModel } from "@/lib/viewer/end-card";
import { firstVisiblePageIdx, flipLayout } from "@/lib/viewer/pages";
import { visiblePages } from "@/lib/viewer/window";
import { ChapterLabel } from "./ChapterLabel";
import { ContentsSheet } from "./ContentsSheet";
import { EndCard } from "./EndCard";
import { FlipbookLoader, type FlipbookApi, type FlipbookReadyInfo } from "./FlipbookLoader";
import { FullscreenButton, useFullscreen } from "./FullscreenButton";
import { MadeWithFooter } from "./MadeWithFooter";
import { PageCounter } from "./PageCounter";
import { ShareButtons } from "./ShareButtons";
import { ViewerSheet } from "./ViewerSheet";

export type ViewerShellProps = {
  /** Render doc (publicDocToRenderDoc of the published snapshot). */
  doc: BookDoc;
  photos: RenderPhotos;
  captionLang?: string;
  /** Book title for the top bar (may be Arabic). */
  title: string;
  /** Server-derived paid status (only the Stripe webhook sets it): hides watermark + footer. */
  isPaid: boolean;
  /** Absolute public URL of this book. */
  shareUrl: string;
  /** Text before the URL in share messages (password books: no title, D-040). */
  shareTitle: string;
};

const ICON_BTN =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-neutral-800 hover:bg-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent";

export function ViewerShell({ doc, photos, captionLang, title, isPaid, shareUrl, shareTitle }: ViewerShellProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const api = useRef<FlipbookApi | null>(null);
  const [current, setCurrent] = useState(0);
  const [spread, setSpread] = useState(false);
  const [sheet, setSheet] = useState<"contents" | "share" | null>(null);
  const [chromeShown, setChromeShown] = useState(false);
  const fs = useFullscreen(rootRef);
  const pseudo = fs.mode === "pseudo";
  const chromeHidden = pseudo && !chromeShown;

  const layout = useMemo(() => flipLayout(doc.pages.length, { endCard: true, spread }), [doc.pages.length, spread]);
  const pageIdx = firstVisiblePageIdx(layout, current, spread);
  const chapter = chapterForPage(doc, pageIdx);
  const visible = visiblePages(current, layout.count, spread);
  const atStart = current <= 0;
  const atEnd = visible.includes(layout.count - 1);

  // Stable nodes: Flipbook puts them in context; new identities re-render every page.
  // Paid end card (D-054): snapshot title in the cover font on the page background; Replay flips
  // back to the cover, Share opens the share sheet. Callbacks are stable (ref + state setter).
  const endModel = useMemo(
    () => (isPaid ? endCardModel({ title, styleFont: doc.style.font, background: doc.style.background }) : undefined),
    [isPaid, title, doc.style.font, doc.style.background],
  );
  const replay = useCallback(() => api.current?.goTo(0), []);
  const openShare = useCallback(() => setSheet("share"), []);
  const endPage = useMemo(
    () => <EndCard isPaid={isPaid} model={endModel} onReplay={replay} onShare={openShare} format={doc.format} />,
    [isPaid, endModel, replay, openShare, doc.format],
  );
  const pageOverlay = useMemo(() => (isPaid ? undefined : <Watermark />), [isPaid]);

  const onReady = useCallback((info: FlipbookReadyInfo) => setSpread(info.spread), []);
  const toggleFullscreen = useCallback(() => {
    setChromeShown(false);
    void fs.toggle();
  }, [fs]);

  const bar = "bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85";
  const overlayTop = pseudo ? "absolute inset-x-0 top-0 z-20 shadow-sm" : "";
  const overlayBottom = pseudo ? "absolute inset-x-0 bottom-0 z-20 shadow-sm" : "";

  return (
    <div
      ref={rootRef}
      className={`flex h-dvh w-full flex-col overflow-hidden bg-neutral-100 ${pseudo ? "fixed inset-0 z-40" : "relative"}`}
      data-testid="viewer-shell"
      data-paid={String(isPaid)}
      data-fullscreen={fs.mode}
      data-chrome={chromeHidden ? "hidden" : "shown"}
    >
      {chromeHidden ? null : (
        <header
          className={`flex shrink-0 items-center gap-2 border-b pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] ${bar} ${overlayTop}`}
          data-testid="viewer-top-bar"
        >
          <div className="min-w-0 flex-1 py-1.5">
            <h1 dir="auto" style={labelFontStyle(title)} className="truncate text-sm font-semibold text-neutral-900" data-testid="viewer-title">
              {title}
            </h1>
            <ChapterLabel chapter={chapter} />
          </div>
          <FullscreenButton active={fs.mode !== "off"} onToggle={toggleFullscreen} />
        </header>
      )}

      <div
        className="relative min-h-0 flex-1 p-2 sm:p-4"
        data-testid="viewer-stage"
        onClick={(e) => {
          // Tapping the empty stage around the book toggles the controls in pseudo-fullscreen.
          if (pseudo && e.target === e.currentTarget) setChromeShown((v) => !v);
        }}
      >
        <FlipbookLoader
          doc={doc}
          photos={photos}
          captionLang={captionLang}
          onFlip={setCurrent}
          onReady={onReady}
          apiRef={api}
          endPage={endPage}
          pageOverlay={pageOverlay}
        />
        {chromeHidden ? (
          <button
            type="button"
            onClick={() => setChromeShown(true)}
            aria-label="Show controls"
            className="absolute top-[max(0.5rem,env(safe-area-inset-top))] right-[max(0.5rem,env(safe-area-inset-right))] z-20 flex size-10 items-center justify-center rounded-full bg-black/45 text-white"
            data-testid="show-controls"
          >
            <Ellipsis className="size-5" aria-hidden />
          </button>
        ) : null}
      </div>

      {chromeHidden ? null : (
        <nav
          aria-label="Book navigation"
          className={`flex shrink-0 items-center justify-between gap-1 border-t pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.5rem,env(safe-area-inset-left))] ${isPaid || pseudo ? "pb-[env(safe-area-inset-bottom)]" : ""} ${bar} ${overlayBottom}`}
          data-testid="viewer-bottom-bar"
        >
          <button type="button" onClick={() => setSheet("contents")} className={`${ICON_BTN} w-auto gap-1.5 px-2.5 text-sm`} data-testid="contents-button">
            <List className="size-5" aria-hidden />
            <span className="max-[359px]:sr-only">Contents</span>
          </button>
          <div className="flex items-center">
            <button type="button" onClick={() => api.current?.prev()} disabled={atStart} aria-label="Previous page" className={ICON_BTN} data-testid="prev-page">
              <ChevronLeft className="size-6" aria-hidden />
            </button>
            <PageCounter layout={layout} current={current} spread={spread} />
            <button type="button" onClick={() => api.current?.next()} disabled={atEnd} aria-label="Next page" className={ICON_BTN} data-testid="next-page">
              <ChevronRight className="size-6" aria-hidden />
            </button>
          </div>
          <button type="button" onClick={() => setSheet("share")} className={`${ICON_BTN} w-auto gap-1.5 px-2.5 text-sm`} data-testid="share-button">
            <Share2 className="size-5" aria-hidden />
            <span className="max-[359px]:sr-only">Share</span>
          </button>
        </nav>
      )}

      {isPaid || pseudo ? null : <MadeWithFooter className="pb-[env(safe-area-inset-bottom)]" />}

      <ContentsSheet
        open={sheet === "contents"}
        onClose={() => setSheet(null)}
        doc={doc}
        currentChapterId={chapter?.id ?? null}
        onJump={(flipIndex) => {
          setSheet(null);
          api.current?.goTo(flipIndex);
        }}
      />
      <ViewerSheet open={sheet === "share"} onClose={() => setSheet(null)} title="Share this book" testId="share-sheet">
        <div className="p-4">
          <ShareButtons url={shareUrl} title={shareTitle} />
        </div>
      </ViewerSheet>
    </div>
  );
}

