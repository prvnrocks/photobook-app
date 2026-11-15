"use client";
// Progress card shown while the upload queue runs. Presentational only. The "Keep this screen open"
// notice lives in <Uploader> (shown while uploading and finalizing).
// M19 T6 (D-071) / M20 T5 (D-072): variant "wizard" = <UploadStage> — photos fly onto an open book,
// SVG ring "12 of 20" + %, Pause/Resume, success burst. Same testids as the classic card.
import type { ReactNode } from "react";
import type { QueueProgress } from "@/lib/upload/queue";
import { Button } from "@/components/ui/button";
import { useThrottledValue } from "./use-throttled-value";
import { UploadStage } from "./UploadStage";

/** Screen readers hear "Uploading N of M" at most this often (pause/resume immediately). */
const ANNOUNCE_EVERY_MS = 2000;

type UploadProgressProps = {
  progress: QueueProgress;
  paused: boolean;
  onTogglePause: () => void;
  variant?: "default" | "wizard";
  /** Wizard only: the recent-thumbnails strip (<UploadThumbs>, placed on the stage's book). */
  thumbs?: ReactNode;
  /** Wizard only (M20 T5): force the success state, e.g. while finalizing. Default: done ≥ total. */
  settled?: boolean;
  /** Wizard only (M20 T5): fires once per settle, after the success burst. */
  onSettled?: () => void;
};

/** The headline text (exported for tests). */
export function uploadProgressText(progress: QueueProgress, paused: boolean, variant: "default" | "wizard"): string {
  const { done, total, uploaded } = progress;
  if (variant === "wizard") return paused ? `Paused · ${uploaded} of ${total} uploaded` : `${uploaded} of ${total} uploaded`;
  const current = Math.min(done + 1, total);
  return paused ? `Paused · ${done} of ${total} done` : `Uploading ${current} of ${total}`;
}

export function UploadProgress({ progress, paused, onTogglePause, variant = "default", thumbs, settled, onSettled }: UploadProgressProps) {
  const { done, total, uploaded, skipped, failed } = progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const text = uploadProgressText(progress, paused, variant);
  const shownText = useThrottledValue(text, paused ? 0 : ANNOUNCE_EVERY_MS);
  const wizard = variant === "wizard";

  if (wizard) {
    return (
      <UploadStage
        progress={progress}
        paused={paused}
        onTogglePause={onTogglePause}
        headline={text}
        statusText={shownText}
        thumbs={thumbs}
        settled={settled}
        onSettled={onSettled}
      />
    );
  }

  const bar = (
    <div
      role="progressbar"
      aria-label="Upload progress"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${total} done`}
      className="h-3 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full rounded-full bg-accent-strong transition-[width] duration-300 motion-reduce:transition-none"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
  const counts = (
    <p className="text-sm text-muted-foreground" data-testid="upload-counts">
      {uploaded} added
      {skipped > 0 ? ` · ${skipped} skipped` : null}
      {failed > 0 ? ` · ${failed} failed` : null}
    </p>
  );
  const pause = (
    <Button
      type="button"
      variant="outline"
      size="touch"
      onClick={onTogglePause}
      className="w-full text-base"
      data-testid="upload-pause"
    >
      {paused ? "Resume" : "Pause"}
    </Button>
  );

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-card sm:p-6"
      data-testid="upload-running"
    >
      <p className="type-h2 [font-variant-numeric:lining-nums_tabular-nums]" role="status" aria-live="polite" data-testid="upload-progress">
        {shownText}
      </p>
      {bar}
      {counts}
      {pause}
    </section>
  );
}
