"use client";

// Wires the pure AutosaveScheduler (src/lib/editor/autosave.ts) to React and the page lifecycle:
// - every new doc from the store → scheduler.change(doc) (2 s debounce, one PUT in flight)
// - tab hidden / pagehide / unmount (client navigation) → flush with fetch keepalive (< 60 KB)
// - back online → flush (skips the remaining backoff)
// - beforeunload while something is unsaved → browser "leave page?" prompt
// No dispose on unmount: React StrictMode mounts twice in dev, and a pending save should still
// go out after navigating away.

import { useCallback, useEffect, useState } from "react";
import type { BookDoc } from "@/lib/book/types";
import { AutosaveScheduler, type AutosaveStatus } from "@/lib/editor/autosave";
import type { EditorTransport } from "@/lib/editor/transport";

export type SaveState = AutosaveStatus | { kind: "readOnly" };

export function useAutosave(opts: {
  doc: BookDoc;
  /** books.doc_rev at load; null → saving unavailable (read-only, no requests). */
  baseRev: number | null;
  enabled: boolean;
  transport: EditorTransport;
}): { status: SaveState; flush: () => void; hasUnsaved: () => boolean } {
  const { doc, baseRev, enabled, transport } = opts;
  const [status, setStatus] = useState<SaveState>(() =>
    enabled && baseRev !== null ? { kind: "idle" } : { kind: "readOnly" },
  );
  // Created once with the doc as loaded (= saved at baseRev).
  const [scheduler] = useState(() =>
    enabled && baseRev !== null
      ? new AutosaveScheduler({
          baseRev,
          savedDoc: doc,
          send: (d, rev, o) => transport.save(d, rev, o),
          onStatus: setStatus,
        })
      : null,
  );

  useEffect(() => {
    scheduler?.change(doc);
  }, [scheduler, doc]);

  useEffect(() => {
    if (!scheduler) return;
    const flushKeepalive = () => void scheduler.flush({ keepalive: true });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushKeepalive();
    };
    const onOnline = () => void scheduler.flush();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!scheduler.hasUnsaved()) return;
      flushKeepalive();
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flushKeepalive);
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flushKeepalive);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("beforeunload", onBeforeUnload);
      // Unmount (e.g. back link): send what's pending now instead of after the debounce.
      flushKeepalive();
    };
  }, [scheduler]);

  const flush = useCallback(() => void scheduler?.flush(), [scheduler]);
  const hasUnsaved = useCallback(() => scheduler?.hasUnsaved() ?? false, [scheduler]);
  return { status, flush, hasUnsaved };
}
