// Share page loading screen (M21 T5): the real page's shape so nothing jumps when it arrives —
// plain header, the emerald ShareBand (back link, eyebrow, title + chip, the 3-step progress) with
// the same container, paddings and line heights as ShareBand, then the body: the compact preview
// row on phones / the preview tile in the aside from lg, and card placeholders. Static, no data reads.
import { Skeleton } from "@/components/app/Skeleton";
import { LIBRARY_CONTAINER, LIBRARY_STAGE } from "@/components/dashboard/library-classes";
import { AppHeaderPlaceholder } from "@/components/layout/AppHeader";
import { SHARE_COLUMNS } from "@/components/publish/share-classes";
import { SHARE_BODY } from "@/components/publish/share-page-classes";

const BAR = "rounded-full bg-white/10";
const CARD = "rounded-[1.75rem] border border-[#e9dfca] bg-card p-4 sm:p-7";

export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <AppHeaderPlaceholder variant="plain" width="library" />
      <main className="flex w-full flex-1 flex-col">
        <div role="status" aria-live="polite" className="flex w-full flex-1 flex-col" data-testid="page-skeleton">
          <span className="sr-only">Loading sharing options…</span>
          <div className="home-leather relative overflow-hidden" data-testid="share-band-skeleton">
            <div className={`${LIBRARY_CONTAINER} pt-2 pb-4 sm:pt-4 sm:pb-7 lg:pb-8`}>
              <div className="flex min-h-11 items-center">
                <div className={`h-4 w-28 ${BAR}`} />
              </div>
              <div className="mt-1 flex h-[1.05rem] items-center sm:mt-2 sm:h-4">
                <div className="h-2.5 w-16 rounded-full bg-[#e3c766]/30" />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 sm:mt-2 sm:gap-x-4">
                <div className="flex h-[1.92rem] items-center sm:h-[2.64rem] lg:h-[3.12rem]">
                  <div className="h-[75%] w-40 max-w-full rounded-lg bg-white/10 sm:w-80" />
                </div>
                <div className={`h-8 w-24 ${BAR}`} />
              </div>
              <div className="mt-3 flex items-center gap-1.5 sm:mt-5 sm:gap-2.5">
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} className="flex items-center gap-1.5 sm:gap-2.5">
                    {i > 0 ? <div className="h-px w-4 bg-white/20 sm:w-8" /> : null}
                    <div className="size-6 rounded-full bg-white/20 sm:size-7" />
                    <div className={`h-3 w-12 ${BAR}`} />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className={`${SHARE_BODY} pt-4 pb-10 sm:pt-8 lg:pt-10 lg:pb-16`}>
            <div className={SHARE_COLUMNS}>
              <div className="mb-4 sm:mb-stack lg:mb-0">
                <div className="flex items-center gap-4 lg:hidden">
                  <div className={`${LIBRARY_STAGE} h-[5.25rem] w-20 shrink-0 rounded-2xl border border-[#e9dfca]`} />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-5 w-2/3" />
                    <Skeleton className="h-3.5 w-1/3" />
                  </div>
                </div>
                <div className={`${LIBRARY_STAGE} hidden aspect-[4/5] rounded-[1.75rem] border border-[#e9dfca] lg:block`} />
              </div>
              <div className="flex flex-col gap-4 sm:gap-stack">
                <div className={CARD}>
                  <Skeleton className="h-6 w-1/2" />
                  <Skeleton className="mt-3 h-4 w-5/6" />
                  <Skeleton className="mt-5 h-12 w-full rounded-full sm:w-40" />
                </div>
                <div className={CARD}>
                  <Skeleton className="h-5 w-1/3" />
                  <Skeleton className="mt-3 h-4 w-2/3" />
                  <Skeleton className="mt-5 h-28 w-full rounded-2xl" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
