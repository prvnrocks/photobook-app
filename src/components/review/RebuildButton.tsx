"use client";

// Secondary "Rebuild with AI" / "Try AI again" on the review screen (re-plans the whole story;
// the free "Update album" bar is the primary way choices reach the album, D-028) → POST /api/ai/runs.
// AI runs continue on /books/[id]/build; a rule run (AI off) finishes inside the request, so
// we stay here and refresh. The refresh goes through useRefreshTransition: a plain
// startTransition(() => router.refresh()) could stay pending forever under this route's loading.tsx,
// leaving "Making…" on screen (lost React ping, see src/lib/app/refresh-nudge.ts).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { useRefreshTransition } from "@/components/app/use-refresh-transition";
import { Button } from "@/components/ui/button";
import {
  REBUILD_LABELS,
  rebuildsLeftCopy,
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
  const [refreshing, refresh] = useRefreshTransition();
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
      refresh();
    } else {
      setMessage(outcome.message);
    }
  }

  const leftCopy = usesRebuild ? rebuildsLeftCopy(rebuildsLeft) : null;
  const hint = outOfRebuilds
    ? "You've used all the AI redos for this book. You can still keep or drop photos."
    : variant === "ai_off"
      ? "Makes the book again from the photos you kept."
      : usesRebuild
        ? "Re-plans the whole story with AI. Your keep / drop choices stay."
        : "Your keep / drop choices stay as they are.";

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="rebuild">
      <Button
        type="button"
        variant="outline"
        size="touch"
        className="w-full"
        disabled={working || outOfRebuilds}
        onClick={onClick}
        data-testid="rebuild-button"
        aria-describedby="rebuild-hint"
      >
        {variant === "ai_off" ? null : <Sparkles data-icon="inline-start" aria-hidden="true" />}
        {working ? (variant === "ai_off" ? "Making…" : "Starting…") : REBUILD_LABELS[variant]}
      </Button>

      <p id="rebuild-hint" className="type-small text-muted-foreground" data-testid="rebuild-hint">
        {hint}
        {leftCopy && !outOfRebuilds ? (
          <>
            {" "}
            <span className="font-medium text-foreground" data-testid="rebuild-left">
              {leftCopy}
            </span>
          </>
        ) : null}
      </p>

      {variant === "ai_off" ? (
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="ghost"
            size="touch"
            className="w-full"
            disabled
            aria-describedby="ai-off-hint"
            data-testid="try-ai-disabled"
          >
            Try AI again
          </Button>
          <p id="ai-off-hint" className="type-small text-center text-muted-foreground">
            AI isn&apos;t available yet.
          </p>
        </div>
      ) : null}

      <p role="status" aria-live="polite" className="type-small">
        {message ? (
          <span className="text-destructive" data-testid="rebuild-error">
            {message}
          </span>
        ) : done && !refreshing ? (
          <span className="text-success" data-testid="rebuild-done">
            Album rebuilt.
          </span>
        ) : null}
      </p>
    </div>
  );
}
