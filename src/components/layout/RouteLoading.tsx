// Route-level loading screens (M11 T5, D-067) used by the loading.tsx files of signed-in routes.
// Every route is force-dynamic, so on a phone the server fetch can take a moment: show the header
// and a skeleton straight away instead of the old screen or a blank one. Static, no data reads.

import { PageSkeleton, Skeleton } from "@/components/app/Skeleton";
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

/** The editor is full screen (own top bar + page + toolbar): mirror that shape. */
export function EditorLoading() {
  return (
    <div role="status" aria-live="polite" className="flex min-h-dvh flex-col" data-testid="page-skeleton">
      <span className="sr-only">Opening the editor…</span>
      <div className="flex h-14 items-center gap-3 border-b border-border px-gutter">
        <Skeleton className="size-9 rounded-lg" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="ms-auto h-9 w-16 rounded-lg" />
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <Skeleton className="aspect-[148/210] w-full max-w-xs rounded-sm shadow-card" />
      </div>
      <div className="flex justify-center gap-3 border-t border-border px-gutter py-3">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="size-11 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
