// The user's own photos on the storybook screen (wizard step 6, Task 8 follow-up): a calm grid of
// their uploaded 512 px thumbs (short-lived signed URLs from the step-6 data) while the first draft
// is made, so the wait shows their memories instead of an empty screen.
// Presentational, no hooks. 375 px first: two rows of five (two rows of six from `sm`), square
// tiles inside the column, never wider than it (no horizontal scroll). The tiles fade in once,
// one after another (opacity only, off under prefers-reduced-motion) and then stay still: no
// timer-driven motion, nothing that suggests a percentage. The grid is decorative (aria-hidden);
// the visible line "Your 40 photos" is the summary screen readers get. Nothing is highlighted:
// the run's progress reports counts only, not which photos were picked.

import { cn } from "@/lib/utils";

/** Tiles shown at 375 px (two rows of five); the rest (up to the data's 12) from `sm`. */
export const STRIP_TILES_PHONE = 10;

export function storyPhotosSummary(total: number): string {
  return total === 1 ? "Your photo" : `Your ${total} photos`;
}

export function StoryPhotoStrip({ urls, total }: { urls: readonly string[]; total: number }) {
  if (urls.length === 0) return null;
  const count = Math.max(total, urls.length);
  return (
    <figure className="flex w-full min-w-0 flex-col gap-2" data-testid="story-photos" data-count={urls.length}>
      <div aria-hidden="true" className="grid w-full min-w-0 grid-cols-5 gap-1.5 sm:grid-cols-6 sm:gap-2">
        {urls.map((url, i) => (
          <div
            key={url}
            className={cn(
              "aspect-square min-w-0 overflow-hidden rounded-md bg-muted shadow-card ring-1 ring-foreground/10",
              "motion-safe:animate-in motion-safe:fade-in motion-safe:fill-mode-both motion-safe:duration-500",
              i >= STRIP_TILES_PHONE && "hidden sm:block",
            )}
            style={{ animationDelay: `${i * 60}ms` }}
            data-testid="story-photo"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed thumb URL */}
            <img src={url} alt="" decoding="async" draggable={false} className="size-full select-none object-cover" />
          </div>
        ))}
      </div>
      <figcaption className="type-small text-center text-muted-foreground lg:text-start" data-testid="story-photos-summary">
        {storyPhotosSummary(count)}
      </figcaption>
    </figure>
  );
}
