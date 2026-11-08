// Progress card shown while the upload queue runs. Presentational only.
import type { QueueProgress } from "@/lib/upload/queue";
import { Button } from "@/components/ui/button";

type UploadProgressProps = {
  progress: QueueProgress;
  paused: boolean;
  onTogglePause: () => void;
};

export function UploadProgress({ progress, paused, onTogglePause }: UploadProgressProps) {
  const { done, total, uploaded, skipped, failed } = progress;
  const current = Math.min(done + 1, total);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4"
      data-testid="upload-running"
    >
      <p className="text-base font-medium" data-testid="upload-progress">
        {paused ? `Paused · ${done} of ${total} done` : `Uploading ${current} of ${total}`}
      </p>
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
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-sm text-muted-foreground" data-testid="upload-counts">
        {uploaded} added
        {skipped > 0 ? ` · ${skipped} skipped` : null}
        {failed > 0 ? ` · ${failed} failed` : null}
      </p>
      <p className="text-sm text-muted-foreground">
        Keep this screen open until it finishes.
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={onTogglePause}
        className="h-11 w-full text-base"
        data-testid="upload-pause"
      >
        {paused ? "Resume" : "Pause"}
      </Button>
    </section>
  );
}
