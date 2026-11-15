"use client";

// Public viewer chrome around the flipbook (D-040, M23 emerald style D-075): a slim 52 px leather
// band (title, chapter line, Contents / Share / Fullscreen), the cream book stage with a ground-shadow
// pool under the book, a bottom bar with the white prev / counter / next pill, and the free-book
// leather footer; watermark over pages and an end card as the last page. Full-height column (h-dvh)
// that respects safe-area insets; works at 320 / 375 px. Renders from the render doc
// (publicDocToRenderDoc). Chrome heights never change while reading (the stage keeps its size, so
// page-flip never re-measures); nothing translates or scales the stage or the flipbook.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Ellipsis, List, Share2 } from "lucide-react";
import type { RenderPhotos } from "@/components/book/BookPage";
import { Watermark } from "@/components/book/Watermark";
import type { BookDoc } from "@/lib/book/types";
import { cx } from "@/lib/cx";
import { chapterForPage, chapterLabel, labelFontStyle } from "@/lib/viewer/chapters";
import { endCardModel } from "@/lib/viewer/end-card";
import { pageRatio } from "@/lib/viewer/fit";
import { firstVisiblePageIdx, flipLayout } from "@/lib/viewer/pages";
import { poolSide, stagePoolStyle, type StageMetrics } from "@/lib/viewer/stage-pool";
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
import {
  VW_BAND,
  VW_BAND_ROW,
  VW_BAND_RULE,
  VW_BAND_TEXT_BTN,
  VW_FLOAT_BTN,
  VW_NAV_BAR,
  VW_NAV_BTN,
  VW_NAV_PILL,
  VW_STAGE,
  VW_SUBLINE,
  VW_TITLE,
  VW_TITLE_WRAP,
} from "./viewer-classes";

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

/** Stage padding box + padding (for placing the pool under the book). Paint input only. */
function useStageMetrics(el: HTMLElement | null): StageMetrics | null {
  const [m, setM] = useState<StageMetrics | null>(null);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const next: StageMetrics = {
        width: el.clientWidth,
        height: el.clientHeight,
        padTop: parseFloat(cs.paddingTop) || 0,
        padRight: parseFloat(cs.paddingRight) || 0,
        padBottom: parseFloat(cs.paddingBottom) || 0,
        padLeft: parseFloat(cs.paddingLeft) || 0,
      };
      setM((p) =>
        p && (Object.keys(next) as (keyof StageMetrics)[]).every((k) => p[k] === next[k]) ? p : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return m;
}

export function ViewerShell({ doc, photos, captionLang, title, isPaid, shareUrl, shareTitle }: ViewerShellProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const api = useRef<FlipbookApi | null>(null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
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

  // The stage's ground-shadow pool (VW_STAGE layer 1) under the visible book; paint only.
  const metrics = useStageMetrics(stageEl);
  const side = poolSide(spread, visible);
  const ratio = useMemo(() => pageRatio(doc.format), [doc.format]);
  const poolStyle = useMemo(
    () => (metrics ? (stagePoolStyle(metrics, spread, ratio, side) ?? undefined) : undefined),
    [metrics, spread, ratio, side],
  );

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

  // Pseudo-fullscreen: the bars float over the stage (wrapper, so the recipes' own position classes
  // never conflict) and fade in when the reader asks for them.
  const overlay = (edge: "top" | "bottom", node: ReactNode) =>
    pseudo ? <div className={cx("vw-chrome-fade absolute inset-x-0 z-20", edge === "top" ? "top-0" : "bottom-0")}>{node}</div> : node;

  const band = (
    <header className={VW_BAND} data-testid="viewer-top-bar">
      <div className={VW_BAND_ROW}>
        <div className={VW_TITLE_WRAP}>
          <h1 dir="auto" style={labelFontStyle(title)} className={cx(VW_TITLE, "text-left")} data-testid="viewer-title">
            {title}
          </h1>
          {/* Both lines stay left-aligned in the LTR chrome (an Arabic chapter under an English title
              would otherwise drift right); dir="auto" still orders each line's own text. No chapter
              (cover / end): the line hides so the title centres; the band stays 52 px. */}
          <ChapterLabel chapter={chapter} className={cx(VW_SUBLINE, "text-left", chapterLabel(chapter) ? null : "hidden")} />
        </div>
        <button type="button" onClick={() => setSheet("contents")} className={VW_BAND_TEXT_BTN} data-testid="contents-button">
          <List className="size-5" aria-hidden />
          <span className="sr-only sm:not-sr-only">Contents</span>
        </button>
        <button type="button" onClick={() => setSheet("share")} className={VW_BAND_TEXT_BTN} data-testid="share-button">
          <Share2 className="size-5" aria-hidden />
          <span className="sr-only sm:not-sr-only">Share</span>
        </button>
        <FullscreenButton active={fs.mode !== "off"} onToggle={toggleFullscreen} />
      </div>
      <span className={VW_BAND_RULE} aria-hidden />
    </header>
  );

  const navBar = (
    <nav
      aria-label="Book navigation"
      className={cx(VW_NAV_BAR, isPaid || pseudo ? "pb-[max(0.375rem,env(safe-area-inset-bottom))]" : null)}
      data-testid="viewer-bottom-bar"
    >
      <div className={VW_NAV_PILL}>
        <button type="button" onClick={() => api.current?.prev()} disabled={atStart} aria-label="Previous page" className={VW_NAV_BTN} data-testid="prev-page">
          <ChevronLeft className="size-6" aria-hidden />
        </button>
        <PageCounter layout={layout} current={current} spread={spread} />
        <button type="button" onClick={() => api.current?.next()} disabled={atEnd} aria-label="Next page" className={VW_NAV_BTN} data-testid="next-page">
          <ChevronRight className="size-6" aria-hidden />
        </button>
      </div>
    </nav>
  );

  return (
    <div
      ref={rootRef}
      className={`flex h-dvh w-full flex-col overflow-hidden bg-[#ebe2d0] ${pseudo ? "fixed inset-0 z-40" : "relative"}`}
      data-testid="viewer-shell"
      data-paid={String(isPaid)}
      data-fullscreen={fs.mode}
      data-chrome={chromeHidden ? "hidden" : "shown"}
    >
      {chromeHidden ? null : overlay("top", band)}

      <div
        ref={setStageEl}
        className={cx("relative min-h-0 flex-1 p-2 sm:p-4", VW_STAGE)}
        style={poolStyle}
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
            className={cx(VW_FLOAT_BTN, "vw-chrome-fade absolute top-[max(0.5rem,env(safe-area-inset-top))] right-[max(0.5rem,env(safe-area-inset-right))] z-20")}
            data-testid="show-controls"
          >
            <Ellipsis className="size-5" aria-hidden />
          </button>
        ) : null}
      </div>

      {chromeHidden ? null : overlay("bottom", navBar)}

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
