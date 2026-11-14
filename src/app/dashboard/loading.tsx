// Books screen skeleton (M18): the same header band, toolbar and collection grid shapes as the page,
// so nothing jumps when the books arrive. Static, no data reads.
import { Skeleton } from "@/components/app/Skeleton";
import { LIBRARY_CONTAINER, LIBRARY_GRID, LIBRARY_STAGE } from "@/components/dashboard/library-classes";
import { AppHeaderPlaceholder } from "@/components/layout/AppHeader";

const CARDS = 10;

export default function Loading() {
  return (
    <>
      <AppHeaderPlaceholder width="library" />
      <main className="pb-16">
        <div role="status" aria-live="polite" data-testid="page-skeleton">
          <span className="sr-only">Loading your books…</span>
          <div aria-hidden="true" className="home-leather relative">
            <div className={`${LIBRARY_CONTAINER} flex items-end justify-between gap-4 py-7 sm:py-9 lg:py-11`}>
              <div className="flex flex-col gap-3">
                <div className="h-3 w-28 rounded bg-[#e3c766]/25" />
                <div className="h-9 w-48 rounded-md bg-[#f2e8d8]/15 sm:h-11 sm:w-60" />
                <div className="h-4 w-40 rounded bg-[#f2e8d8]/10" />
              </div>
              <div className="h-11 w-32 rounded-lg bg-[#c9a227]/35" />
            </div>
            <span className="home-foil-h absolute inset-x-0 bottom-0 h-px" />
          </div>
          <div className={`${LIBRARY_CONTAINER} flex flex-col gap-5 pt-6 sm:gap-7 sm:pt-8`}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <Skeleton className="h-[3.25rem] w-full max-w-[26rem] rounded-2xl" />
              <div className="flex gap-2 sm:gap-3">
                <Skeleton className="h-11 flex-1 rounded-xl lg:w-72 lg:flex-none" />
                <Skeleton className="h-11 w-40 rounded-xl" />
              </div>
            </div>
            <ul className={LIBRARY_GRID}>
              {Array.from({ length: CARDS }, (_, i) => (
                <li key={i} className="overflow-hidden rounded-2xl bg-card shadow-card ring-1 ring-border">
                  <div className={`flex aspect-[4/5] items-center justify-center ${LIBRARY_STAGE}`}>
                    <Skeleton className="-mt-[6%] aspect-[148/210] w-[60%] rounded-s-[2px] rounded-e-[5px] bg-[#e5dccb]" />
                  </div>
                  <div className="flex flex-col gap-2 px-3 pt-3 pb-4 sm:px-4">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </main>
    </>
  );
}
