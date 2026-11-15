// Wizard-shaped loading screen for /books/new (M19; M20 T2: the My books band): plain header, the
// emerald leather band with eyebrow, title bar and the 7-node stepper, then a headline, a card grid
// and the Back / Continue row on cream. Same heights as the real screen, so nothing jumps when it
// arrives. Static, no data reads.
import { Skeleton } from "@/components/app/Skeleton";
import { LIBRARY_CONTAINER } from "@/components/dashboard/library-classes";
import { AppHeaderPlaceholder } from "@/components/layout/AppHeader";

export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <AppHeaderPlaceholder variant="plain" width="library" />
      <main className="flex w-full flex-1 flex-col">
        <div role="status" aria-live="polite" className="flex w-full flex-1 flex-col" data-testid="page-skeleton">
          <span className="sr-only">Loading…</span>
          <div className="home-leather relative overflow-hidden">
            <div className={`${LIBRARY_CONTAINER} pt-5 pb-4 sm:pt-8 sm:pb-7 lg:pt-9 lg:pb-8`}>
              <div className="h-3 w-24 rounded-full bg-white/15" />
              <div className="mt-2.5 h-8 w-56 max-w-full rounded-lg bg-white/10 sm:h-10 sm:w-80 lg:h-12" />
              <div className="mt-3 flex flex-col sm:mt-5 lg:mt-6">
                <div className="order-2 mx-auto mt-2 h-4 w-36 rounded-full bg-white/10 sm:order-none sm:me-0 sm:mt-0 sm:mb-3 sm:h-3 sm:w-24" />
                <div className="flex w-full">
                  {Array.from({ length: 7 }, (_, i) => (
                    <div key={i} className="flex min-h-11 flex-1 flex-col items-center">
                      <div className="flex h-11 items-center">
                        <div className="size-2.5 rounded-full bg-white/20 sm:size-11" />
                      </div>
                      <div className="mt-2 hidden h-3 w-12 rounded-full bg-white/10 sm:block" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className={`${LIBRARY_CONTAINER} flex flex-col items-center pt-6 pb-8 sm:pt-10 sm:pb-12`}>
            <div className="flex w-full max-w-[52rem] flex-col items-center gap-6">
              <Skeleton className="h-9 w-3/4 max-w-sm" />
              <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-3">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-28 rounded-2xl" />
                ))}
              </div>
              <div className="flex w-full max-w-[28rem] items-center gap-3">
                <Skeleton className="h-12 w-20 rounded-full" />
                <Skeleton className="h-12 flex-1 rounded-full" />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
