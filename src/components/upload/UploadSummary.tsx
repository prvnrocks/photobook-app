"use client";
// What happened after an upload run (+ finalize counts when available). Presentational, plus
// the D-020 iOS location hint (device check runs client-side only, after hydration).
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import type { FinalizeResult } from "@/lib/upload/finalize-client";
import type { QueueSummary } from "@/lib/upload/queue";
import { plural, skippedLines } from "@/lib/upload/summary-text";
import { isIosDevice } from "@/lib/device";
import { cn } from "@/lib/utils";

type UploadSummaryProps = {
  bookId: string;
  summary: QueueSummary;
  finalize: FinalizeResult | null;
  onAddMore: () => void;
};

const noSubscribe = () => () => undefined;
const readIsIos = () =>
  isIosDevice(navigator.userAgent, navigator.platform ?? "", navigator.maxTouchPoints ?? 0);
const serverIsIos = () => false;

export function UploadSummary({ bookId, summary, finalize, onAddMore }: UploadSummaryProps) {
  const isIos = useSyncExternalStore(noSubscribe, readIsIos, serverIsIos);
  const showGpsHint = isIos && finalize !== null && finalize.photos > 0 && finalize.withGps === 0;
  const skipped = skippedLines(summary.skippedBy);
  const notStarted = summary.fatal ? 0 : summary.notStarted;

  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4"
      data-testid="upload-summary"
      aria-labelledby="upload-summary-heading"
    >
      <h2 id="upload-summary-heading" className="text-lg font-semibold" data-testid="summary-added">
        {summary.uploaded > 0 ? `${plural(summary.uploaded, "photo")} added` : "No new photos added"}
      </h2>

      {finalize && finalize.photos > 0 ? (
        <ul className="flex flex-col gap-1.5 text-base">
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
              {plural(finalize.pages, "page")} in your draft album
            </li>
          ) : null}
        </ul>
      ) : null}

      {showGpsHint ? (
        <p className="text-sm text-muted-foreground" data-testid="gps-hint">
          Want place names? In the photo picker, tap Options and turn on Location.
        </p>
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

      <div className="flex flex-col gap-2">
        <Link
          href={`/books/${bookId}/build`}
          className={cn(buttonVariants(), "h-11 w-full px-4 text-base")}
          data-testid="build-album"
        >
          Build my album
        </Link>
        <Button
          type="button"
          variant="outline"
          onClick={onAddMore}
          className="h-11 w-full text-base"
          data-testid="upload-add-more"
        >
          Add more photos
        </Button>
      </div>
    </section>
  );
}
