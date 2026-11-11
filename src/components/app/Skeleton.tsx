// Loading placeholders (M11, D-067). <Skeleton> is decorative (aria-hidden); <PageSkeleton> is a
// whole-screen placeholder for route loading.tsx files and announces "Loading…" once (polite).

import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" data-slot="skeleton" className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)} />;
}

export function PageSkeleton({ label = "Loading…", cards = 2, className }: { label?: string; cards?: number; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("flex flex-col gap-stack", className)} data-testid="page-skeleton">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-full max-w-sm" />
      </div>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="flex gap-4 rounded-2xl border border-border bg-card p-4 shadow-card">
          <Skeleton className="aspect-[3/4] w-16 shrink-0 rounded-sm" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="mt-auto h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
