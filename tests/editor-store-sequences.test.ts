// M5 T14 (tester): editor store + edit-ops integration sequences. Drives the pure reducer the
// way the UI tools do (same ops, same select/goTo options) and checks history, position and
// that every intermediate doc would pass the server's save validation.
import { describe, expect, it } from "vitest";
import {
  addPage,
  changeLayout,
  deletePage,
  movePage,
  movePageToChapter,
  replacePhoto,
  setCaption,
  setCover,
  setCrop,
  usedPhotoIds,
} from "@/lib/book/edit-ops";
import { devPreviewDoc } from "@/lib/book/dev-preview";
import type { BookDoc } from "@/lib/book/types";
import { validateEditorDoc } from "@/lib/book/validate-editor-doc";
import { addPageDecision, movePageById, positionAfterMove } from "@/lib/editor/pages";
import { editorReducer, initEditorState, type EditOp, type EditorAction, type EditorState } from "@/lib/editor/store";
import { LAYOUTS } from "@/lib/layouts";

const PHOTO_IDS = new Set(Array.from({ length: 16 }, (_, i) => `d${i}`));

function chaptered(): BookDoc {
  const d = devPreviewDoc();
  return {
    ...d,
    chapters: [
      { id: "c1", title: "Arrival", dateLabel: "Fri", place: null },
      { id: "c2", title: "Dinner", dateLabel: "Fri", place: null },
      { id: "c3", title: "Party", dateLabel: "Sat", place: null },
    ],
    pages: d.pages.map((p, i) => ({ ...p, chapterId: i < 2 ? "c1" : i < 5 ? "c2" : "c3" })),
  };
}

function run(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}
const apply = (op: EditOp, extra: Partial<Extract<EditorAction, { type: "apply" }>> = {}): EditorAction => ({
  type: "apply",
  op,
  ...extra,
});
const ids = (d: BookDoc) => d.pages.map((p) => p.id);
const valid = (d: BookDoc, maxPages = 20) => validateEditorDoc(d, { photoIds: PHOTO_IDS, maxPages, savedDoc: d });

describe("add → move → delete → undo/redo", () => {
  it("three undos return the exact original doc; three redos the final one", () => {
    const doc0 = chaptered();
    let s = initEditorState(doc0, { page: 1 });
    // Add after page 2 (index 1), as the Add page tool does, and go to the new page.
    const decision = addPageDecision(s.doc, { isPaid: false, maxPages: 20 }, s.page);
    expect(decision).toEqual({ kind: "add", afterIdx: 1 });
    s = run(s, apply((d) => addPage(d, 1, "one-portrait", 20), { goTo: 2 }));
    const newId = s.doc.pages[2].id;
    expect(s.page).toBe(2);
    expect(s.doc.pages[2].chapterId).toBe("c1"); // takes the chapter of the page before it
    // Move it to the end (Pages sheet drop) — follows the page.
    const from = 2;
    const to = s.doc.pages.length - 1;
    s = run(s, apply((d) => movePageById(d, newId, d.pages[to].id), { goTo: positionAfterMove(s.page, from, to) }));
    expect(s.doc.pages[to].id).toBe(newId);
    expect(s.page).toBe(to);
    expect(s.doc.pages[to].chapterId).toBe("c3");
    // Delete it.
    s = run(s, apply((d) => deletePage(d, to), { select: null }));
    const final = s.doc;
    expect(ids(final)).toEqual(ids(doc0));
    expect(s.past).toHaveLength(3);
    expect(s.page).toBe(to - 1); // clamped

    const back = run(s, { type: "undo" }, { type: "undo" }, { type: "undo" });
    expect(back.doc).toBe(doc0);
    expect(back.future).toHaveLength(3);
    const fwd = run(back, { type: "redo" }, { type: "redo" }, { type: "redo" });
    expect(fwd.doc).toBe(final);
  });

  it("delete page 4 → toast Undo (undo + goTo idx) lands on the restored page", () => {
    const doc0 = chaptered();
    let s = initEditorState(doc0, { page: 3 });
    const deletedId = s.doc.pages[3].id;
    s = run(s, apply((d) => deletePage(d, 3), { select: null }));
    expect(s.doc.pages.some((p) => p.id === deletedId)).toBe(false);
    s = run(s, { type: "undo" }, { type: "goTo", page: 3 });
    expect(s.doc.pages[s.page as number].id).toBe(deletedId);
  });

  it("delete the LAST page → toast Undo still lands on it; plain header undo stays one page earlier", () => {
    const doc0 = chaptered();
    const last = doc0.pages.length - 1;
    let s = initEditorState(doc0, { page: last });
    s = run(s, apply((d) => deletePage(d, last), { select: null }));
    expect(s.page).toBe(last - 1);
    const headerUndo = run(s, { type: "undo" });
    expect(headerUndo.doc).toBe(doc0);
    // Documented behaviour (not a bug): the store keeps the clamped position.
    expect(headerUndo.page).toBe(last - 1);
    const toastUndo = run(s, { type: "undo" }, { type: "goTo", page: last });
    expect(toastUndo.page).toBe(last);
  });

  it("deleting the only page of a chapter prunes it; undo brings the chapter back", () => {
    const doc0 = chaptered();
    // Put page 0 alone in c1 by moving page 1 into c2.
    let s = initEditorState(doc0);
    s = run(s, apply((d) => movePageToChapter(d, 1, "c2")));
    expect(s.doc.pages.filter((p) => p.chapterId === "c1")).toHaveLength(1);
    s = run(s, apply((d) => deletePage(d, 0)));
    expect(s.doc.chapters.map((c) => c.id)).toEqual(["c2", "c3"]);
    s = run(s, { type: "undo" });
    expect(s.doc.chapters.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(valid(s.doc).ok).toBe(true);
  });
});

describe("free limit in the store", () => {
  it("at 20 pages: Add page decision is upgrade, a forced addPage records page_limit with no history", () => {
    let d = devPreviewDoc();
    while (d.pages.length < 20) d = addPage(d, d.pages.length - 1, "one-portrait", 20);
    const s0 = initEditorState(d, { page: 19 });
    expect(addPageDecision(d, { isPaid: false, maxPages: 20 }, 19)).toEqual({ kind: "upgrade" });
    expect(addPageDecision(d, { isPaid: true, maxPages: 100 }, 19)).toEqual({ kind: "add", afterIdx: 19 });
    const s1 = run(s0, apply((x) => addPage(x, 19, "one-portrait", 20)));
    expect(s1.doc).toBe(d);
    expect(s1.error).toBe("page_limit");
    expect(s1.past).toHaveLength(0);
    // Delete one → add works again → back to 20, never 21.
    const s2 = run(s1, apply((x) => deletePage(x, 0)), apply((x) => addPage(x, 18, "one-portrait", 20)));
    expect(s2.doc.pages).toHaveLength(20);
    expect(s2.error).toBeNull();
    expect(valid(s2.doc).ok).toBe(true);
  });

  it("paid book at 100 → full", () => {
    let d = devPreviewDoc();
    while (d.pages.length < 100) d = addPage(d, d.pages.length - 1, "one-portrait", 100);
    expect(addPageDecision(d, { isPaid: true, maxPages: 100 }, 0)).toEqual({ kind: "full" });
  });
});

describe("photos, layout, captions, crop through the store", () => {
  it("layout change drops photos (unused), undo restores layout, photos and caption", () => {
    const doc0 = devPreviewDoc();
    const idx = doc0.pages.findIndex((p) => p.layout === "four-grid");
    let s = initEditorState(doc0, { page: idx });
    let removed: string[] = [];
    s = run(
      s,
      apply((d) => {
        const r = changeLayout(d, idx, "full-page");
        removed = r.removedPhotoIds;
        return r.doc;
      }),
    );
    expect(s.doc.pages[idx].layout).toBe("full-page");
    expect(removed).toHaveLength(3);
    for (const id of removed) expect(usedPhotoIds(s.doc).has(id)).toBe(false);
    expect(valid(s.doc).ok).toBe(true);
    s = run(s, { type: "undo" });
    expect(s.doc).toBe(doc0);
  });

  it("caption typing coalesces into one entry; a following page add is undone separately", () => {
    const doc0 = devPreviewDoc();
    const idx = doc0.pages.findIndex((p) => p.caption);
    let s = initEditorState(doc0, { page: idx });
    s = run(s, { type: "select", selection: { kind: "caption", pageIdx: idx } });
    for (const t of ["غ", "غر", "غرو", "غروب"]) s = run(s, apply((d) => setCaption(d, idx, t), { coalesceKey: `caption:${idx}` }));
    expect(s.past).toHaveLength(1);
    expect(s.doc.pages[idx].caption).toMatchObject({ text: "غروب", source: "user" });
    s = run(s, apply((d) => addPage(d, idx, "one-portrait", 20), { goTo: idx + 1 }));
    expect(s.past).toHaveLength(2);
    s = run(s, { type: "undo" });
    expect(s.doc.pages[idx].caption?.text).toBe("غروب");
    s = run(s, { type: "undo" });
    expect(s.doc).toBe(doc0);
  });

  it("crop drag (coalesced) + zoom (coalesced) = 2 undo steps; values stay in schema bounds", () => {
    const doc0 = devPreviewDoc();
    let s = initEditorState(doc0, { page: 1 });
    for (let i = 1; i <= 10; i++) s = run(s, apply((d) => setCrop(d, 1, 0, { x: 0.5 - i * 0.2 }), { coalesceKey: "crop:1:0:drag" }));
    for (let z = 1; z <= 6; z++) s = run(s, apply((d) => setCrop(d, 1, 0, { zoom: z }), { coalesceKey: "crop:1:0:zoom" }));
    expect(s.past).toHaveLength(2);
    expect(s.doc.pages[1].slots[0].crop).toEqual({ x: 0, y: 0.5, zoom: 4 });
    expect(valid(s.doc).ok).toBe(true);
    expect(run(s, { type: "undo" }, { type: "undo" }).doc).toBe(doc0);
  });

  it("swap via replacePhoto keeps the set of placed photos; placing a dropped photo frees the old one", () => {
    const doc0 = devPreviewDoc();
    const before = usedPhotoIds(doc0, { includeCover: false });
    const target = doc0.pages[3].slots[0].photoId!;
    let s = initEditorState(doc0);
    s = run(s, apply((d) => replacePhoto(d, 0, 0, target)));
    expect(usedPhotoIds(s.doc, { includeCover: false })).toEqual(before);
    s = run(s, apply((d) => replacePhoto(d, 0, 0, "d14"))); // AI-dropped photo
    const after = usedPhotoIds(s.doc, { includeCover: false });
    expect(after.has("d14")).toBe(true);
    expect(after.has(target)).toBe(false);
    expect(valid(s.doc).ok).toBe(true);
  });
});

describe("random edit walks (seeded) stay saveable and fully undoable", () => {
  function rng(seed: number) {
    let x = seed >>> 0;
    return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  }
  const pageLayouts = LAYOUTS.filter((l) => l.role === "page").map((l) => l.id);

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: 60 ops → every doc passes validateEditorDoc; undo to start`, () => {
      const r = rng(seed);
      const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
      const doc0 = chaptered();
      let s = initEditorState(doc0);
      let applied = 0;
      for (let i = 0; i < 60; i++) {
        const n = s.doc.pages.length;
        const pi = n ? Math.floor(r() * n) : 0;
        const ops: EditOp[] = [
          (d) => addPage(d, n ? pi : -1, pick(pageLayouts), 20),
          (d) => deletePage(d, pi),
          (d) => movePage(d, pi, n ? Math.floor(r() * n) : 0),
          (d) => changeLayout(d, pi, pick(pageLayouts)).doc,
          (d) => replacePhoto(d, pi, 0, pick([...PHOTO_IDS, null])),
          (d) => setCaption(d, pi, pick(["Hi", "مرحبا", "", "  "])),
          (d) => setCrop(d, pi, 0, { x: r(), y: r(), zoom: 1 + r() * 5 }),
          (d) => movePageToChapter(d, pi, pick(d.chapters.map((c) => c.id).concat("c1"))),
          (d) => setCover(d, { title: pick(["Sara & Omar", "عائلتنا", ""]), photoId: pick([...PHOTO_IDS, null]) }),
        ];
        const before = s;
        s = run(s, apply(pick(ops)));
        if (s.doc !== before.doc) applied++;
        const v = valid(s.doc);
        expect(v.ok, `seed ${seed} step ${i}: ${JSON.stringify(v)}`).toBe(true);
        expect(s.doc.pages.length).toBeLessThanOrEqual(20);
        if (s.page !== "cover") expect(s.page).toBeLessThan(s.doc.pages.length);
      }
      expect(applied).toBeGreaterThan(10);
      expect(s.past.length).toBe(Math.min(applied, 50));
      if (applied <= 50) {
        while (s.past.length) s = run(s, { type: "undo" });
        expect(s.doc).toBe(doc0);
      }
    });
  }
});
