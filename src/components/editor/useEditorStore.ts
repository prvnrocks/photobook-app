"use client";

// React wrapper around the pure editor reducer (src/lib/editor/store.ts).
// `actions` is stable for the component's lifetime — safe in effect deps and tool registries.

import { useMemo, useReducer } from "react";
import type { BookDoc } from "@/lib/book/types";
import {
  editorReducer,
  initEditorState,
  type EditOp,
  type EditorAction,
  type EditorPosition,
  type EditorSelection,
  type EditorState,
} from "@/lib/editor/store";

export interface EditOptions {
  /** Consecutive edits with the same key share one undo entry (typing, dragging). */
  coalesceKey?: string;
  /** Selection after the edit (e.g. keep the replaced slot selected). */
  select?: EditorSelection;
  /** Position after the edit (e.g. jump to a newly added page). */
  goTo?: EditorPosition;
}

export interface EditorActions {
  /**
   * Apply an edit op: `edit((d) => replacePhoto(d, pageIdx, slotIdx, photoId))`.
   * Ignored when read-only; an EditOpError ends up in state.error; a no-op adds no undo entry.
   */
  edit(op: EditOp, opts?: EditOptions): void;
  undo(): void;
  redo(): void;
  goTo(page: EditorPosition): void;
  next(): void;
  prev(): void;
  select(selection: EditorSelection): void;
  setReadOnly(readOnly: boolean): void;
  dismissError(): void;
  /** Replace the doc and clear history. */
  reset(doc: BookDoc): void;
}

export function useEditorStore(
  doc: BookDoc,
  opts: { readOnly?: boolean } = {},
): { state: EditorState; actions: EditorActions; dispatch: (a: EditorAction) => void } {
  const [state, dispatch] = useReducer(editorReducer, doc, (d) => initEditorState(d, { readOnly: opts.readOnly }));
  const actions = useMemo<EditorActions>(
    () => ({
      edit: (op, o = {}) => dispatch({ type: "apply", op, ...o }),
      undo: () => dispatch({ type: "undo" }),
      redo: () => dispatch({ type: "redo" }),
      goTo: (page) => dispatch({ type: "goTo", page }),
      next: () => dispatch({ type: "next" }),
      prev: () => dispatch({ type: "prev" }),
      select: (selection) => dispatch({ type: "select", selection }),
      setReadOnly: (readOnly) => dispatch({ type: "setReadOnly", readOnly }),
      dismissError: () => dispatch({ type: "dismissError" }),
      reset: (d) => dispatch({ type: "reset", doc: d }),
    }),
    [],
  );
  return { state, actions, dispatch };
}
