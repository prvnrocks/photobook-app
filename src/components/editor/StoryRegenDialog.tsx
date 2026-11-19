"use client";

// "Regenerate story" (Task 8): the whole storybook job again, from inside the editor. A dialog over
// the editor (bottom sheet on phones) with the same four real stages as the wizard (StoryProgress);
// the editor is read-only while the job runs, so nothing typed can be lost to it.
//   1. pending edits are saved first (settle) — the job must merge with what the user really has
//   2. the job runs (useStoryRun: start once, resumable ticks, Stop / Try again); a refresh while it
//      runs re-opens this dialog on the running job (EditorShell reads data.story.latest)
//   3. done → the composed doc is read back and applied as ONE edit (autosave adopts the server rev
//      first), so Undo puts the previous version back and the next save stores that
// The user's own texts, photos and crops survive the job byte-identical (Task 6 mergeAiDraft +
// Task 7 mergeComposition); this dialog only moves the result into the editor.
// Lazy: loaded with next/dynamic only when opened.

import { useEffect, useRef, useState } from "react";
import { StoryProgress } from "@/components/story/StoryProgress";
import { useStoryRun } from "@/components/story/useStoryRun";
import { fetchStoryDoc } from "@/lib/editor/story-actions";
import type { StoryRunView } from "@/lib/storybook/run/progress";
import { useEditor } from "./editor-context";
import { showEditorToast } from "./EditorToast";
import { TOOL_SECONDARY } from "./tools/tool-classes";

export type StoryRegenDialogProps = {
  bookId: string;
  /** A regeneration still running (refresh) — followed instead of starting a new one. */
  initial: StoryRunView | null;
  onClose: () => void;
};

export default function StoryRegenDialog({ bookId, initial, onClose }: StoryRegenDialogProps) {
  const ctx = useEditor();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const [ready, setReady] = useState(initial !== null);
  const [problem, setProblem] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    const c = ctxRef.current;
    c.actions.setReadOnly(true);
    if (initial) return;
    let alive = true;
    void (async () => {
      const s = c.save.settle ? await c.save.settle() : null;
      if (!alive) return;
      if (s && s.kind !== "saved" && s.kind !== "idle") {
        c.actions.setReadOnly(false);
        setProblem("Your latest changes couldn't be saved, so the story wasn't regenerated. Check your connection and try again.");
        return;
      }
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [initial]);

  const close = () => {
    ctxRef.current.actions.setReadOnly(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 md:items-center" data-testid="story-regen-dialog">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="story-regen-title"
        className="flex max-h-[88dvh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-t-3xl bg-background p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-card md:rounded-3xl"
      >
        <h2 id="story-regen-title" ref={headingRef} tabIndex={-1} className="type-h2 text-heading outline-none">
          Your memories are becoming a story.
        </h2>
        {problem ? (
          <>
            <p className="type-small text-foreground" role="alert">
              {problem}
            </p>
            <button type="button" className={TOOL_SECONDARY} onClick={close} data-testid="story-regen-close">
              Close
            </button>
          </>
        ) : ready ? (
          <RegenRun bookId={bookId} initial={initial} onClose={close} />
        ) : (
          <p className="type-small text-muted-foreground" role="status">
            Saving your changes first…
          </p>
        )}
      </div>
    </div>
  );
}

function RegenRun({ bookId, initial, onClose }: { bookId: string; initial: StoryRunView | null; onClose: () => void }) {
  const ctx = useEditor();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const { phase, busy, stop, tryAgain } = useStoryRun({ bookId, initial, autoStart: true });
  const appliedRef = useRef(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    if (phase.kind !== "done" || appliedRef.current) return;
    appliedRef.current = true;
    void (async () => {
      const fresh = await fetchStoryDoc(bookId);
      const c = ctxRef.current;
      if (!fresh) {
        setApplyError("Your new story is saved, but we couldn't load it here. Reload the page to see it.");
        return;
      }
      c.actions.setReadOnly(false);
      if (!c.save.adopt || !c.save.adopt(fresh.doc, fresh.rev)) {
        // something unsaved appeared meanwhile: the safe path is a reload of the saved book
        window.location.reload();
        return;
      }
      c.actions.edit(() => fresh.doc, { goTo: "cover" });
      showEditorToast({ message: "Story regenerated — your own edits were kept", action: { label: "Undo", run: c.actions.undo }, doc: fresh.doc });
      onClose();
    })();
  }, [phase.kind, bookId, onClose]);

  const finished = phase.kind === "stopped" || phase.kind === "error";
  return (
    <>
      <StoryProgress phase={phase} busy={busy} onStop={stop} onTryAgain={tryAgain} keepOpenNote="Your book is locked while we work — your own changes stay as they are." />
      {applyError ? (
        <p className="type-small text-foreground" role="alert">
          {applyError}
        </p>
      ) : null}
      {finished || applyError ? (
        <button type="button" className={TOOL_SECONDARY} onClick={onClose} data-testid="story-regen-close">
          Back to my book
        </button>
      ) : null}
    </>
  );
}
