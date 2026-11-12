// Editor header "Share" (M5 Task 12 "Done" → M13 T9, D-070 #4). Pure + tested in node: wait for
// pending saves, then decide what Share does. The UI (EditorShareButton) calls shareBookAction
// (publish or publish changes, src/app/books/[id]/publish/actions.ts) only when the latest edit is
// saved (or nothing was pending), so what goes live is what the user sees.

import { FREE_LINK_DAYS, type FreeLinkState } from "@/lib/publish/free-link";
import { publishErrorCopy, type PublishError } from "@/lib/publish/ui";
import { isTerminal, type AutosaveStatus } from "./autosave";

/** What drainSaves needs from AutosaveScheduler. */
export interface DrainableSaves {
  flush(): Promise<void> | null;
  hasUnsaved(): boolean;
  getStatus(): AutosaveStatus;
}

/** Upper bound on save rounds (a change made while a save is in flight needs a second one). */
export const MAX_DRAIN_ROUNDS = 4;

/**
 * Sends anything pending now (skipping the debounce and any retry backoff) and waits until nothing
 * is unsaved, a terminal state is reached, or one retry round failed again (offline). Returns the
 * final status. Never throws.
 */
export async function drainSaves(saves: DrainableSaves, maxRounds = MAX_DRAIN_ROUNDS): Promise<AutosaveStatus> {
  for (let i = 0; i < maxRounds; i++) {
    const before = saves.getStatus();
    if (isTerminal(before) || !saves.hasUnsaved()) return before;
    const inflight = saves.flush();
    if (!inflight) return saves.getStatus();
    try {
      await inflight;
    } catch {
      // the scheduler maps errors to statuses; just read the status below
    }
    if (saves.getStatus().kind === "retrying") return saves.getStatus();
  }
  return saves.getStatus();
}

/** Save state as the editor sees it ("readOnly" = saving was never available). */
export type DoneSaveState = AutosaveStatus | { kind: "readOnly" };

export type DoneStep =
  | { kind: "share" }
  | { kind: "navigate"; to: string }
  | { kind: "error"; message: string; link?: { href: string; label: string } };

export const DONE_MESSAGES = {
  unsaved: "We couldn't save your latest changes. Check your connection and tap Share again.",
  /** Retrying because the server is busy (503 unavailable / 5xx / 429), not offline (M12). */
  delayed: "Saving is taking longer than usual. Your changes are kept here — wait a moment and tap Share again.",
  failed: "Couldn't publish right now. Check your connection and tap Share again.",
} as const;

export function loginHref(bookId: string): string {
  return `/login?next=${encodeURIComponent(`/books/${bookId}/edit`)}`;
}

export function shareScreenHref(bookId: string): string {
  return `/books/${bookId}/publish`;
}

/**
 * After drainSaves: what Share does next.
 * - saved / nothing pending / last edit rejected as invalid (it can never be saved; the banner
 *   already says so) → share (publish the saved doc, then the share screen);
 * - still unsaved (offline / retrying / pending) → stay, show an error;
 * - signed out → login, back to the editor;
 * - read-only (conflict / saving unavailable / failed / never available) → the share screen
 *   WITHOUT publishing: the saved book may not be what's on screen, so the user decides there.
 */
export function doneStepAfterSave(s: DoneSaveState, bookId: string): DoneStep {
  switch (s.kind) {
    case "idle":
    case "saved":
    case "invalid":
      return { kind: "share" };
    case "retrying":
      return {
        kind: "error",
        message: s.reason === "server" || s.reason === "rate" ? DONE_MESSAGES.delayed : DONE_MESSAGES.unsaved,
      };
    case "pending":
    case "saving":
      return { kind: "error", message: DONE_MESSAGES.unsaved };
    case "signedOut":
      return { kind: "navigate", to: loginHref(bookId) };
    case "conflict":
    case "unavailable":
    case "failed":
    case "readOnly":
      return { kind: "navigate", to: shareScreenHref(bookId) };
  }
}

/** `published` analytics props (M9 T14): flags + page count only. */
export type SharePublished = { is_paid: boolean; has_password: boolean; pages: number; first: boolean };

/** Mirrors ShareBookResult (src/app/books/[id]/publish/actions.ts) without importing server code. */
export type ShareResult =
  | { ok: true; redirectTo: string; published: SharePublished | null }
  | { ok: false; error: PublishError };

/** Only same-origin app paths are followed (never `//host` or a URL). */
function safePath(p: unknown, fallback: string): string {
  return typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/\\") ? p : fallback;
}

/**
 * After shareBookAction (null = the call threw / network error). Publish errors keep the user in
 * the editor with the publish screen's copy; expired / page_limit link to the share screen, where
 * Upgrade lives.
 */
export function doneStepAfterShare(r: ShareResult | null | undefined, bookId: string, maxPages?: number): Exclude<DoneStep, { kind: "share" }> {
  if (!r) return { kind: "error", message: DONE_MESSAGES.failed };
  if (r.ok) return { kind: "navigate", to: safePath(r.redirectTo, shareScreenHref(bookId)) };
  switch (r.error) {
    case "signed_out":
      return { kind: "navigate", to: loginHref(bookId) };
    case "not_found":
      return { kind: "navigate", to: "/dashboard" };
    case "failed":
      return { kind: "error", message: DONE_MESSAGES.failed };
    case "expired":
    case "page_limit":
      return {
        kind: "error",
        message: publishErrorCopy(r.error, maxPages),
        link: { href: shareScreenHref(bookId), label: "See options" },
      };
    default:
      return { kind: "error", message: publishErrorCopy(r.error, maxPages) };
  }
}

export type ShareLinkArgs = {
  isPaid: boolean;
  hasChanges: boolean;
  /** Unpaid books only (freeLinkState); absent → treated as never published. */
  link?: FreeLinkState;
};

function freeLink(args: ShareLinkArgs): FreeLinkState {
  return args.link ?? { kind: "unpublished" };
}

function daysLeftText(n: number): string {
  return n === 1 ? "1 day left" : `${n} days left`;
}

/**
 * Share button subtitle (shown before the tap, D-070 #4), truthful per D-039: "Free · 30 days" only
 * before the first publish; then "Free · N days left"; "Link expired" once past expiry (wins over
 * "Publish changes": republishing is blocked then).
 */
export function shareSubtitle(args: ShareLinkArgs): string {
  if (args.isPaid) return args.hasChanges ? "Publish changes" : "Permanent link";
  const link = freeLink(args);
  if (link.kind === "expired") return "Link expired";
  if (args.hasChanges) return "Publish changes";
  if (link.kind === "counting") return `Free · ${daysLeftText(link.daysLeft)}`;
  return `Free · ${FREE_LINK_DAYS} days`;
}

/** The button's screen-reader description (aria-describedby). */
export function shareDescription(args: ShareLinkArgs): string {
  const base = "Publishes your book so anyone with the link can see it, then opens sharing.";
  if (args.isPaid) return base;
  const link = freeLink(args);
  if (link.kind === "expired") return "Your free link has expired. Opens sharing, where you can see your options.";
  if (link.kind === "counting") return `${base} Your free link has ${daysLeftText(link.daysLeft)}.`;
  return `${base} Free links last ${FREE_LINK_DAYS} days from the first share.`;
}

/**
 * An expired free link can't be republished (D-039): instead of trying (and failing), Share opens
 * the share screen, where Upgrade lives. Other steps pass through.
 */
export function shareStepForLink(step: DoneStep, args: ShareLinkArgs, bookId: string): DoneStep {
  if (step.kind === "share" && !args.isPaid && freeLink(args).kind === "expired") {
    return { kind: "navigate", to: shareScreenHref(bookId) };
  }
  return step;
}
