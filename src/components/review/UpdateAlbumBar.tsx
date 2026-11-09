"use client";

// Sticky bottom bar on the review screen (D-028): "You changed n photos." + primary
// "Update album". Presentational; ReviewBody owns the state. Safe-area aware, fits 375 px.
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { changedPhotosCopy, type UpdateAlbumOutcome } from "@/lib/review/ui";

type UpdateAlbumBarProps = {
  count: number;
  pending: boolean;
  error: Extract<UpdateAlbumOutcome, { kind: "error" }> | null;
  onUpdate: () => void;
};

export function UpdateAlbumBar({ count, pending, error, onUpdate }: UpdateAlbumBarProps) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(0,0,0,0.06)] backdrop-blur supports-[backdrop-filter]:bg-background/85"
      data-testid="update-album-bar"
      role="region"
      aria-label="Album changes"
    >
      <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <p className="min-w-0 flex-1 text-base" data-testid="update-album-count" aria-live="polite">
            {count > 0 ? changedPhotosCopy(count) : "Your changes need updating."}
          </p>
          <Button
            type="button"
            className="h-11 shrink-0 px-4 text-base"
            disabled={pending}
            aria-busy={pending}
            onClick={onUpdate}
            data-testid="update-album"
          >
            {pending ? "Updating…" : "Update album"}
          </Button>
        </div>
        {error ? (
          <p
            role="alert"
            className="text-sm break-words text-destructive"
            data-testid="update-album-error"
            data-error={error.error}
          >
            {error.message}{" "}
            {error.link ? (
              <Link href={error.link.href} className="font-medium underline underline-offset-2" data-testid="update-album-error-link">
                {error.link.label}
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
