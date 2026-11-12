"use client";

// "AI kept 34 of 40 photos · See 6 left out" (M13 T7, D-070 (3)). The build screen goes straight to the
// editor; this row keeps every AI choice one tap away: it links to the review screen (unchanged
// logic, D-031/D-037), where photos can be put back or left out. Dismissible per book (localStorage,
// guarded — src/lib/editor/ai-summary.ts). Hidden when the editor is read-only. 44 px targets.

import { Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { aiSummaryDismissed, dismissAiSummary, subscribeAiSummary, type AiSummary } from "@/lib/editor/ai-summary";

/** Server/hydration snapshot: not dismissed → the chip is in the SSR HTML (no late layout shift). */
const notDismissedOnServer = () => false;

export function AiSummaryChip({ bookId, summary, readOnly }: { bookId: string; summary: AiSummary | null; readOnly: boolean }) {
  const dismissed = useSyncExternalStore(subscribeAiSummary, () => aiSummaryDismissed(bookId), notDismissedOnServer);
  if (!summary || readOnly || dismissed) return null;
  return <AiSummaryChipView bookId={bookId} summary={summary} onDismiss={() => dismissAiSummary(bookId)} />;
}

/** Presentational row (exported for render tests). */
export function AiSummaryChipView({ bookId, summary, onDismiss }: { bookId: string; summary: AiSummary; onDismiss(): void }) {
  return (
    <div
      className="flex shrink-0 items-center gap-1 border-b border-border bg-card ps-2 pe-1"
      data-testid="ai-summary-chip"
      data-kept={summary.kept}
      data-total={summary.total}
    >
      <Link
        href={`/books/${bookId}/review`}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        title={summary.detail}
        data-testid="ai-summary-link"
      >
        <Sparkles className="size-4 shrink-0 text-accent-strong" aria-hidden="true" />
        {/* Two lines at most (3-digit counts at 375 px) so "See N left out" is never cut off. */}
        <span className="line-clamp-2 min-w-0 break-words">
          <span className="text-foreground" data-testid="ai-summary-label">
            {summary.label}
          </span>
          <span className="text-muted-foreground" aria-hidden="true">
            {" · "}
          </span>
          <span className="font-medium text-primary underline underline-offset-2">{summary.linkText}</span>
          {summary.detail ? <span className="sr-only">. {summary.detail}</span> : null}
        </span>
      </Link>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Hide photo summary"
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="ai-summary-dismiss"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
