"use client";

// Editor header "Share" (M13 T9, D-070 #4; was "Done", M5 T12): flush + await pending saves, then
// shareBookAction publishes (or publishes changes) and the share screen opens with the link ready
// — WhatsApp is the next tap. Decisions live in src/lib/editor/done.ts.
// - read-only (conflict / saving unavailable): the share screen without publishing;
// - signed out: /login?next=/books/<id>/edit;
// - still unsaved (offline) / publish blocked (empty, page limit, expired, invalid) / failed:
//   stay in the editor and say why.
// The subtitle shows what the link will be BEFORE the tap: "Free · 30 days", "Permanent link"
// or "Publish changes" when the live book is behind the saved one.

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { track } from "@/lib/analytics/client";
import { FREE_LINK_DAYS } from "@/lib/publish/free-link";
import { doneStepAfterSave, doneStepAfterShare, shareSubtitle, type DoneStep, type ShareResult } from "@/lib/editor/done";
import type { SaveState } from "./useAutosave";

export type EditorShareButtonProps = {
  bookId: string;
  /** useAutosave().settle */
  settle: () => Promise<SaveState>;
  /** Bound shareBookAction; absent (dev fixture) → navigate to `fallbackHref` after saving. */
  share?: () => Promise<ShareResult>;
  fallbackHref: string;
  isPaid: boolean;
  /** Live and the saved doc moved past the snapshot (hasUnpublishedChanges). */
  hasChanges: boolean;
  maxPages?: number;
};

const ERROR_MS = 6000;
/** Errors with a next step (Upgrade on the share screen) stay longer. */
const ERROR_LINK_MS = 12000;

type ErrorStep = Extract<DoneStep, { kind: "error" }>;

export function EditorShareButton({ bookId, settle, share, fallbackHref, isPaid, hasChanges, maxPages }: EditorShareButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorStep | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const running = useRef(false);
  const descId = useId();

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), error.link ? ERROR_LINK_MS : ERROR_MS);
    return () => clearTimeout(t);
  }, [error]);

  const onShare = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    let step: DoneStep;
    try {
      step = doneStepAfterSave(await settle(), bookId);
      if (step.kind === "share") {
        if (!share) {
          step = { kind: "navigate", to: fallbackHref };
        } else {
          let r: ShareResult | null = null;
          try {
            r = await share();
          } catch {
            r = null;
          }
          // analytics (M9 T14): flags + page count only, only when this tap published.
          if (r?.ok && r.published) track("published", r.published);
          step = doneStepAfterShare(r, bookId, maxPages);
        }
      }
    } catch {
      step = doneStepAfterShare(null, bookId, maxPages);
    }
    if (step.kind === "navigate") {
      setTarget(step.to); // stays busy until the page changes
      return;
    }
    if (step.kind === "error") setError(step);
    running.current = false;
    setBusy(false);
  }, [settle, share, bookId, fallbackHref, maxPages]);

  const subtitle = shareSubtitle({ isPaid, hasChanges });

  return (
    <>
      <button
        type="button"
        onClick={onShare}
        disabled={busy}
        aria-busy={busy}
        aria-describedby={descId}
        title="Publishes your book and opens sharing"
        className="flex h-11 min-w-16 shrink-0 items-center justify-center rounded-lg bg-primary px-3 text-primary-foreground shadow-card outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-70"
        data-testid="editor-done"
        data-changes={hasChanges ? "true" : "false"}
      >
        <span className="flex flex-col items-start leading-tight">
          <span className="flex items-center gap-1 text-sm font-semibold">
            {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
            Share
          </span>
          <span
            className="whitespace-nowrap text-[11px] font-medium text-primary-foreground/80"
            data-testid={hasChanges ? "editor-publish-changes" : "editor-share-note"}
          >
            {subtitle}
          </span>
        </span>
      </button>
      <span id={descId} className="sr-only">
        Publishes your book so anyone with the link can see it, then opens sharing.
        {isPaid ? "" : ` Free links last ${FREE_LINK_DAYS} days.`}
      </span>
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center px-4">
        {error ? (
          <p
            className="pointer-events-auto max-w-sm rounded-xl bg-primary px-4 py-3 text-sm text-primary-foreground shadow-lift"
            data-testid="editor-done-error"
          >
            {error.message}
            {error.link ? (
              <>
                {" "}
                <Link
                  href={error.link.href}
                  className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground"
                  data-testid="editor-done-error-link"
                >
                  {error.link.label}
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      {target ? <Navigate to={target} /> : null}
    </>
  );
}

/** Mounted only after Share decides where to go, so the shell renders without an app router (tests). */
function Navigate({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.push(to);
  }, [router, to]);
  return null;
}
