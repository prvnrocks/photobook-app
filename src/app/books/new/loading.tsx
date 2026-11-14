// Wizard-shaped loading screen for /books/new (M19): plain header, step label + six-segment bar,
// headline, a card grid and the Back / Continue row. Static, no data reads.
import { Skeleton } from "@/components/app/Skeleton";
import { AppHeaderPlaceholder } from "@/components/layout/AppHeader";

export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <AppHeaderPlaceholder variant="plain" />
      <main className="flex w-full flex-1 flex-col items-center px-gutter pt-2 pb-10 sm:pt-4">
        <div role="status" aria-live="polite" className="flex w-full flex-col items-center" data-testid="page-skeleton">
          <span className="sr-only">Loading…</span>
          <div className="flex w-full flex-col items-center gap-2.5">
            <Skeleton className="h-4 w-20" />
            <div className="flex w-full max-w-64 gap-1.5">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-1.5 flex-1 rounded-full" />
              ))}
            </div>
          </div>
          <div className="mt-8 flex w-full max-w-[40rem] flex-col items-center gap-6 sm:mt-10">
            <Skeleton className="h-9 w-3/4 max-w-sm" />
            <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-28 rounded-2xl" />
              ))}
            </div>
            <div className="flex w-full max-w-[28rem] items-center gap-3">
              <Skeleton className="h-11 w-16 rounded-full" />
              <Skeleton className="h-12 flex-1 rounded-full" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
