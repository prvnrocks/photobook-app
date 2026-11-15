"use client";

// "Make it with AI" (M13 review fix): a rule album whose book never had an AI build (the automatic
// first build didn't start — fewer than 5 photos, a limit, an error) keeps a way into the AI. Not
// dismissible; shown only while AI is on, the album is unedited and the editor is writable
// (src/lib/editor/ai-path.ts). Opens the build screen, which starts a normal build (manual start,
// normal caps D-021/D-026) — or resumes one that's already running. 44 px targets, 375 px safe.
// M22 T3: cream ribbon card under the emerald band; the CTA is emerald solid (one gold per screen =
// Share, D-074).

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { cx } from "@/lib/cx";
import { ED_CTA_EMERALD } from "./editor-classes";

export const MAKE_WITH_AI_LABEL = "Make it with AI";
export const MAKE_WITH_AI_HINT = "AI picks your best photos and writes captions.";

export function makeWithAiHref(bookId: string): string {
  return `/books/${bookId}/build`;
}

export function MakeWithAiChip({ bookId }: { bookId: string }) {
  return (
    <div
      className="mx-2 mt-2 flex shrink-0 items-center gap-2 rounded-2xl border border-[#e9dfca] bg-card py-1.5 ps-3 pe-1.5 shadow-[0_14px_32px_-24px_rgb(14_59_46/0.5)] sm:mx-4 lg:mx-8"
      data-testid="ai-make-chip"
    >
      <Sparkles className="size-4 shrink-0 text-accent-text" aria-hidden="true" />
      <p className="type-small line-clamp-2 min-w-0 flex-1 text-muted-foreground">{MAKE_WITH_AI_HINT}</p>
      <Link
        href={makeWithAiHref(bookId)}
        className={cx(ED_CTA_EMERALD, "shrink-0")}
        data-testid="ai-make-link"
      >
        {MAKE_WITH_AI_LABEL}
      </Link>
    </div>
  );
}
