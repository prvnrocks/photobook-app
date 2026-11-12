"use client";

// "Apply photo changes" row on the review screen (D-028, M11 T12; formerly "Update album"):
// "You changed n photos." + the button.
// Shown only while keep / drop choices aren't in the album yet, inside the review ActionBar (which
// owns the sticky, safe-area-aware positioning). Presentational; ReviewBody owns the state.
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { changedPhotosCopy, UPDATE_ALBUM_LABEL, UPDATE_ALBUM_PENDING_LABEL, type UpdateAlbumOutcome } from "@/lib/review/ui";

type UpdateAlbumBarProps = {
  count: number;
  pending: boolean;
  error: Extract<UpdateAlbumOutcome, { kind: "error" }> | null;
  onUpdate: () => void;
  /** Extra line under the count (the Continue warning). */
  note?: ReactNode;
};

export function UpdateAlbumBar({ count, pending, error, onUpdate, note }: UpdateAlbumBarProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="update-album-bar" role="region" aria-label="Album changes">
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="type-small font-semibold text-foreground" data-testid="update-album-count" aria-live="polite">
            {count > 0 ? changedPhotosCopy(count) : "Your changes need updating."}
          </p>
          {note}
        </div>
        <Button
          type="button"
          size="touch"
          className="shrink-0"
          disabled={pending}
          aria-busy={pending}
          onClick={onUpdate}
          data-testid="update-album"
        >
          {pending ? UPDATE_ALBUM_PENDING_LABEL : UPDATE_ALBUM_LABEL}
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          className="type-small break-words text-destructive"
          data-testid="update-album-error"
          data-error={error.error}
        >
          {error.message}{" "}
          {error.link ? (
            <Link
              href={error.link.href}
              className="inline-flex min-h-11 items-center font-medium underline underline-offset-2"
              data-testid="update-album-error-link"
            >
              {error.link.label}
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
