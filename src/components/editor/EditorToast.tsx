"use client";

// One-at-a-time editor toast (M5 Task 11), e.g. "Page 3 deleted · Undo".
//   showEditorToast({ message, action: { label: "Undo", run: actions.undo }, dismissOnEdit: true })
// Call it right AFTER ctx.actions.edit(...) in the same event handler. The toast disappears as soon
// as the doc changes again (another edit, header undo/redo) when either
//   - `doc` is given: the doc the edit produced — dismissed once state.doc !== doc, or
//   - `dismissOnEdit: true`: the doc on screen when the toast first renders is the snapshot,
// so its Undo can only ever undo the edit it announced. <EditorToastHost /> is mounted once by
// EditorShell.

import { X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { BookDoc } from "@/lib/book/types";
import { useEditor } from "./editor-context";

export const TOAST_DURATION_MS = 6000;

export interface EditorToast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
  /** Same as `action` (flat form). */
  actionLabel?: string;
  onAction?: () => void;
  /** The doc this toast is about: hidden as soon as the editor shows a different doc. */
  doc?: BookDoc;
  /** Without `doc`: hide when the doc changes after the toast appeared (default false). */
  dismissOnEdit?: boolean;
  durationMs?: number;
}

let current: EditorToast | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function showEditorToast(toast: Omit<EditorToast, "id">): number {
  const id = nextId++;
  const action =
    toast.action ?? (toast.actionLabel && toast.onAction ? { label: toast.actionLabel, run: toast.onAction } : undefined);
  current = { ...toast, action, id };
  emit();
  return id;
}

/** Dismiss the toast (only if it is still `id`, when given). */
export function dismissEditorToast(id?: number): void {
  if (current === null || (id !== undefined && current.id !== id)) return;
  current = null;
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getSnapshot = () => current;
const getServerSnapshot = () => null;

export function useEditorToast(): EditorToast | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function EditorToastHost() {
  const toast = useEditorToast();
  const { state } = useEditor();
  const doc = state.doc;
  const seen = useRef<{ id: number; doc: BookDoc } | null>(null);

  // Snapshot the doc when a toast appears; a later doc change dismisses dismissOnEdit toasts.
  useEffect(() => {
    if (!toast) {
      seen.current = null;
      return;
    }
    if (toast.doc !== undefined) {
      if (doc !== toast.doc) dismissEditorToast(toast.id);
      return;
    }
    if (seen.current?.id !== toast.id) {
      seen.current = { id: toast.id, doc };
      return;
    }
    if (toast.dismissOnEdit && doc !== seen.current.doc) dismissEditorToast(toast.id);
  }, [toast, doc]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => dismissEditorToast(toast.id), toast.durationMs ?? TOAST_DURATION_MS);
    return () => clearTimeout(t);
  }, [toast]);

  // Leaving the editor drops a pending toast.
  useEffect(() => () => dismissEditorToast(), []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-3"
    >
      {toast ? (
        <div
          className="pointer-events-auto flex w-full max-w-sm items-center gap-1 rounded-xl bg-neutral-900 py-1 pl-4 pr-1 text-sm text-white shadow-lg"
          data-testid="editor-toast"
        >
          <p className="min-w-0 flex-1 py-2">{toast.message}</p>
          {toast.action ? (
            <button
              type="button"
              onClick={() => {
                const run = toast.action?.run;
                dismissEditorToast(toast.id);
                run?.();
              }}
              className="min-h-11 shrink-0 rounded-lg px-3 font-semibold text-amber-300 hover:bg-white/10"
              data-testid="editor-toast-action"
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => dismissEditorToast(toast.id)}
            aria-label="Dismiss"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-white/10"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
