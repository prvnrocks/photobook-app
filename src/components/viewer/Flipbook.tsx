"use client";

// Flipbook viewer: react-pageflip (page-flip engine) around the shared <BookPage> renderer.
// Client-only — load it through <FlipbookLoader> (next/dynamic, ssr:false): page-flip touches
// window/DOM on import. Flip index 0 = cover, i >= 1 = doc.pages[i - 1].
//
// Engine quirks handled here (see FlipPage.tsx for the StrictMode ref one):
// - react-pageflip never destroys its PageFlip: when a book instance unmounts (spread change,
//   route change) we strip its listeners, stop its per-frame drawing and drop the engine's
//   references to pages/elements so the detached DOM can be GC'd (retirePageFlip).
// - page-flip only re-measures on window "resize"; the stage is measured with ResizeObserver
//   and we call update() after our own size change.
// - Orientation is decided by us (viewport >= 768 px = spread), not by page-flip's minWidth
//   heuristic; switching remounts the book at the same page.
// - Children are static (keyed by page count) and read doc/photos/current page from context:
//   react-pageflip moves page nodes into its own wrapper, so React must never insert/remove them.
// - Viewer extras (optional): `endPage` is appended as the last flip page (back cover, shown alone:
//   see src/lib/viewer/pages.ts for the even-count filler) and `pageOverlay` (watermark) is drawn
//   over the cover and every book page.

import HTMLFlipBook from "react-pageflip";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { BookPage, type RenderPhotos } from "@/components/book/BookPage";
import type { BookDoc } from "@/lib/book/types";
import { fitBook, PAGE_RATIO_H, PAGE_RATIO_W, SPREAD_MEDIA_QUERY } from "@/lib/viewer/fit";
import { flipLayout, flipPageKind, startIndexFor, type FlipLayout } from "@/lib/viewer/pages";
import { inPhotoWindow, photoWindow, spreadStart, type PhotoWindow } from "@/lib/viewer/window";
import { FlipPage } from "./FlipPage";

export interface FlipbookApi {
  next(): void;
  prev(): void;
  /** Animated flip to a flip index (0 = cover). */
  goTo(index: number): void;
}

export interface FlipbookReadyInfo {
  pageCount: number;
  spread: boolean;
  /** Flip-index layout of this instance (cover, pages, filler, end card). */
  layout: FlipLayout;
}

export type FlipbookProps = {
  doc: BookDoc;
  /** photoId → signed web URL + size. Only pages near the current one get these (windowing). */
  photos: RenderPhotos;
  captionLang?: string;
  /** Flip index to show (0 = cover). Changing it flips there; omit for uncontrolled use. */
  currentPage?: number;
  /** Fired after every page turn (swipe, keys, goTo) with page-flip's current index (left page of a spread). */
  onFlip?: (index: number) => void;
  /** Fired when a book instance is ready (first load and after a phone/spread switch). */
  onReady?: (info: FlipbookReadyInfo) => void;
  /** Imperative controls for viewer chrome (prev/next buttons, contents sheet). */
  apiRef?: Ref<FlipbookApi | null>;
  /** Appended as the last page (back cover, shown alone). Must not need hooks/state from the parent. */
  endPage?: ReactNode;
  /** Drawn over the cover and every book page (e.g. the free-book watermark). */
  pageOverlay?: ReactNode;
  className?: string;
};

/** The part of page-flip's PageFlip instance we use (the package ships no types). */
interface PageFlipInstance {
  flipNext(corner?: "top" | "bottom"): void;
  flipPrev(corner?: "top" | "bottom"): void;
  flip(page: number, corner?: "top" | "bottom"): void;
  turnToPage(page: number): void;
  getCurrentPageIndex(): number;
  getPageCount(): number;
  update(): void;
  getUI(): unknown;
  getRender(): unknown;
  off(event: string): void;
}

interface FlipEvent {
  data: unknown;
}

const EMPTY_PHOTOS: RenderPhotos = Object.freeze({});

type PagesCtx = {
  doc: BookDoc;
  photos: RenderPhotos;
  captionLang?: string;
  win: PhotoWindow;
  layout: FlipLayout;
  endPage: ReactNode;
  pageOverlay: ReactNode;
};
const PagesContext = createContext<PagesCtx | null>(null);

const PageBody = memo(function PageBody({
  doc,
  index,
  photos,
  captionLang,
  priority,
}: {
  doc: BookDoc;
  index: number;
  photos: RenderPhotos;
  captionLang?: string;
  priority: boolean;
}) {
  return (
    <BookPage
      doc={doc}
      page={index === 0 ? "cover" : index - 1}
      mode="view"
      photos={photos}
      captionLang={captionLang}
      priority={priority}
    />
  );
});

function WindowedPage({ index }: { index: number }) {
  const ctx = useContext(PagesContext);
  if (!ctx) return null;
  const kind = flipPageKind(ctx.layout, index).kind;
  if (kind === "end") return <>{ctx.endPage}</>;
  if (kind === "filler") {
    return <div className="aspect-[148/210] w-full" style={{ background: ctx.doc.style.background }} data-filler="true" />;
  }
  const inWin = inPhotoWindow(ctx.win, index);
  return (
    <>
      <PageBody
        doc={ctx.doc}
        index={index}
        photos={inWin ? ctx.photos : EMPTY_PHOTOS}
        captionLang={ctx.captionLang}
        priority={ctx.win.priority.includes(index)}
      />
      {ctx.pageOverlay}
    </>
  );
}

const noop = () => {};

/** Null every own field of an engine object, except `keep` (best effort, never throws). */
function dropFields(obj: unknown, keep: readonly string[] = []) {
  if (!obj || typeof obj !== "object") return;
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (keep.includes(k)) continue;
    try {
      const v = rec[k];
      if (Array.isArray(v)) v.length = 0;
      else if (v instanceof Map || v instanceof Set) v.clear();
      rec[k] = null;
    } catch {
      // read-only / frozen field: skip
    }
  }
}

/**
 * Retire a PageFlip instance react-pageflip leaves running (it has no destroy). page-flip 2.0.7
 * internals (node_modules/page-flip/src): Render.start() runs `requestAnimationFrame(loop)`
 * forever and the loop closure holds the Render, which holds the app (PageFlip) → UI (block,
 * wrapper, distElement), PageCollection (Page objects → page elements → <img>s) and its own
 * element / items / shadow divs. The loop can't be stopped, so we:
 *   1. remove event callbacks + window/element listeners (UI.removeHandlers);
 *   2. make every frame a no-op (own `drawFrame`, `animation = null`);
 *   3. drop every reference the engine objects hold — PageCollection pages/spreads, Render page
 *      refs + elements, UI elements + touch state (pending swipe timer sees touchPoint null),
 *      Flip controller, PageFlip fields — so the rAF loop retains only an empty Render shell and
 *      the detached DOM + images can be garbage-collected;
 *   4. replace the public methods with inert own methods: a parent effect from the same commit
 *      may still call update()/flip() on this instance before it learns it is gone.
 */
function retirePageFlip(pf: PageFlipInstance) {
  let index = 0;
  let count = 0;
  try {
    index = pf.getCurrentPageIndex();
    count = pf.getPageCount();
  } catch {
    // keep zeros
  }
  try {
    for (const ev of ["flip", "changeOrientation", "changeState", "init", "update"]) pf.off(ev);
    const ui = pf.getUI() as { removeHandlers?: () => void } | null;
    ui?.removeHandlers?.();
    const render = pf.getRender() as { drawFrame?: () => void; animation?: unknown } | null;
    if (render) {
      render.drawFrame = noop;
      render.animation = null;
    }
    const engine = pf as unknown as {
      getPageCollection?: () => unknown;
      getFlipController?: () => unknown;
    };
    const pages = engine.getPageCollection?.();
    const flip = engine.getFlipController?.();
    dropFields(pages);
    dropFields(flip);
    dropFields(ui);
    // Render.render() reads `animation` and writes `timer` every frame, then calls drawFrame.
    dropFields(render, ["animation", "timer", "drawFrame"]);
    dropFields(pf);
  } catch {
    // Engine internals changed: leaking memory is better than crashing an unmount.
  }
  try {
    const inert: Partial<PageFlipInstance> & Record<string, unknown> = {
      flipNext: noop,
      flipPrev: noop,
      flip: noop,
      turnToPage: noop,
      update: noop,
      off: noop,
      on: noop,
      clear: noop,
      getCurrentPageIndex: () => index,
      getPageCount: () => count,
      getUI: () => null,
      getRender: () => null,
      getPageCollection: () => null,
      getFlipController: () => null,
    };
    Object.assign(pf, inert);
  } catch {
    // ignore
  }
}

function useSpread(): boolean | null {
  const [spread, setSpread] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(SPREAD_MEDIA_QUERY);
    const sync = () => setSpread(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return spread;
}

function useElementSize(el: HTMLElement | null): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s && s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // iOS Safari can report the old size until the rotation settles.
    window.addEventListener("orientationchange", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", measure);
    };
  }, [el]);
  return size;
}

type HTMLFlipBookProps = ComponentProps<typeof HTMLFlipBook>;

type BookInstanceProps = {
  pageCount: number;
  spread: boolean;
  startPage: number;
  onInstance: (pf: PageFlipInstance | null) => void;
  onFlipIndex: (index: number) => void;
};

/** One react-pageflip book. Remounted (keyed) when the page count or spread mode changes. */
function BookInstance({ pageCount, spread, startPage, onInstance, onFlipIndex }: BookInstanceProps) {
  const bookRef = useRef<{ pageFlip(): PageFlipInstance | undefined } | null>(null);
  const instRef = useRef<PageFlipInstance | null>(null);
  const cbRef = useRef({ onInstance, onFlipIndex });
  useLayoutEffect(() => {
    cbRef.current = { onInstance, onFlipIndex };
  });

  // Settings are fixed for the life of this instance (react-pageflip reads them once).
  const [settings] = useState(() => ({
    startPage,
    size: "stretch" as const,
    width: PAGE_RATIO_W,
    height: PAGE_RATIO_H,
    // Phones: usePortrait + a huge minWidth forces single-page mode. Spread: usePortrait false.
    // page-flip copies minWidth/minHeight into inline styles; overridden by !min-w-0 below.
    minWidth: spread ? 1 : 4000,
    maxWidth: 8000,
    minHeight: 1,
    maxHeight: 8000,
    drawShadow: true,
    flippingTime: 600,
    usePortrait: !spread,
    startZIndex: 0,
    autoSize: true,
    maxShadowOpacity: 0.4,
    showCover: true,
    mobileScrollSupport: false,
    clickEventForward: true,
    useMouseEvents: true,
    swipeDistance: 30,
    showPageCorners: spread,
    disableFlipByClick: false,
  }));

  // Static children: content comes from PagesContext so these elements never change.
  const children = useMemo(
    () =>
      Array.from({ length: pageCount }, (_, i) => (
        <FlipPage key={i} index={i} density={i === 0 ? "hard" : undefined}>
          <WindowedPage index={i} />
        </FlipPage>
      )),
    [pageCount],
  );

  const handlers = useMemo<Pick<HTMLFlipBookProps, "onInit" | "onFlip">>(
    () => ({
      onInit: () => {
        const pf = bookRef.current?.pageFlip() ?? null;
        instRef.current = pf;
        cbRef.current.onInstance(pf);
      },
      onFlip: (e: FlipEvent) => {
        if (typeof e.data === "number") cbRef.current.onFlipIndex(e.data);
      },
    }),
    [],
  );

  useEffect(() => {
    return () => {
      // Runs on real unmount (StrictMode's simulated unmount happens before init, so inst is null).
      const pf = instRef.current;
      instRef.current = null;
      if (pf) {
        retirePageFlip(pf);
        cbRef.current.onInstance(null);
      }
    };
  }, []);

  return (
    <HTMLFlipBook
      ref={bookRef}
      {...settings}
      {...handlers}
      renderOnlyPageLengthChange
      className="!min-h-0 !min-w-0"
      style={{}}
    >
      {children}
    </HTMLFlipBook>
  );
}

export function Flipbook({
  doc,
  photos,
  captionLang,
  currentPage,
  onFlip,
  onReady,
  apiRef,
  endPage,
  pageOverlay,
  className,
}: FlipbookProps) {
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const avail = useElementSize(stageEl);
  const spread = useSpread();
  const hasEnd = endPage !== undefined && endPage !== null;
  const layout = useMemo(
    () => flipLayout(doc.pages.length, { endCard: hasEnd, spread: spread ?? false }),
    [doc.pages.length, hasEnd, spread],
  );
  const pageCount = layout.count;
  const box = useMemo(() => (avail && spread !== null ? fitBook(avail, spread) : null), [avail, spread]);

  const clamp = useCallback((i: number) => Math.min(Math.max(Math.trunc(i) || 0, 0), pageCount - 1), [pageCount]);
  const [current, setCurrent] = useState(() => clamp(currentPage ?? 0));
  const [instance, setInstance] = useState<PageFlipInstance | null>(null);
  const currentRef = useRef(current);

  const cbRef = useRef({ onFlip, onReady });
  useLayoutEffect(() => {
    cbRef.current = { onFlip, onReady };
  });

  const onInstance = useCallback(
    (pf: PageFlipInstance | null) => {
      setInstance(pf);
      if (!pf || spread === null) return;
      cbRef.current.onReady?.({ pageCount: pf.getPageCount(), spread, layout });
      // A remount (spread switch) may start elsewhere (e.g. end card index moved): resync.
      const shown = pf.getCurrentPageIndex();
      if (shown !== currentRef.current) {
        currentRef.current = shown;
        setCurrent(shown);
        cbRef.current.onFlip?.(shown);
      }
    },
    [spread, layout],
  );
  const onFlipIndex = useCallback((i: number) => {
    currentRef.current = i;
    setCurrent(i);
    cbRef.current.onFlip?.(i);
  }, []);

  // Our stage size changed (not necessarily a window resize): let page-flip re-measure.
  useLayoutEffect(() => {
    if (instance && box) instance.update();
  }, [instance, box]);

  // Controlled page: flip when the parent asks for a page outside the visible spread.
  useEffect(() => {
    if (!instance || currentPage === undefined || spread === null) return;
    const target = clamp(currentPage);
    const shown = instance.getCurrentPageIndex();
    if (spreadStart(target, pageCount, spread) === spreadStart(shown, pageCount, spread)) return;
    instance.flip(target);
  }, [instance, currentPage, clamp, pageCount, spread]);

  useImperativeHandle(
    apiRef,
    () => ({
      next: () => instance?.flipNext(),
      prev: () => instance?.flipPrev(),
      goTo: (i: number) => instance?.flip(clamp(i)),
    }),
    [instance, clamp],
  );

  // Keyboard: arrows flip (LTR page order for all books in v1, D-040).
  useEffect(() => {
    if (!instance) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        instance.flipNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        instance.flipPrev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [instance]);

  const win = useMemo(
    () => photoWindow({ current, count: pageCount, spread: spread ?? false }),
    [current, pageCount, spread],
  );
  const ctx = useMemo<PagesCtx>(
    () => ({ doc, photos, captionLang, win, layout, endPage, pageOverlay }),
    [doc, photos, captionLang, win, layout, endPage, pageOverlay],
  );

  return (
    <div
      ref={setStageEl}
      className={`relative flex h-full w-full items-center justify-center overflow-hidden ${className ?? ""}`}
      data-testid="flipbook"
      data-spread={spread === null ? undefined : String(spread)}
      data-current-page={current}
      data-ready={instance ? "true" : "false"}
    >
      {box && spread !== null ? (
        <div style={{ width: box.width, height: box.height }} className="relative shrink-0">
          <PagesContext.Provider value={ctx}>
            <BookInstance
              key={`${pageCount}:${spread ? "spread" : "single"}`}
              pageCount={pageCount}
              spread={spread}
              startPage={startIndexFor(layout, current)}
              onInstance={onInstance}
              onFlipIndex={onFlipIndex}
            />
          </PagesContext.Provider>
        </div>
      ) : null}
    </div>
  );
}
