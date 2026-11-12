"use client";
// What happened after an upload run (+ finalize counts when available). Presentational, plus
// the D-020 iOS location hint (device check runs client-side only, after hydration).
// M11 T10 (D-067): result card + a sticky next-step bar.
// M13 T6 (D-070): the first AI build starts by itself, so the bar shows "Starting your book…" while
// that happens; "Make my book now" (testid build-album) is only the fallback (fewer than 5 photos,
// a limit or an error); a book that already had a build continues to it instead.
import { Plus } from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { ActionBar } from "@/components/app/ActionBar";
import { LoadingState } from "@/components/app/LoadingState";
import { Notice } from "@/components/app/Notice";
import { Button, buttonVariants } from "@/components/ui/button";
import type { FinalizeResult } from "@/lib/upload/finalize-client";
import type { QueueSummary } from "@/lib/upload/queue";
import { plural, skippedLines } from "@/lib/upload/summary-text";
import { isIosDevice } from "@/lib/device";
import { cn } from "@/lib/utils";

/** What the next-step bar offers. */
export type SummaryNext =
  /** The automatic first build is being asked for / the screen is moving on. */
  | { kind: "starting" }
  /** Fallback: "Make my book now" → the build screen (with an optional explanation). */
  | { kind: "build"; note?: string }
  /** The book already had a build: continue there. */
  | { kind: "continue"; href: string; label: string };

type UploadSummaryProps = {
  bookId: string;
  summary: QueueSummary;
  finalize: FinalizeResult | null;
  onAddMore: () => void;
  next: SummaryNext;
};

const noSubscribe = () => () => undefined;
const readIsIos = () =>
  isIosDevice(navigator.userAgent, navigator.platform ?? "", navigator.maxTouchPoints ?? 0);
const serverIsIos = () => false;

export function UploadSummary({ bookId, summary, finalize, onAddMore, next }: UploadSummaryProps) {
  const isIos = useSyncExternalStore(noSubscribe, readIsIos, serverIsIos);
  const showGpsHint = isIos && finalize !== null && finalize.photos > 0 && finalize.withGps === 0;
  const skipped = skippedLines(summary.skippedBy);
  const notStarted = summary.fatal ? 0 : summary.notStarted;

  return (
    <div className="flex min-w-0 flex-col gap-stack">
      <section
        className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card p-4 shadow-card sm:p-6"
        data-testid="upload-summary"
        aria-labelledby="upload-summary-heading"
      >
        <h2 id="upload-summary-heading" className="type-h2" data-testid="summary-added">
          {summary.uploaded > 0 ? `${plural(summary.uploaded, "photo")} added` : "No new photos added"}
        </h2>

        {finalize && finalize.photos > 0 ? (
          <ul className="flex list-disc flex-col gap-1.5 ps-5 text-base marker:text-accent-strong">
            <li data-testid="summary-dates">
              {finalize.withDate} of {finalize.photos} with a date from the camera
            </li>
            {finalize.withGps > 0 ? (
              <li data-testid="summary-places">
                Places found for {finalize.withPlace} of {finalize.withGps} with a location
              </li>
            ) : null}
            {finalize.dupPhotos > 0 ? (
              <li data-testid="summary-dupes">
                {plural(finalize.dupPhotos, "possible duplicate")} — you can check them next
              </li>
            ) : null}
            {finalize.pages > 0 ? (
              <li data-testid="summary-pages">
                {plural(finalize.pages, "page")} in your draft book
              </li>
            ) : null}
          </ul>
        ) : null}

        {showGpsHint ? (
          <Notice tone="info" data-testid="gps-hint">
            Want place names? In the photo picker, tap Options and turn on Location.
          </Notice>
        ) : null}

        {skipped.length > 0 ? (
          <div className="text-base" data-testid="summary-skipped">
            <p className="font-medium">
              {plural(summary.skipped, "photo")} skipped:
            </p>
            <ul className="mt-1 list-disc ps-5 text-muted-foreground">
              {skipped.map((s) => (
                <li key={s.key} data-testid={`summary-skipped-${s.key}`}>
                  {s.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {summary.failed > 0 ? (
          <p className="text-base text-destructive" data-testid="summary-failed">
            {plural(summary.failed, "photo")} couldn&apos;t be uploaded. To try again, choose your
            photos again — we&apos;ll skip the ones already added.
          </p>
        ) : null}

        {notStarted > 0 ? (
          <p className="text-base text-muted-foreground" data-testid="summary-not-started">
            {notStarted === 1
              ? "1 photo wasn't started. Choose it again to add it."
              : `${notStarted} photos weren't started. Choose them again to add them.`}
          </p>
        ) : null}

      </section>

      {next.kind === "build" && next.note ? (
        <Notice tone="info" data-testid="upload-auto-fallback">
          {next.note}
        </Notice>
      ) : null}

      <ActionBar label="Next step">
        {next.kind === "starting" ? (
          <LoadingState
            label="Starting your book…"
            description="AI is picking your best photos and writing captions."
            data-testid="upload-auto-starting"
          />
        ) : next.kind === "build" ? (
          <Link
            href={`/books/${bookId}/build`}
            className={cn(buttonVariants({ variant: "accent", size: "cta" }))}
            data-testid="build-album"
          >
            Make my book now
          </Link>
        ) : (
          <Link
            href={next.href}
            className={cn(buttonVariants({ variant: "accent", size: "cta" }))}
            data-testid="upload-continue"
          >
            {next.label}
          </Link>
        )}
        {next.kind !== "starting" ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={onAddMore}
            className="w-full text-base sm:h-12"
            data-testid="upload-add-more"
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            Add more photos
          </Button>
        ) : null}
      </ActionBar>
    </div>
  );
}
