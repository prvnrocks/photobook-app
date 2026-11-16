"use client";

// "Clear what the AI learned" with an inline confirm step (D-032). Rendered at a stable position
// in /settings so its "done" state survives the router.refresh() that swaps in the empty state.
// M24 (D-076): plain buttons with settings-classes.ts recipes (no Button/cn in this island) —
// emerald outline Clear; the confirm step is a soft red panel with Cancel + solid red Yes.
import { useEffect, useRef, useState, useTransition } from "react";
import { clearMemoryAction } from "@/app/settings/actions";
import { Notice } from "@/components/app/Notice";
import { useRefreshTransition } from "@/components/app/use-refresh-transition";
import { SETTINGS_CTA_DANGER, SETTINGS_CTA_EMERALD } from "@/components/settings/settings-classes";
import { clearOutcome, SETTINGS_COPY } from "@/lib/settings/ui";

type Phase = "idle" | "confirm" | "done";

export function SettingsClearButton({ hasMemory }: { hasMemory: boolean }) {
  // Not router.refresh(): inside a transition it can stay pending forever under settings/loading.tsx.
  const [, refresh] = useRefreshTransition();
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
      <p role="status" className="type-small font-medium text-[#0e3b2e]" data-testid="settings-clear-done">
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
        refresh();
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
          className="flex min-w-0 flex-col gap-3 rounded-2xl border border-destructive-border bg-destructive-soft p-4 sm:p-5"
          data-testid="settings-clear-confirm"
        >
          <p id="settings-clear-question" className="text-base font-medium">
            {SETTINGS_COPY.confirmQuestion}
          </p>
          <p className="type-small text-muted-foreground">{SETTINGS_COPY.confirmDetail}</p>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <button
              ref={cancelRef}
              type="button"
              className={SETTINGS_CTA_EMERALD}
              disabled={pending}
              onClick={() => {
                setError(null);
                setPhase("idle");
              }}
              data-testid="settings-clear-cancel"
            >
              {SETTINGS_COPY.cancel}
            </button>
            <button
              type="button"
              className={SETTINGS_CTA_DANGER}
              disabled={pending}
              aria-busy={pending}
              onClick={onConfirm}
              data-testid="settings-clear-yes"
            >
              {pending ? SETTINGS_COPY.clearing : SETTINGS_COPY.confirm}
            </button>
          </div>
        </div>
      ) : (
        <button
          ref={openRef}
          type="button"
          className={`${SETTINGS_CTA_EMERALD} w-full sm:w-auto sm:self-start`}
          onClick={() => setPhase("confirm")}
          data-testid="settings-clear"
        >
          {SETTINGS_COPY.clear}
        </button>
      )}
      {error ? (
        <Notice tone="error" data-testid="settings-clear-error">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}
