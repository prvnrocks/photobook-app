import { describe, expect, it } from "vitest";
import {
  addPage,
  canAddPage,
  changeLayout,
  deletePage,
  EditOpError,
  markUserEdited,
  movePage,
  movePageToChapter,
  pruneEmptyChapters,
  replacePhoto,
  setCaption,
  setCaptionAlign,
  setCaptionFont,
  setChapterTitle,
  setCover,
  setCrop,
  usedPhotoIds,
} from "@/lib/book/edit-ops";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc, BookPage } from "@/lib/book/types";

const PHOTOS = new Set(Array.from({ length: 120 }, (_, i) => `ph${i + 1}`));
const C = { x: 0.5, y: 0.5, zoom: 1 };

const pg = (id: string, chapterId: string | null, layout: string, ids: (string | null)[], caption: BookPage["caption"] = null): BookPage => ({
  id,
  chapterId,
  layout,
  slots: ids.map((photoId) => ({ photoId, crop: { ...C } })),
  caption,
});

function base(): BookDoc {
  return {
    version: 1,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: { layout: "cover", photoId: "ph1", title: "Weekend", subtitle: "Abu Dhabi" },
    chapters: [
      { id: "c1", title: "Beach", dateLabel: "12 Oct 2026", place: null },
      { id: "c2", title: "Dunes", dateLabel: "14 Oct 2026", place: null },
      { id: "c3", title: "Home", dateLabel: "", place: null },
    ],
    pages: [
      pg("p1", "c1", "one-portrait", ["ph1"], { text: "Morning light", font: "Playfair", align: "center", source: "ai" }),
      pg("p2", "c1", "two-vertical", ["ph2", "ph3"]),
      pg("p3", "c2", "three-mixed", ["ph4", "ph5", "ph6"], { text: "Sand", font: "Playfair", align: "center", source: "ai" }),
      pg("p4", "c2", "four-grid", ["ph7", "ph8", "ph9", "ph10"]),
      pg("p5", "c3", "full-page", ["ph11"]),
    ],
    style: { background: "#FFFFFF", font: "Playfair" },
    meta: { generator: "ai", generatorVersion: 2, runId: null, userEdited: false },
  };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Frozen doc + snapshot: ops must never mutate their input. */
function frozen() {
  const d = deepFreeze(base());
  return { d, snap: JSON.stringify(d) };
}

function expectValid(doc: BookDoc, maxPages = 20) {
  const r = parseBookDoc(doc);
  if (!r.ok) throw new Error(r.issues.join("; "));
  expect(validateBookDoc(r.doc, { photoIds: PHOTOS, maxPages })).toEqual([]);
}

const ids = (doc: BookDoc) => doc.pages.map((p) => p.id);
const chapterOf = (doc: BookDoc, id: string) => doc.pages.find((p) => p.id === id)?.chapterId;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof EditOpError ? e.code : "other";
  }
  return null;
};

describe("fixture", () => {
  it("base doc is valid", () => expectValid(base()));
});

describe("changeLayout", () => {
  it("re-flows photos in order into a bigger layout, rest empty", () => {
    const { d, snap } = frozen();
    const r = changeLayout(d, 1, "four-grid");
    expect(r.doc.pages[1].slots.map((s) => s.photoId)).toEqual(["ph2", "ph3", null, null]);
    expect(r.removedPhotoIds).toEqual([]);
    expect(r.droppedCaption).toBeNull();
    expect(JSON.stringify(d)).toBe(snap);
    expectValid(r.doc);
  });

  it("extras beyond slot count become unused", () => {
    const { d } = frozen();
    const r = changeLayout(d, 3, "two-horizontal");
    expect(r.doc.pages[3].slots.map((s) => s.photoId)).toEqual(["ph7", "ph8"]);
    expect(r.removedPhotoIds).toEqual(["ph9", "ph10"]);
    expect(usedPhotoIds(r.doc).has("ph9")).toBe(false);
    expectValid(r.doc);
  });

  it("drops the caption when the new layout has no caption area", () => {
    const { d } = frozen();
    const r = changeLayout(d, 0, "full-page");
    expect(r.doc.pages[0].caption).toBeNull();
    expect(r.droppedCaption?.text).toBe("Morning light");
    expectValid(r.doc);
  });

  it("keeps the caption and crops when the new layout has a caption area", () => {
    const d = setCrop(base(), 2, 1, { x: 0.2, zoom: 2 });
    const r = changeLayout(d, 2, "two-vertical");
    expect(r.doc.pages[2].caption?.text).toBe("Sand");
    expect(r.doc.pages[2].slots[1].crop).toEqual({ x: 0.2, y: 0.5, zoom: 2 });
    expect(r.removedPhotoIds).toEqual(["ph6"]);
    expectValid(r.doc);
  });

  it("skips empty slots when re-flowing", () => {
    const d = replacePhoto(base(), 3, 0, null);
    const r = changeLayout(d, 3, "two-vertical");
    expect(r.doc.pages[3].slots.map((s) => s.photoId)).toEqual(["ph8", "ph9"]);
    expect(r.removedPhotoIds).toEqual(["ph10"]);
  });

  it("same layout is a no-op", () => {
    const d = base();
    expect(changeLayout(d, 1, "two-vertical").doc).toBe(d);
  });

  it("rejects unknown and cover layouts and bad indices", () => {
    expect(code(() => changeLayout(base(), 0, "nope"))).toBe("unknown_layout");
    expect(code(() => changeLayout(base(), 0, "cover"))).toBe("not_a_page_layout");
    expect(code(() => changeLayout(base(), 9, "full-page"))).toBe("page_out_of_range");
  });
});

describe("replacePhoto", () => {
  it("places an unused photo and resets crop", () => {
    const d0 = setCrop(base(), 1, 0, { zoom: 3 });
    const d = replacePhoto(d0, 1, 0, "ph50");
    expect(d.pages[1].slots[0]).toEqual({ photoId: "ph50", crop: C });
    expectValid(d);
  });

  it("swaps with a slot on another page when the photo is already used", () => {
    const { d, snap } = frozen();
    const out = replacePhoto(d, 1, 0, "ph8");
    expect(out.pages[1].slots[0].photoId).toBe("ph8");
    expect(out.pages[3].slots[1].photoId).toBe("ph2");
    expect(JSON.stringify(d)).toBe(snap);
    expectValid(out);
  });

  it("swaps within the same page and resets both crops", () => {
    const d0 = setCrop(setCrop(base(), 3, 0, { zoom: 2 }), 3, 3, { x: 0 });
    const out = replacePhoto(d0, 3, 0, "ph10");
    expect(out.pages[3].slots.map((s) => s.photoId)).toEqual(["ph10", "ph8", "ph9", "ph7"]);
    expect(out.pages[3].slots[0].crop).toEqual(C);
    expect(out.pages[3].slots[3].crop).toEqual(C);
    expectValid(out);
  });

  it("moving a photo into an empty slot leaves its old slot empty", () => {
    const d0 = addPage(base(), 4, "two-vertical");
    const out = replacePhoto(d0, 5, 1, "ph11");
    expect(out.pages[5].slots[1].photoId).toBe("ph11");
    expect(out.pages[4].slots[0].photoId).toBeNull();
    expectValid(out);
  });

  it("cover photo placed on a page does not change the cover", () => {
    const d0 = replacePhoto(base(), 0, 0, "ph60"); // ph1 now only the cover
    const out = replacePhoto(d0, 1, 0, "ph1");
    expect(out.cover.photoId).toBe("ph1");
    expect(out.pages[1].slots[0].photoId).toBe("ph1");
    expectValid(out);
  });

  it("null clears a slot; same photo is a no-op", () => {
    const d = base();
    expect(replacePhoto(d, 1, 0, null).pages[1].slots[0].photoId).toBeNull();
    expect(replacePhoto(d, 1, 0, "ph2")).toBe(d);
    expect(code(() => replacePhoto(d, 1, 5, "ph2"))).toBe("slot_out_of_range");
  });
});

describe("setCrop", () => {
  it("sets and clamps to schema bounds", () => {
    const { d, snap } = frozen();
    const out = setCrop(d, 2, 0, { x: -1, y: 2, zoom: 9 });
    expect(out.pages[2].slots[0].crop).toEqual({ x: 0, y: 1, zoom: 4 });
    expect(setCrop(d, 2, 0, { zoom: 0.2 }).pages[2].slots[0].crop.zoom).toBe(1);
    expect(JSON.stringify(d)).toBe(snap);
    expectValid(out);
  });

  it("partial update keeps other fields; NaN falls back to default", () => {
    const d = setCrop(base(), 1, 1, { x: 0.3, y: 0.7, zoom: 2 });
    expect(setCrop(d, 1, 1, { zoom: 1.5 }).pages[1].slots[1].crop).toEqual({ x: 0.3, y: 0.7, zoom: 1.5 });
    expect(setCrop(d, 1, 1, { x: Number.NaN }).pages[1].slots[1].crop.x).toBe(0.5);
  });

  it("unchanged crop is a no-op", () => {
    const d = base();
    expect(setCrop(d, 1, 1, { x: 0.5 })).toBe(d);
  });
});

describe("captions", () => {
  it("setCaption makes a user caption and keeps font/align", () => {
    const { d, snap } = frozen();
    const out = setCaption(d, 0, "Our first swim");
    expect(out.pages[0].caption).toEqual({ text: "Our first swim", font: "Playfair", align: "center", source: "user" });
    expect(JSON.stringify(d)).toBe(snap);
    expectValid(out);
  });

  it("new Arabic caption defaults to Cairo", () => {
    const out = setCaption(base(), 1, "أجمل ليلة");
    expect(out.pages[1].caption).toEqual({ text: "أجمل ليلة", font: "Cairo", align: "center", source: "user" });
    expectValid(out);
  });

  it("empty or whitespace text removes the caption", () => {
    const out = setCaption(base(), 0, "   ");
    expect(out.pages[0].caption).toBeNull();
    expectValid(out);
    const d = base();
    expect(setCaption(d, 1, "")).toBe(d);
  });

  it("clips long text to 200 units without lone surrogates", () => {
    const out = setCaption(base(), 0, "😀".repeat(150));
    const t = out.pages[0].caption?.text ?? "";
    expect(t.length).toBeLessThanOrEqual(200);
    expectValid(out);
  });

  it("rejects text on a layout without caption area", () => {
    expect(code(() => setCaption(base(), 4, "hi"))).toBe("no_caption_area");
  });

  it("setCaptionFont / setCaptionAlign mark source user; no caption → no-op", () => {
    const a = setCaptionFont(base(), 2, "Tajawal");
    expect(a.pages[2].caption).toMatchObject({ font: "Tajawal", source: "user", text: "Sand" });
    const b = setCaptionAlign(a, 2, "right");
    expect(b.pages[2].caption).toMatchObject({ align: "right", font: "Tajawal" });
    expectValid(b);
    const d = base();
    expect(setCaptionFont(d, 1, "Inter")).toBe(d);
    expect(setCaptionAlign(d, 1, "left")).toBe(d);
  });
});

describe("addPage / deletePage / canAddPage", () => {
  it("adds an empty page in the same chapter after the index", () => {
    const { d, snap } = frozen();
    const out = addPage(d, 1);
    expect(out.pages).toHaveLength(6);
    const np = out.pages[2];
    expect(np.chapterId).toBe("c1");
    expect(np.layout).toBe("one-portrait");
    expect(np.slots).toEqual([{ photoId: null, crop: C }]);
    expect(np.caption).toBeNull();
    expect(new Set(ids(out)).size).toBe(6);
    expect(JSON.stringify(d)).toBe(snap);
    expectValid(out);
  });

  it("adds at the start into the first chapter, with a given layout", () => {
    const out = addPage(base(), -1, "four-grid");
    expect(out.pages[0]).toMatchObject({ chapterId: "c1", layout: "four-grid" });
    expect(out.pages[0].slots).toHaveLength(4);
    expectValid(out);
  });

  it("new page ids never clash", () => {
    let d = base();
    d = { ...d, pages: d.pages.map((p, i) => ({ ...p, id: `p${i + 6}` })) };
    const out = addPage(addPage(d, 0), 0);
    expect(new Set(ids(out)).size).toBe(7);
    expectValid(out);
  });

  it("20-page boundary: canAddPage false at 20 and addPage throws", () => {
    let d = base();
    while (canAddPage(d, 20)) d = addPage(d, d.pages.length - 1);
    expect(d.pages).toHaveLength(20);
    expectValid(d, 20);
    expect(canAddPage(d, 20)).toBe(false);
    expect(canAddPage(d, 100)).toBe(true);
    expect(code(() => addPage(d, 0, undefined, 20))).toBe("page_limit");
    expect(addPage(d, 0, undefined, 100).pages).toHaveLength(21);
  });

  it("canAddPage caps at schema max 100", () => {
    let d = base();
    while (d.pages.length < 100) d = addPage(d, 0);
    expect(canAddPage(d, 500)).toBe(false);
    expect(code(() => addPage(d, 0, undefined, 500))).toBe("page_limit");
    expectValid(d, 100);
  });

  it("deletePage removes the page and frees its photos", () => {
    const { d, snap } = frozen();
    const out = deletePage(d, 1);
    expect(ids(out)).toEqual(["p1", "p3", "p4", "p5"]);
    expect(usedPhotoIds(out).has("ph2")).toBe(false);
    expect(JSON.stringify(d)).toBe(snap);
    expectValid(out);
  });

  it("deleting a chapter's last page prunes the chapter", () => {
    const out = deletePage(base(), 4);
    expect(out.chapters.map((c) => c.id)).toEqual(["c1", "c2"]);
    expectValid(out);
  });

  it("rejects bad indices", () => {
    expect(code(() => deletePage(base(), -1))).toBe("page_out_of_range");
    expect(code(() => addPage(base(), 5))).toBe("page_out_of_range");
    expect(code(() => addPage(base(), 0, "cover"))).toBe("not_a_page_layout");
  });
});

describe("movePage", () => {
  it("moved page takes the chapter of the page before it", () => {
    const { d, snap } = frozen();
    const out = movePage(d, 0, 2); // p1 lands after p3 (c2)
    expect(ids(out)).toEqual(["p2", "p3", "p1", "p4", "p5"]);
    expect(chapterOf(out, "p1")).toBe("c2");
    expect(JSON.stringify(d)).toBe(snap);
    expectValid(out);
  });

  it("moving to the first position takes the first chapter", () => {
    const out = movePage(base(), 3, 0);
    expect(ids(out)).toEqual(["p4", "p1", "p2", "p3", "p5"]);
    expect(chapterOf(out, "p4")).toBe("c1");
    expectValid(out);
  });

  it("moving to the end takes the last chapter and prunes the emptied one", () => {
    const d = deletePage(base(), 1); // c1 = [p1]
    const out = movePage(d, 0, 3);
    expect(ids(out)).toEqual(["p3", "p4", "p5", "p1"]);
    expect(chapterOf(out, "p1")).toBe("c3");
    expect(out.chapters.map((c) => c.id)).toEqual(["c2", "c3"]);
    expectValid(out);
  });

  it("moving within a chapter keeps the chapter", () => {
    const out = movePage(base(), 2, 3);
    expect(ids(out)).toEqual(["p1", "p2", "p4", "p3", "p5"]);
    expect(chapterOf(out, "p3")).toBe("c2");
    expectValid(out);
  });

  it("moving to a chapter's first spot joins the previous chapter (D-037 5)", () => {
    const out = movePage(base(), 3, 2); // p4 lands right after p2 (c1)
    expect(ids(out)).toEqual(["p1", "p2", "p4", "p3", "p5"]);
    expect(chapterOf(out, "p4")).toBe("c1");
    expectValid(out);
  });

  it("same index is a no-op; bad index throws", () => {
    const d = base();
    expect(movePage(d, 2, 2)).toBe(d);
    expect(code(() => movePage(d, 0, 5))).toBe("page_out_of_range");
  });
});

describe("movePageToChapter", () => {
  it("appends the page at the end of the target chapter", () => {
    const { d, snap } = frozen();
    const out = movePageToChapter(d, 0, "c2");
    expect(ids(out)).toEqual(["p2", "p3", "p4", "p1", "p5"]);
    expect(chapterOf(out, "p1")).toBe("c2");
    expect(JSON.stringify(d)).toBe(snap);
    expectValid(out);
  });

  it("moving backwards into an earlier chapter", () => {
    const out = movePageToChapter(base(), 4, "c1");
    expect(ids(out)).toEqual(["p1", "p2", "p5", "p3", "p4"]);
    expect(out.chapters.map((c) => c.id)).toEqual(["c1", "c2"]);
    expectValid(out);
  });

  it("already last in that chapter is a no-op; unknown chapter throws", () => {
    const d = base();
    expect(movePageToChapter(d, 1, "c1")).toBe(d);
    expect(code(() => movePageToChapter(d, 0, "zz"))).toBe("unknown_chapter");
  });
});

describe("cover & chapters", () => {
  it("setCover patches only given fields", () => {
    const { d, snap } = frozen();
    const out = setCover(d, { title: "Sara & Omar" });
    expect(out.cover).toEqual({ ...d.cover, title: "Sara & Omar" });
    expect(setCover(d, { subtitle: "2026", photoId: "ph30" }).cover).toMatchObject({ subtitle: "2026", photoId: "ph30", title: "Weekend" });
    expect(setCover(d, { photoId: null }).cover.photoId).toBeNull();
    expect(JSON.stringify(d)).toBe(snap);
    expectValid(out);
  });

  it("clips the title to 120 code points (emoji safe)", () => {
    const out = setCover(base(), { title: "🌴".repeat(200), subtitle: "x".repeat(300) });
    expect([...out.cover.title].length).toBeLessThanOrEqual(120);
    expect(out.cover.subtitle.length).toBeLessThanOrEqual(120);
    expectValid(out);
  });

  it("cover may use a photo that is also on a page", () => {
    const out = setCover(base(), { photoId: "ph5" });
    expectValid(out);
  });

  it("unchanged cover is a no-op", () => {
    const d = base();
    expect(setCover(d, { title: "Weekend" })).toBe(d);
  });

  it("setChapterTitle renames and clips; unknown chapter throws", () => {
    const out = setChapterTitle(base(), "c2", "Into the dunes");
    expect(out.chapters[1].title).toBe("Into the dunes");
    expect(setChapterTitle(base(), "c2", "y".repeat(200)).chapters[1].title.length).toBeLessThanOrEqual(80);
    expectValid(out);
    expect(code(() => setChapterTitle(base(), "zz", "a"))).toBe("unknown_chapter");
  });
});

describe("helpers", () => {
  it("usedPhotoIds includes the cover unless excluded", () => {
    const d = replacePhoto(base(), 0, 0, "ph60");
    expect(usedPhotoIds(d).has("ph1")).toBe(true);
    expect(usedPhotoIds(d, { includeCover: false }).has("ph1")).toBe(false);
    expect(usedPhotoIds(d).size).toBe(12);
  });

  it("pruneEmptyChapters removes unreferenced chapters only", () => {
    const d = base();
    expect(pruneEmptyChapters(d)).toBe(d);
    const extra = { ...d, chapters: [...d.chapters, { id: "c9", title: "x", dateLabel: "", place: null }] };
    expect(pruneEmptyChapters(extra).chapters.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("markUserEdited sets the flag, creating rule meta when absent", () => {
    const d = base();
    expect(markUserEdited(d).meta).toMatchObject({ generator: "ai", userEdited: true });
    const noMeta: BookDoc = { ...d };
    delete noMeta.meta;
    const out = markUserEdited(noMeta);
    expect(out.meta).toEqual({ generator: "rule", generatorVersion: 1, runId: null, userEdited: true });
    expectValid(out);
  });

  it("chains of ops stay valid", () => {
    let d = base();
    d = changeLayout(d, 1, "four-grid").doc;
    d = replacePhoto(d, 1, 2, "ph7");
    d = replacePhoto(d, 1, 3, "ph40");
    d = movePage(d, 4, 0);
    d = addPage(d, 2, "two-horizontal");
    d = setCaption(d, 2, "Sunset");
    d = deletePage(d, 3);
    d = movePageToChapter(d, 0, "c2");
    expectValid(d);
  });
});
