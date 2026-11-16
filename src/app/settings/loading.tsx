// Settings skeleton (M24, D-076): the same emerald band (back row, eyebrow, title, email chip), the
// ≥ lg section nav and the cards column (Account, Email reminders, What the AI has learned, danger
// zone) with the real cards' paddings and heights, so nothing jumps when the page streams in.
// Static, no data reads; pulses stop under reduced motion (Skeleton is motion-reduce:animate-none).
import { Skeleton } from "@/components/app/Skeleton";
import { AppHeaderPlaceholder } from "@/components/layout/AppHeader";
import { SETTINGS_CARD } from "@/components/settings/settings-classes";
import {
  SETTINGS_COLUMNS,
  SETTINGS_CONTAINER,
  SETTINGS_CONTENT,
  SETTINGS_DANGER_ZONE,
  SETTINGS_NAV,
  SETTINGS_WELL,
} from "@/components/settings/settings-page-classes";

function CardHead() {
  return (
    <div className="flex items-center gap-3 sm:gap-4">
      <Skeleton className="size-10 shrink-0 rounded-full bg-[#e6efe9]" />
      <Skeleton className="h-6 w-40 max-w-full" />
    </div>
  );
}

export default function Loading() {
  return (
    <>
      <AppHeaderPlaceholder width="library" />
      <main>
        <div role="status" aria-live="polite" data-testid="page-skeleton">
          <span className="sr-only">Loading settings…</span>
          <div aria-hidden="true" className="home-leather relative">
            <div className={`${SETTINGS_CONTAINER} pt-2 pb-6 sm:pt-4 sm:pb-8 lg:pb-10`}>
              <div className="flex min-h-11 items-center">
                <div className="h-4 w-24 rounded bg-[#f2e8d8]/15" />
              </div>
              <div className="mt-1 h-3 w-24 rounded bg-[#e3c766]/25 sm:mt-2" />
              <div className="mt-2 h-9 w-40 rounded-md bg-[#f2e8d8]/15 sm:mt-3 sm:h-11 sm:w-52 lg:h-[3.3rem] lg:w-60" />
              <div className="mt-3 h-[3.3rem] w-full rounded-2xl bg-[#143f33] sm:mt-4 sm:h-8 sm:w-96 sm:max-w-full" />
            </div>
            <span className="home-foil-h absolute inset-x-0 bottom-0 h-px" />
          </div>
          <div aria-hidden="true" className={`${SETTINGS_CONTAINER} ${SETTINGS_COLUMNS}`}>
            <aside className="hidden lg:block">
              <div className={SETTINGS_NAV}>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex h-11 items-center gap-3 px-3">
                    <Skeleton className="size-4 rounded-full" />
                    <Skeleton className="h-3.5 w-32" />
                  </div>
                ))}
              </div>
            </aside>
            <div className={SETTINGS_CONTENT}>
              <div className={SETTINGS_CARD}>
                <CardHead />
                <div className={`${SETTINGS_WELL} py-3`}>
                  <Skeleton className="h-[4.6rem] w-full bg-[#efe7d8] sm:h-6" />
                </div>
              </div>
              <div className={SETTINGS_CARD}>
                <div className="flex items-center justify-between gap-3">
                  <CardHead />
                  <Skeleton className="h-7 w-20 rounded-full" />
                </div>
                <Skeleton className="h-[3.75rem] w-full sm:h-5" />
              </div>
              <div className={SETTINGS_CARD}>
                <CardHead />
                <div className={`${SETTINGS_WELL} py-3`}>
                  <Skeleton className="h-11 w-full bg-[#efe7d8] sm:h-6" />
                </div>
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-11 w-full rounded-full sm:w-56" />
              </div>
              <div className={SETTINGS_DANGER_ZONE}>
                <Skeleton className="mb-3 h-3 w-24" />
                <div className={SETTINGS_CARD}>
                  <Skeleton className="h-6 w-44" />
                  <Skeleton className="h-24 w-full" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
