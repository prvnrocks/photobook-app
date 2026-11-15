"use client";

// "AI kept 34 of 40 photos · See 6 left out" (M13 T7, D-070 (3)). The build screen goes straight to the
// editor; this row keeps every AI choice one tap away: it links to the review screen (unchanged
// logic, D-031/D-037), where photos can be put back or left out. Dismissible per book (localStorage,
// guarded — src/lib/editor/ai-summary.ts). Hidden when the editor is read-only. 44 px targets.
// M22 T3: a cream ribbon card under the emerald band (emerald link 12.47:1, muted ink on white).

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
      className="mx-2 mt-2 flex shrink-0 items-center gap-1 rounded-2xl border border-[#e9dfca] bg-card ps-1 pe-1 shadow-[0_14px_32px_-24px_rgb(14_59_46/0.5)] sm:mx-4 lg:mx-8"
      data-testid="ai-summary-chip"
      data-kept={summary.kept}
      data-total={summary.total}
    >
      <Link
        href={`/books/${bookId}/review`}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-2 text-sm transition-colors outline-none hover:bg-[#f4ede0] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] motion-reduce:transition-none"
        title={summary.detail}
        data-testid="ai-summary-link"
      >
        <Sparkles className="size-4 shrink-0 text-accent-text" aria-hidden="true" />
        {/* Two lines at most (3-digit counts at 375 px) so "See N left out" is never cut off. */}
        <span className="line-clamp-2 min-w-0 break-words">
          <span className="text-foreground" data-testid="ai-summary-label">
            {summary.label}
          </span>
          <span className="text-muted-foreground" aria-hidden="true">
            {" · "}
          </span>
          <span className="font-semibold text-[#0e3b2e] underline underline-offset-2">{summary.linkText}</span>
          {summary.detail ? <span className="sr-only">. {summary.detail}</span> : null}
        </span>
      </Link>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Hide photo summary"
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-[#f4ede0] hover:text-[#0e3b2e] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] motion-reduce:transition-none"
        data-testid="ai-summary-dismiss"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
