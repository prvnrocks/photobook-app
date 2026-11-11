"use client";

// Autosave status: a one-line label in the header + a banner for states that need the user.

import Link from "next/link";
import { invalidSaveCopy } from "@/lib/editor/autosave";
import { cn } from "@/lib/utils";
import type { SaveState } from "./useAutosave";

/** Header label for a save state. Pure, exported for tests. */
export function saveStatusLabel(s: SaveState): string {
  switch (s.kind) {
    case "idle":
    case "saved":
      return "Saved ✓";
    case "pending":
    case "saving":
      return "Saving…";
    case "retrying":
      return "Offline – retrying";
    case "invalid":
      return "Not saved";
    case "conflict":
      return "Changed in another tab";
    case "unavailable":
    case "readOnly":
      return "Saving unavailable";
    case "signedOut":
      return "Signed out – not saved";
    case "failed":
      return "Can't save";
  }
}

const reload = () => window.location.reload();

const BANNER_BUTTON =
  "inline-flex min-h-11 items-center self-start rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-warning-soft";

export function SaveStatus({ status }: { status: SaveState }) {
  const warn = status.kind !== "idle" && status.kind !== "saved" && status.kind !== "pending" && status.kind !== "saving";
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs" aria-live="polite" data-testid="save-status" data-state={status.kind}>
      <span className={cn("truncate", warn ? "font-medium text-warning" : "text-muted-foreground")}>{saveStatusLabel(status)}</span>
      {status.kind === "conflict" ? (
        <button
          type="button"
          onClick={reload}
          className="relative shrink-0 rounded font-medium text-primary underline underline-offset-2 outline-none before:absolute before:-inset-3 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="save-status-reload"
        >
          Reload
        </button>
      ) : null}
    </span>
  );
}

/** Banner under the header for states the user should act on (or know about). */
export function SaveBanner({ status, bookId }: { status: SaveState; bookId: string }) {
  let body: React.ReactNode = null;
  switch (status.kind) {
    case "readOnly":
    case "unavailable":
      body = (
        <p>
          Saving isn&apos;t available right now, so editing is paused. Your album is shown read-only — please try again later.
        </p>
      );
      break;
    case "conflict":
      body = (
        <>
          <p>This book was changed in another tab or device. Reload to get the latest version — edits made here since the last save will be lost.</p>
          <BannerButton onClick={reload} testId="save-banner-reload">Reload</BannerButton>
        </>
      );
      break;
    case "invalid":
      body = <p>{invalidSaveCopy(status.code)}</p>;
      break;
    case "signedOut":
      body = (
        <>
          <p>You&apos;ve been signed out, so changes aren&apos;t being saved.</p>
          <Link
            href={`/login?next=${encodeURIComponent(`/books/${bookId}/edit`)}`}
            className={BANNER_BUTTON}
          >
            Sign in again
          </Link>
        </>
      );
      break;
    case "failed":
      body = (
        <>
          <p>This book can&apos;t be saved right now.</p>
          <BannerButton onClick={reload} testId="save-banner-reload">Reload</BannerButton>
        </>
      );
      break;
    default:
      return null;
  }
  return (
    <div
      role="status"
      className="flex shrink-0 flex-col gap-2 border-b border-warning-border bg-warning-soft px-4 py-2.5 text-sm text-foreground"
      data-testid={`save-banner-${status.kind}`}
    >
      {body}
    </div>
  );
}

function BannerButton({ onClick, children, testId }: { onClick: () => void; children: React.ReactNode; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={BANNER_BUTTON}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
