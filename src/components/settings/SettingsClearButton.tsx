"use client";

// "Clear what the AI learned" with an inline confirm step (D-032). Rendered at a stable position
// in /settings so its "done" state survives the router.refresh() that swaps in the empty state.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { clearMemoryAction } from "@/app/settings/actions";
import { Notice } from "@/components/app/Notice";
import { Button } from "@/components/ui/button";
import { clearOutcome, SETTINGS_COPY } from "@/lib/settings/ui";

type Phase = "idle" | "confirm" | "done";

export function SettingsClearButton({ hasMemory }: { hasMemory: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // Move focus into the confirm step, and back to the trigger on cancel.
  useEffect(() => {
    if (phase === "confirm") cancelRef.current?.focus();
    else if (phase === "idle" && wasConfirming.current) openRef.current?.focus();
    wasConfirming.current = phase === "confirm";
  }, [phase]);

  if (phase === "done") {
    return (
      <p role="status" className="text-sm text-muted-foreground" data-testid="settings-clear-done">
        {SETTINGS_COPY.done}
      </p>
    );
  }
  if (!hasMemory) return null;

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      let outcome;
      try {
        outcome = clearOutcome(await clearMemoryAction());
      } catch {
        outcome = clearOutcome(null);
      }
      if (outcome.kind === "done") {
        setPhase("done");
        router.refresh();
      } else {
        setError(outcome.message);
      }
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {phase === "confirm" ? (
        <div
          role="group"
          aria-labelledby="settings-clear-question"
          className="flex min-w-0 flex-col gap-3 rounded-xl border border-destructive-border bg-destructive-soft p-4"
          data-testid="settings-clear-confirm"
        >
          <p id="settings-clear-question" className="text-base font-medium">
            {SETTINGS_COPY.confirmQuestion}
          </p>
          <p className="text-sm text-muted-foreground">{SETTINGS_COPY.confirmDetail}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              ref={cancelRef}
              type="button"
              variant="outline"
              size="touch"
              className="text-base"
              disabled={pending}
              onClick={() => {
                setError(null);
                setPhase("idle");
              }}
              data-testid="settings-clear-cancel"
            >
              {SETTINGS_COPY.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="touch"
              className="bg-destructive text-base text-white hover:bg-destructive/90"
              disabled={pending}
              aria-busy={pending}
              onClick={onConfirm}
              data-testid="settings-clear-yes"
            >
              {pending ? SETTINGS_COPY.clearing : SETTINGS_COPY.confirm}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={openRef}
          type="button"
          variant="outline"
          size="touch"
          className="w-full text-base"
          onClick={() => setPhase("confirm")}
          data-testid="settings-clear"
        >
          {SETTINGS_COPY.clear}
        </Button>
      )}
      {error ? (
        <Notice tone="error" data-testid="settings-clear-error">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}
