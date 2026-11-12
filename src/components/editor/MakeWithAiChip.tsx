"use client";

// "Make it with AI" (M13 review fix): a rule album whose book never had an AI build (the automatic
// first build didn't start — fewer than 5 photos, a limit, an error) keeps a way into the AI. Not
// dismissible; shown only while AI is on, the album is unedited and the editor is writable
// (src/lib/editor/ai-path.ts). Opens the build screen, which starts a normal build (manual start,
// normal caps D-021/D-026) — or resumes one that's already running. 44 px targets, 375 px safe.

import { Sparkles } from "lucide-react";
import Link from "next/link";

export const MAKE_WITH_AI_LABEL = "Make it with AI";
export const MAKE_WITH_AI_HINT = "AI picks your best photos and writes captions.";

export function makeWithAiHref(bookId: string): string {
  return `/books/${bookId}/build`;
}

export function MakeWithAiChip({ bookId }: { bookId: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card py-1 ps-4 pe-2" data-testid="ai-make-chip">
      <Sparkles className="size-4 shrink-0 text-accent-strong" aria-hidden="true" />
      <p className="type-small line-clamp-2 min-w-0 flex-1 text-muted-foreground">{MAKE_WITH_AI_HINT}</p>
      <Link
        href={makeWithAiHref(bookId)}
        className="inline-flex min-h-11 shrink-0 items-center rounded-lg bg-accent-strong px-3 text-sm font-semibold text-accent-strong-foreground shadow-card outline-none hover:bg-accent-strong/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        data-testid="ai-make-link"
      >
        {MAKE_WITH_AI_LABEL}
      </Link>
    </div>
  );
}
