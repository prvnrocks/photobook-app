"use client";

// Autosave status: a chip on the editor band (M22 T3: ED_CHIP tones on the leather, a breathing dot
// while saving — static under reduced motion) + a cream card under the band for states that need
// the user. Labels (saveStatusLabel) are unchanged (D-074: keep today's wording).

import Link from "next/link";
import { cx } from "@/lib/cx";
import { invalidSaveCopy } from "@/lib/editor/autosave";
import { ED_CHIP_DOT, ED_CHIP_TONE, ED_CTA_EMERALD, type EdChipTone } from "./editor-classes";
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
      // Server busy (503 unavailable / 5xx / 429) isn't "offline" (M12).
      return s.reason === "server" || s.reason === "rate" ? "Saving delayed – retrying" : "Offline – retrying";
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

/** Banner actions: the emerald solid CTA (one gold per screen = Share). */
const BANNER_BUTTON = cx(ED_CTA_EMERALD, "self-start");

/**
 * Save chip shape: like ED_CHIP but compact on phones (24 px, so title + chip fit the 56 px row),
 * ED_CHIP size from lg. It's a status, not a button — the 44 px rule applies to Reload only.
 */
const SAVE_CHIP =
  "inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2 text-[11px] leading-none font-semibold whitespace-nowrap lg:h-8 lg:px-2.5 lg:text-sm";

export function saveChipTone(s: SaveState): EdChipTone {
  switch (s.kind) {
    case "idle":
    case "saved":
      return "saved";
    case "pending":
    case "saving":
      return "saving";
    default:
      return "warn";
  }
}

export function SaveStatus({ status }: { status: SaveState }) {
  const tone = saveChipTone(status);
  return (
    <span className="flex min-w-0 items-center gap-2" aria-live="polite" data-testid="save-status" data-state={status.kind}>
      <span className={cx(SAVE_CHIP, ED_CHIP_TONE[tone])} data-tone={tone}>
        <span aria-hidden="true" className={cx(ED_CHIP_DOT[tone], tone === "saving" && "ed-save-pulse")} />
        <span className="truncate">{saveStatusLabel(status)}</span>
      </span>
      {status.kind === "conflict" ? (
        <button
          type="button"
          onClick={reload}
          className="relative shrink-0 rounded text-xs font-semibold text-[#e3c766] underline underline-offset-2 outline-none before:absolute before:-inset-x-3 before:-inset-y-[14px] before:content-[''] focus-visible:ring-2 focus-visible:ring-[#f2e8d8] lg:text-sm"
          data-testid="save-status-reload"
        >
          Reload
        </button>
      ) : null}
    </span>
  );
}

/** Cream card under the band for states the user should act on (or know about). */
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
      className="mx-2 mt-2 flex shrink-0 flex-col gap-2 rounded-2xl border border-[#e9dfca] border-s-4 border-s-[#c9a227] bg-card px-4 py-3 text-sm text-foreground shadow-[0_14px_32px_-24px_rgb(14_59_46/0.5)] sm:mx-4 lg:mx-8"
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
