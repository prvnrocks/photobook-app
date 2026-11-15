// Route-level loading screens (M11 T5, D-067) used by the loading.tsx files of signed-in routes.
// Every route is force-dynamic, so on a phone the server fetch can take a moment: show the header
// and a skeleton straight away instead of the old screen or a blank one. Static, no data reads.

import { PageSkeleton, Skeleton } from "@/components/app/Skeleton";
import {
  ED_BAND,
  ED_BAND_EYEBROW,
  ED_BAND_EYEBROW_RULE,
  ED_BAND_ROW,
  ED_BAND_TITLE_WRAP,
  ED_PAGE_FRAME,
  ED_STAGE_HOST,
  ED_STRIP_SURFACE,
} from "@/components/editor/editor-classes";
import { cx } from "@/lib/cx";
import { cn } from "@/lib/utils";
import { AppHeaderPlaceholder } from "./AppHeader";

export function RouteLoading({
  label = "Loading…",
  cards = 2,
  width = "app",
  header = true,
}: {
  label?: string;
  cards?: number;
  /** max-w-app for flow screens and forms, max-w-wide for the dashboard. */
  width?: "app" | "wide";
  /** Screens without the app header (publish) skip it. */
  header?: boolean;
}) {
  return (
    <>
      {header ? <AppHeaderPlaceholder /> : null}
      <main className={cn("mx-auto w-full px-gutter py-6", width === "wide" ? "max-w-wide" : "max-w-app")}>
        <PageSkeleton label={label} cards={cards} />
      </main>
    </>
  );
}

/**
 * The editor is full screen (M22 T7, D-074): mirror the real editor box for box so nothing moves when
 * it streams in — emerald band (56 px row on phones / 98 px ≥ lg, same ED_BAND / ED_BAND_ROW), the
 * cream stage column with a portrait page + the 48 px counter row, the floating pill toolbar (66 px
 * bar on phones / 54 px from sm) and, ≥ lg, the w-44 cream page strip. Static, no data reads;
 * pulses stop under reduced motion (Skeleton is motion-reduce:animate-none).
 */
export function EditorLoading() {
  return (
    <div role="status" aria-live="polite" className="flex h-dvh flex-col overflow-hidden bg-background" data-testid="page-skeleton">
      <span className="sr-only">Opening the editor…</span>
      <div aria-hidden="true" className={ED_BAND}>
        <div className={ED_BAND_ROW}>
          <span className="flex size-11 shrink-0 items-center justify-center">
            <Skeleton className="size-6 rounded-full bg-white/15" />
          </span>
          <div className={ED_BAND_TITLE_WRAP}>
            <p className={ED_BAND_EYEBROW}>
              <span>Editing</span>
              <span className={ED_BAND_EYEBROW_RULE} />
            </p>
            <div className="flex min-w-0 flex-col items-start gap-1.5 lg:h-[38px] lg:flex-row lg:items-center lg:gap-3">
              <Skeleton className="h-4 w-28 max-w-full bg-white/20 lg:h-7 lg:w-48" />
              <Skeleton className="h-5 w-16 rounded-full bg-white/15 lg:h-8 lg:w-20" />
            </div>
          </div>
          {[0, 1].map((i) => (
            <span key={i} className="flex size-11 shrink-0 items-center justify-center">
              <Skeleton className="size-5 rounded-full bg-white/15" />
            </span>
          ))}
          <Skeleton className="h-11 w-[5.75rem] shrink-0 rounded-full bg-[#e3c766]/35 lg:ms-2 lg:h-12 lg:w-36" />
        </div>
        <span className="home-foil-h absolute inset-x-0 bottom-0 h-px" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div aria-hidden="true" className={cx("hidden w-44 shrink-0 lg:flex lg:flex-col lg:gap-4 lg:p-3", ED_STRIP_SURFACE)}>
          <Skeleton className="mx-auto aspect-[148/210] w-1/2 rounded-xl bg-white" />
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-[296/210] w-full rounded-xl bg-white" />
          ))}
        </div>
        <div aria-hidden="true" className={cx("flex min-h-0 min-w-0 flex-1 flex-col", ED_STAGE_HOST)}>
          {/* Same padding as the carousel slide (phones) / spread placeholder (md+). */}
          <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-3 md:px-6 md:py-4">
            <div className="flex aspect-[148/210] h-full max-w-full items-center">
              <div className={cx(ED_PAGE_FRAME, "aspect-[148/210] w-full")}>
                <Skeleton className="size-full rounded-none bg-[#fbf8f2]" />
              </div>
            </div>
          </div>
          <div className="flex h-12 shrink-0 items-center justify-center px-1">
            <Skeleton className="h-11 w-52 rounded-full bg-white ring-1 ring-[#e5dccb]" />
          </div>
          <div className="shrink-0 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] ps-[max(0.5rem,env(safe-area-inset-left))] pe-[max(0.5rem,env(safe-area-inset-right))]">
            <Skeleton className="mx-auto h-[66px] w-full max-w-md rounded-[1.75rem] border border-[#e9dfca] bg-white sm:h-[54px] sm:w-[22rem] sm:rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
