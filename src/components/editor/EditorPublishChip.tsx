"use client";

// Editor header chip (M6 T8, D-039): shown when the book is published and the saved doc moved past
// the live snapshot. Tapping it sends pending saves first (like Done), then opens the publish
// screen, where "Publish changes" snapshots the saved doc.

import { Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SaveState } from "./useAutosave";

export function EditorPublishChip({ bookId, settle }: { bookId: string; settle: () => Promise<SaveState> }) {
  const [target, setTarget] = useState<string | null>(null);
  const running = useRef(false);

  const onClick = async () => {
    if (running.current) return;
    running.current = true;
    try {
      await settle();
    } catch {
      // Navigate anyway: the publish screen reads the saved doc and shows what's live.
    }
    setTarget(`/books/${bookId}/publish`);
  };

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={target !== null}
        className="relative inline-flex shrink-0 items-center gap-1 self-start rounded-full before:absolute before:-inset-y-3 before:inset-x-0 before:content-[''] bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/15 disabled:opacity-60"
        data-testid="editor-publish-changes"
      >
        <Send className="size-3" aria-hidden="true" />
        Publish changes
      </button>
      {target ? <Navigate to={target} /> : null}
    </>
  );
}

/** Mounted only once a target exists, so the shell renders without an app router (tests). */
function Navigate({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.push(to);
  }, [router, to]);
  return null;
}
