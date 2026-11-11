"use client";

// Editor header "Done" (M5 Task 12): flush + await pending saves, then finishEditingAction (T13,
// Memory Keeper) and navigate to its redirectTo. Decisions live in src/lib/editor/done.ts.
// - read-only (conflict / saving unavailable): straight to the dashboard;
// - signed out: /login?next=/books/<id>/edit;
// - still unsaved (offline) or the action failed: stay, show a retry message.

import { Check, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { doneStepAfterFinish, doneStepAfterSave, type DoneStep, type FinishResult } from "@/lib/editor/done";
import type { SaveState } from "./useAutosave";

export type EditorDoneButtonProps = {
  bookId: string;
  /** useAutosave().settle */
  settle: () => Promise<SaveState>;
  /** Bound finishEditingAction; absent (dev fixture) → navigate to `fallbackHref` after saving. */
  finish?: () => Promise<FinishResult>;
  fallbackHref: string;
};

const ERROR_MS = 6000;

export function EditorDoneButton({ bookId, settle, finish, fallbackHref }: EditorDoneButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), ERROR_MS);
    return () => clearTimeout(t);
  }, [error]);

  const onDone = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    let step: DoneStep;
    try {
      step = doneStepAfterSave(await settle(), bookId);
      if (step.kind === "finish") {
        if (!finish) {
          step = { kind: "navigate", to: fallbackHref };
        } else {
          let r: FinishResult | null = null;
          try {
            r = await finish();
          } catch {
            r = null;
          }
          step = doneStepAfterFinish(r, bookId);
        }
      }
    } catch {
      step = doneStepAfterFinish(null, bookId);
    }
    if (step.kind === "navigate") {
      setTarget(step.to); // stays busy until the page changes
      return;
    }
    if (step.kind === "error") setError(step.message);
    running.current = false;
    setBusy(false);
  }, [settle, finish, bookId, fallbackHref]);

  return (
    <>
      <button
        type="button"
        onClick={onDone}
        disabled={busy}
        aria-busy={busy}
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg bg-primary ps-3 pe-3.5 text-sm font-medium text-primary-foreground shadow-card outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-70"
        data-testid="editor-done"
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Check className="size-4" aria-hidden="true" />}
        Done
      </button>
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center px-4">
        {error ? (
          <p
            className="pointer-events-auto max-w-sm rounded-xl bg-primary px-4 py-3 text-sm text-primary-foreground shadow-lift"
            data-testid="editor-done-error"
          >
            {error}
          </p>
        ) : null}
      </div>
      {target ? <Navigate to={target} /> : null}
    </>
  );
}

/** Mounted only after Done decides where to go, so the shell renders without an app router (tests). */
function Navigate({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.push(to);
  }, [router, to]);
  return null;
}
