// Editor state (M5 Task 8): a pure reducer over the edit ops in src/lib/book/edit-ops.ts.
// No React here — `useEditorStore` (src/components/editor) wraps it in useReducer, and the
// tests drive it directly in node.
//
// - History: undo/redo stacks of whole doc snapshots (ops share untouched pages by reference,
//   so a snapshot is cheap). Capped at HISTORY_CAP; a no-op (op returns the same doc) pushes
//   nothing. Consecutive edits with the same `coalesceKey` (caption typing, crop drags) share
//   ONE undo entry.
// - Position: `page` is what the carousel shows — "cover" or an index into doc.pages — and is
//   clamped after every change. `selection` is dropped when it no longer points at something.
// - Ops throw EditOpError for UI bugs / limits; the reducer catches it into `error` (a stable
//   code, never user data) so a reducer never throws.

import { EditOpError, type EditOpErrorCode } from "@/lib/book/edit-ops";
import { getLayout } from "@/lib/layouts";
import type { BookDoc } from "@/lib/book/types";

export const HISTORY_CAP = 50;

/** What the carousel shows: the cover or an index into doc.pages. */
export type EditorPosition = "cover" | number;

export type EditorSelection =
  | { kind: "slot"; pageIdx: number; slotIdx: number }
  | { kind: "caption"; pageIdx: number }
  | { kind: "cover"; part: "photo" | "text" }
  | null;

export type SelectionKind = "none" | "slot" | "caption" | "cover";

/** An edit: a pure function of the doc, normally a call into src/lib/book/edit-ops.ts. */
export type EditOp = (doc: BookDoc) => BookDoc;

export interface EditorState {
  doc: BookDoc;
  past: BookDoc[];
  future: BookDoc[];
  page: EditorPosition;
  selection: EditorSelection;
  /** True when edits are not allowed (no saving, conflict, signed out…). `apply` is ignored. */
  readOnly: boolean;
  /** Last EditOpError code (cleared by the next successful edit / undo / redo / dismissError). */
  error: EditOpErrorCode | null;
  /** coalesceKey of the last applied edit (null after undo/redo/select/navigation). */
  lastCoalesceKey: string | null;
}

export type EditorAction =
  | { type: "apply"; op: EditOp; coalesceKey?: string; select?: EditorSelection; goTo?: EditorPosition }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "goTo"; page: EditorPosition }
  | { type: "next" }
  | { type: "prev" }
  | { type: "select"; selection: EditorSelection }
  | { type: "setReadOnly"; readOnly: boolean }
  | { type: "dismissError" }
  /** Replace the doc and clear history (e.g. after loading a newer revision). */
  | { type: "reset"; doc: BookDoc };

export function initEditorState(doc: BookDoc, opts: { readOnly?: boolean; page?: EditorPosition } = {}): EditorState {
  return {
    doc,
    past: [],
    future: [],
    page: clampPosition(doc, opts.page ?? "cover"),
    selection: null,
    readOnly: opts.readOnly === true,
    error: null,
    lastCoalesceKey: null,
  };
}

// ---- position / selection helpers --------------------------------------------------------------

/** Clamp a position to the doc: indexes into [0, pages-1]; a book without pages shows the cover. */
export function clampPosition(doc: BookDoc, page: EditorPosition): EditorPosition {
  if (page === "cover") return "cover";
  const n = doc.pages.length;
  if (n === 0 || !Number.isFinite(page)) return "cover";
  return Math.min(Math.max(Math.trunc(page), 0), n - 1);
}

/** Carousel item index: 0 = cover, i + 1 = doc.pages[i]. */
export function positionToItem(page: EditorPosition): number {
  return page === "cover" ? 0 : page + 1;
}

export function itemToPosition(item: number): EditorPosition {
  return item <= 0 ? "cover" : item - 1;
}

export function selectionKind(selection: EditorSelection): SelectionKind {
  return selection === null ? "none" : selection.kind;
}

/** The selection if it still points at something in `doc`, else null. */
export function validSelection(doc: BookDoc, selection: EditorSelection): EditorSelection {
  if (selection === null || selection.kind === "cover") return selection;
  const page = doc.pages[selection.pageIdx];
  if (!page) return null;
  if (selection.kind === "slot") {
    return selection.slotIdx >= 0 && selection.slotIdx < page.slots.length ? selection : null;
  }
  return getLayout(page.layout)?.caption ? selection : null;
}

/** The position a selection lives on. */
export function selectionPosition(selection: EditorSelection): EditorPosition | null {
  if (selection === null) return null;
  return selection.kind === "cover" ? "cover" : selection.pageIdx;
}

function samePosition(a: EditorPosition, b: EditorPosition) {
  return a === b;
}

/** After the doc changed: clamp the position, drop a dangling selection. */
function settle(state: EditorState, doc: BookDoc, page: EditorPosition, selection: EditorSelection): EditorState {
  const pos = clampPosition(doc, page);
  let sel = validSelection(doc, selection);
  const selPos = selectionPosition(sel);
  if (selPos !== null && !samePosition(selPos, pos)) sel = null;
  return { ...state, doc, page: pos, selection: sel };
}

function pushPast(past: BookDoc[], doc: BookDoc): BookDoc[] {
  const next = past.length >= HISTORY_CAP ? past.slice(past.length - HISTORY_CAP + 1) : past.slice();
  next.push(doc);
  return next;
}

// ---- reducer -----------------------------------------------------------------------------------

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "apply": {
      if (state.readOnly) return state;
      let doc: BookDoc;
      try {
        doc = action.op(state.doc);
      } catch (err) {
        if (err instanceof EditOpError) {
          return state.error === err.code ? state : { ...state, error: err.code, lastCoalesceKey: null };
        }
        throw err;
      }
      const selection = action.select !== undefined ? action.select : state.selection;
      const page =
        action.goTo ?? (action.select !== undefined ? selectionPosition(action.select) : null) ?? state.page;
      if (doc === state.doc) {
        // No-op: no history entry, but honour navigation/selection requests.
        const settled = settle(state, doc, page, selection);
        const unchanged =
          settled.page === state.page && settled.selection === state.selection && state.error === null;
        return unchanged ? state : { ...settled, error: null };
      }
      const key = action.coalesceKey ?? null;
      const coalesce = key !== null && key === state.lastCoalesceKey && state.past.length > 0;
      const past = coalesce ? state.past : pushPast(state.past, state.doc);
      return { ...settle(state, doc, page, selection), past, future: [], error: null, lastCoalesceKey: key };
    }
    case "undo": {
      if (state.readOnly || state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      const future = [state.doc, ...state.future].slice(0, HISTORY_CAP);
      return {
        ...settle(state, prev, state.page, state.selection),
        past: state.past.slice(0, -1),
        future,
        error: null,
        lastCoalesceKey: null,
      };
    }
    case "redo": {
      if (state.readOnly || state.future.length === 0) return state;
      const [next, ...future] = state.future;
      return {
        ...settle(state, next, state.page, state.selection),
        past: pushPast(state.past, state.doc),
        future,
        error: null,
        lastCoalesceKey: null,
      };
    }
    case "goTo": {
      const page = clampPosition(state.doc, action.page);
      if (samePosition(page, state.page)) return state;
      // Leaving a page drops a selection on it.
      return { ...state, page, selection: null, lastCoalesceKey: null };
    }
    case "next":
    case "prev": {
      const item = positionToItem(state.page) + (action.type === "next" ? 1 : -1);
      return editorReducer(state, { type: "goTo", page: itemToPosition(item) });
    }
    case "select": {
      const sel = validSelection(state.doc, action.selection);
      const pos = selectionPosition(sel);
      const page = pos === null ? state.page : clampPosition(state.doc, pos);
      if (sel === state.selection && page === state.page) return state;
      return { ...state, selection: sel, page, lastCoalesceKey: null };
    }
    case "setReadOnly":
      return state.readOnly === action.readOnly ? state : { ...state, readOnly: action.readOnly, lastCoalesceKey: null };
    case "dismissError":
      return state.error === null ? state : { ...state, error: null };
    case "reset":
      return initEditorState(action.doc, { readOnly: state.readOnly, page: state.page });
  }
}

export const canUndo = (s: EditorState) => !s.readOnly && s.past.length > 0;
export const canRedo = (s: EditorState) => !s.readOnly && s.future.length > 0;

/** Friendly copy for EditOpError codes (shown in the editor's error line). */
export const EDIT_ERROR_COPY: Record<EditOpErrorCode, string> = {
  page_out_of_range: "That page no longer exists.",
  slot_out_of_range: "That photo spot no longer exists.",
  unknown_layout: "That layout isn't available.",
  not_a_page_layout: "That layout can't be used on a page.",
  unknown_chapter: "That chapter no longer exists.",
  no_caption_area: "This layout has no room for a caption. Pick a layout with a caption first.",
  page_limit: "You've reached the page limit for this book.",
};
