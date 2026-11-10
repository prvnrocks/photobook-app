import { describe, expect, it } from "vitest";
import { addPage, deletePage, replacePhoto, setCaption, setCover, setCrop } from "@/lib/book/edit-ops";
import type { BookDoc, BookPage } from "@/lib/book/types";
import {
  canRedo,
  canUndo,
  clampPosition,
  editorReducer,
  HISTORY_CAP,
  initEditorState,
  itemToPosition,
  positionToItem,
  validSelection,
  type EditorAction,
  type EditorState,
} from "@/lib/editor/store";

const C = { x: 0.5, y: 0.5, zoom: 1 };
const pg = (id: string, layout: string, ids: (string | null)[], caption: BookPage["caption"] = null): BookPage => ({
  id,
  chapterId: null,
  layout,
  slots: ids.map((photoId) => ({ photoId, crop: { ...C } })),
  caption,
});

function base(): BookDoc {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: { layout: "cover", photoId: "ph1", title: "Weekend", subtitle: "Abu Dhabi" },
    chapters: [],
    pages: [
      pg("p1", "one-portrait", ["ph1"], { text: "Morning", font: "Playfair", align: "center", source: "ai" }),
      pg("p2", "two-vertical", ["ph2", "ph3"]),
      pg("p3", "full-page", ["ph4"]),
    ],
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "classic", font: "Playfair" },
  };
}

const run = (s: EditorState, ...actions: EditorAction[]) => actions.reduce(editorReducer, s);

describe("editor store — init & position", () => {
  it("starts on the cover with empty history", () => {
    const s = initEditorState(base());
    expect(s.page).toBe("cover");
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.selection).toBeNull();
    expect(canUndo(s)).toBe(false);
  });

  it("clamps positions to the doc", () => {
    const d = base();
    expect(clampPosition(d, -3)).toBe(0);
    expect(clampPosition(d, 99)).toBe(2);
    expect(clampPosition(d, 1.7)).toBe(1);
    expect(clampPosition(d, Number.NaN)).toBe("cover");
    expect(clampPosition({ ...d, pages: [] }, 0)).toBe("cover");
    expect(initEditorState(d, { page: 50 }).page).toBe(2);
  });

  it("maps carousel items to positions and back", () => {
    expect(positionToItem("cover")).toBe(0);
    expect(positionToItem(2)).toBe(3);
    expect(itemToPosition(0)).toBe("cover");
    expect(itemToPosition(-1)).toBe("cover");
    expect(itemToPosition(3)).toBe(2);
  });

  it("next/prev move through cover → pages and stop at the ends", () => {
    let s = initEditorState(base());
    s = run(s, { type: "prev" });
    expect(s.page).toBe("cover");
    s = run(s, { type: "next" }, { type: "next" }, { type: "next" }, { type: "next" }, { type: "next" });
    expect(s.page).toBe(2);
    s = run(s, { type: "prev" }, { type: "prev" }, { type: "prev" });
    expect(s.page).toBe("cover");
  });

  it("goTo to the current page returns the same state", () => {
    const s = initEditorState(base(), { page: 1 });
    expect(editorReducer(s, { type: "goTo", page: 1 })).toBe(s);
    expect(editorReducer(s, { type: "goTo", page: 7 }).page).toBe(2);
  });
});

describe("editor store — edits & history", () => {
  it("apply pushes the previous doc and clears redo", () => {
    const d = base();
    let s = initEditorState(d);
    s = run(s, { type: "apply", op: (x) => setCover(x, { title: "Trip" }) });
    expect(s.doc.cover.title).toBe("Trip");
    expect(s.past).toEqual([d]);
    s = run(s, { type: "undo" });
    expect(s.doc).toBe(d);
    expect(canRedo(s)).toBe(true);
    s = run(s, { type: "apply", op: (x) => setCover(x, { title: "Other" }) });
    expect(s.future).toEqual([]);
  });

  it("undo / redo walk the snapshots", () => {
    const d0 = base();
    let s = initEditorState(d0);
    s = run(s, { type: "apply", op: (x) => setCover(x, { title: "A" }) });
    const d1 = s.doc;
    s = run(s, { type: "apply", op: (x) => setCover(x, { title: "B" }) });
    const d2 = s.doc;
    s = run(s, { type: "undo" }, { type: "undo" });
    expect(s.doc).toBe(d0);
    expect(canUndo(s)).toBe(false);
    s = run(s, { type: "undo" }); // nothing left: same state
    expect(s.doc).toBe(d0);
    s = run(s, { type: "redo" });
    expect(s.doc).toBe(d1);
    s = run(s, { type: "redo" });
    expect(s.doc).toBe(d2);
    expect(canRedo(s)).toBe(false);
    expect(run(s, { type: "redo" })).toBe(s);
  });

  it("a no-op edit adds no history entry and returns the same state", () => {
    const s = initEditorState(base());
    const out = editorReducer(s, { type: "apply", op: (x) => setCover(x, { title: "Weekend" }) });
    expect(out).toBe(s);
    expect(out.past).toHaveLength(0);
  });

  it("caps history at HISTORY_CAP, dropping the oldest", () => {
    const d0 = base();
    let s = initEditorState(d0);
    for (let i = 0; i < HISTORY_CAP + 10; i++) {
      s = run(s, { type: "apply", op: (x) => setCover(x, { title: `T${i}` }) });
    }
    expect(s.past).toHaveLength(HISTORY_CAP);
    expect(s.past[0]).not.toBe(d0);
    expect(s.past[0].cover.title).toBe("T9");
  });

  it("coalesces edits with the same key into one undo entry", () => {
    const d0 = base();
    let s = initEditorState(d0, { page: 0 });
    for (const t of ["H", "He", "Hel", "Hello"]) {
      s = run(s, { type: "apply", op: (x) => setCaption(x, 0, t), coalesceKey: "caption:p1" });
    }
    expect(s.past).toHaveLength(1);
    expect(s.doc.pages[0].caption?.text).toBe("Hello");
    s = run(s, { type: "apply", op: (x) => setCrop(x, 0, 0, { zoom: 2 }), coalesceKey: "crop:p1:0" });
    expect(s.past).toHaveLength(2);
    s = run(s, { type: "undo" }, { type: "undo" });
    expect(s.doc).toBe(d0);
  });

  it("does not coalesce across an undo", () => {
    let s = initEditorState(base(), { page: 0 });
    s = run(s, { type: "apply", op: (x) => setCaption(x, 0, "A"), coalesceKey: "k" });
    s = run(s, { type: "undo" });
    s = run(s, { type: "apply", op: (x) => setCaption(x, 0, "B"), coalesceKey: "k" });
    expect(s.past).toHaveLength(1);
  });

  it("catches EditOpError into state.error without changing the doc", () => {
    const d = base();
    let s = initEditorState(d);
    s = run(s, { type: "apply", op: (x) => replacePhoto(x, 9, 0, "ph9") });
    expect(s.error).toBe("page_out_of_range");
    expect(s.doc).toBe(d);
    expect(s.past).toHaveLength(0);
    s = run(s, { type: "apply", op: (x) => addPage(x, 2, "one-portrait", 3) });
    expect(s.error).toBe("page_limit");
    s = run(s, { type: "dismissError" });
    expect(s.error).toBeNull();
  });

  it("rethrows non-EditOp errors (real bugs)", () => {
    const s = initEditorState(base());
    expect(() =>
      editorReducer(s, {
        type: "apply",
        op: () => {
          throw new TypeError("boom");
        },
      }),
    ).toThrow(TypeError);
  });

  it("ignores edits, undo and redo when read-only", () => {
    let s = initEditorState(base());
    s = run(s, { type: "apply", op: (x) => setCover(x, { title: "X" }) });
    s = run(s, { type: "setReadOnly", readOnly: true });
    const before = s;
    s = run(s, { type: "apply", op: (x) => setCover(x, { title: "Y" }) }, { type: "undo" }, { type: "redo" });
    expect(s).toBe(before);
    expect(canUndo(s)).toBe(false);
    // Navigation still works.
    expect(run(s, { type: "next" }).page).toBe(0);
  });

  it("apply can move to a new page (goTo) — e.g. after addPage", () => {
    let s = initEditorState(base(), { page: 0 });
    s = run(s, { type: "apply", op: (x) => addPage(x, 0), goTo: 1 });
    expect(s.doc.pages).toHaveLength(4);
    expect(s.page).toBe(1);
  });
});

describe("editor store — page index clamping & selection", () => {
  it("clamps the page when the last page is deleted", () => {
    let s = initEditorState(base(), { page: 2 });
    s = run(s, { type: "apply", op: (x) => deletePage(x, 2) });
    expect(s.page).toBe(1);
  });

  it("falls back to the cover when all pages are gone", () => {
    let s = initEditorState({ ...base(), pages: [pg("p1", "full-page", ["ph1"])] }, { page: 0 });
    s = run(s, { type: "apply", op: (x) => deletePage(x, 0) });
    expect(s.page).toBe("cover");
  });

  it("re-clamps after undo/redo change the page count", () => {
    let s = initEditorState(base(), { page: 2 });
    s = run(s, { type: "apply", op: (x) => addPage(x, 2), goTo: 3 });
    expect(s.page).toBe(3);
    s = run(s, { type: "undo" });
    expect(s.page).toBe(2);
  });

  it("select moves to the selection's page; goTo elsewhere clears it", () => {
    let s = initEditorState(base());
    s = run(s, { type: "select", selection: { kind: "slot", pageIdx: 1, slotIdx: 1 } });
    expect(s.page).toBe(1);
    expect(s.selection).toEqual({ kind: "slot", pageIdx: 1, slotIdx: 1 });
    s = run(s, { type: "goTo", page: 2 });
    expect(s.selection).toBeNull();
    s = run(s, { type: "select", selection: { kind: "cover", part: "photo" } });
    expect(s.page).toBe("cover");
  });

  it("rejects selections that point at nothing", () => {
    const d = base();
    expect(validSelection(d, { kind: "slot", pageIdx: 1, slotIdx: 5 })).toBeNull();
    expect(validSelection(d, { kind: "slot", pageIdx: 8, slotIdx: 0 })).toBeNull();
    // full-page has no caption area
    expect(validSelection(d, { kind: "caption", pageIdx: 2 })).toBeNull();
    expect(validSelection(d, { kind: "caption", pageIdx: 0 })).toEqual({ kind: "caption", pageIdx: 0 });
    const s = initEditorState(d);
    expect(run(s, { type: "select", selection: { kind: "caption", pageIdx: 2 } }).selection).toBeNull();
  });

  it("drops a selection whose page was deleted", () => {
    let s = initEditorState(base());
    s = run(s, { type: "select", selection: { kind: "slot", pageIdx: 2, slotIdx: 0 } });
    s = run(s, { type: "apply", op: (x) => deletePage(x, 2) });
    expect(s.selection).toBeNull();
    expect(s.page).toBe(1);
  });

  it("keeps a valid selection across an edit and accepts a new one from apply", () => {
    let s = initEditorState(base());
    s = run(s, { type: "select", selection: { kind: "slot", pageIdx: 1, slotIdx: 0 } });
    s = run(s, { type: "apply", op: (x) => replacePhoto(x, 1, 0, "ph9") });
    expect(s.selection).toEqual({ kind: "slot", pageIdx: 1, slotIdx: 0 });
    s = run(s, {
      type: "apply",
      op: (x) => replacePhoto(x, 0, 0, "ph8"),
      select: { kind: "slot", pageIdx: 0, slotIdx: 0 },
    });
    expect(s.page).toBe(0);
    expect(s.selection).toEqual({ kind: "slot", pageIdx: 0, slotIdx: 0 });
  });

  it("reset replaces the doc and clears history", () => {
    let s = initEditorState(base(), { page: 2 });
    s = run(s, { type: "apply", op: (x) => setCover(x, { title: "Z" }) });
    const fresh = { ...base(), pages: base().pages.slice(0, 1) };
    s = run(s, { type: "reset", doc: fresh });
    expect(s.doc).toBe(fresh);
    expect(s.past).toEqual([]);
    expect(s.page).toBe(0);
  });
});
