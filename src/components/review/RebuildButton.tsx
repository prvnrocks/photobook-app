"use client";

// "Rebuild album" / "Try AI again" on the review screen → POST /api/ai/runs.
// AI runs continue on /books/[id]/build; a rule run (AI off) finishes inside the request, so
// we stay here and refresh.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  REBUILD_LABELS,
  rebuildsLeftLabel,
  rebuildTrigger,
  requestRebuild,
  type RebuildVariant,
} from "@/lib/review/ui";

type RebuildButtonProps = {
  bookId: string;
  variant: RebuildVariant;
  /** Live AI rebuilds left for this book; null = not limited here (rule / replay mode). */
  rebuildsLeft: number | null;
};

export function RebuildButton({ bookId, variant, rebuildsLeft }: RebuildButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // 'first_ai' uses trigger 'build', which does not count toward rebuilds.
  const usesRebuild = rebuildTrigger(variant) === "rebuild" && variant !== "ai_off";
  const outOfRebuilds = usesRebuild && rebuildsLeft !== null && rebuildsLeft <= 0;
  const working = busy || refreshing;

  async function onClick() {
    if (working || outOfRebuilds) return;
    setBusy(true);
    setMessage(null);
    setDone(false);
    const outcome = await requestRebuild(bookId, rebuildTrigger(variant));
    if (outcome.kind === "go_build") {
      router.push(`/books/${bookId}/build`);
      return; // keep busy while navigating
    }
    setBusy(false);
    if (outcome.kind === "refreshed") {
      setDone(true);
      startRefresh(() => router.refresh());
    } else {
      setMessage(outcome.message);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="rebuild">
      <Button
        type="button"
        variant="outline"
        className="h-12 w-full text-base"
        disabled={working || outOfRebuilds}
        onClick={onClick}
        data-testid="rebuild-button"
        aria-describedby="rebuild-hint"
      >
        {working ? (variant === "ai_off" ? "Rebuilding…" : "Starting…") : REBUILD_LABELS[variant]}
      </Button>

      <p id="rebuild-hint" className="text-sm text-muted-foreground" data-testid="rebuild-hint">
        {outOfRebuilds
          ? "You've used all the AI rebuilds for this book. You can still keep or drop photos."
          : variant === "ai_off"
            ? "Builds the album again from the photos you kept."
            : usesRebuild && rebuildsLeft !== null
              ? `${rebuildsLeftLabel(rebuildsLeft)}. Your keep / drop choices stay as they are.`
              : "Your keep / drop choices stay as they are."}
      </p>

      {variant === "ai_off" ? (
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-full text-base"
            disabled
            aria-describedby="ai-off-hint"
            data-testid="try-ai-disabled"
          >
            Try AI again
          </Button>
          <p id="ai-off-hint" className="text-center text-sm text-muted-foreground">
            AI isn&apos;t available yet.
          </p>
        </div>
      ) : null}

      <p role="status" aria-live="polite" className="text-base">
        {message ? (
          <span className="text-destructive" data-testid="rebuild-error">
            {message}
          </span>
        ) : done && !refreshing ? (
          <span data-testid="rebuild-done">Album rebuilt.</span>
        ) : null}
      </p>
    </div>
  );
}
