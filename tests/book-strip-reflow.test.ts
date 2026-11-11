// M10b A19 (review S2, D-028 rule 1 / D-064): deleting a photo reflows the pages that held it,
// reusing relayout's removal step. Modern portrait sample (dev-sample.ts):
//   0 m-p-one-band (sp0, ar AI caption) · 1 m-p-two-panel (sp1 sp2, en AI caption)
//   2|3 m-p-spread-mosaic (sp3–sp9, ar AI caption) · 4|5 m-p-spread-panorama (sp10)
//   6|7 m-p-spread-grid (sp11–sp22) · 8 three-panel · 9 four-grid · 10 five-mosaic · 11 six-grid ·
//   12 full · 13 two-stack · 14 three-mosaic
import { describe, expect, it } from "vitest";
import { devSampleDoc, SAMPLE_PHOTO_COUNT } from "@/lib/book/dev-sample";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import { spreadIssues } from "@/lib/book/spreads";
import { stripPhotoFromDoc, type StripPhotoDims } from "@/lib/book/strip-photos";
import type { BookDoc } from "@/lib/book/types";

const ALL = ["d0", ...Array.from({ length: SAMPLE_PHOTO_COUNT }, (_, i) => `sp${i}`)];
/** Every sample photo landscape 3:2 except a 3:1 panorama (sp10). */
const DIMS: StripPhotoDims[] = ALL.map((id) => ({ id, width: id === "sp10" ? 3000 : 1500, height: 1000 }));

const modern = () => devSampleDoc("modern-portrait");
const slotIds = (d: BookDoc) => d.pages.flatMap((p) => p.slots.map((s) => s.photoId)).filter((x): x is string => x !== null);

function expectValid(d: BookDoc, gone: string) {
  expect(parseBookDoc(d).ok).toBe(true);
  const ids = new Set(ALL.filter((x) => x !== gone));
  expect(validateBookDoc(d, { photoIds: ids, maxPages: 100 })).toEqual([]);
  expect(spreadIssues(d)).toEqual([]);
}

function withUserCaption(d: BookDoc, idx: number, text: string): BookDoc {
  return {
    ...d,
    pages: d.pages.map((p, i) => (i === idx ? { ...p, caption: { text, font: "Cormorant", align: "center", source: "user" } } : p)),
  };
}

describe("stripPhotoFromDoc reflow — spreads (modern portrait)", () => {
  it("panorama spread whose only photo is deleted is removed as ONE unit (2 pages), rest untouched", () => {
    const d = modern();
    const r = stripPhotoFromDoc(d, "sp10", DIMS);
    expect(r.reflowed).toBe(true);
    expect(r.doc.pages.length).toBe(d.pages.length - 2);
    expect(r.doc.pages.map((p) => p.id)).toEqual(d.pages.filter((_, i) => i !== 4 && i !== 5).map((p) => p.id));
    // Same objects for every untouched page (parity unchanged → no repair split).
    r.doc.pages.forEach((p) => expect(d.pages).toContain(p));
    expect(slotIds(r.doc)).not.toContain("sp10");
    expect(slotIds(r.doc).length).toBe(slotIds(d).length - 1);
    expectValid(r.doc, "sp10");
  });

  it("a spread that loses one photo becomes twins / smaller pages; all other photos stay, page count kept", () => {
    const d = modern();
    const r = stripPhotoFromDoc(d, "sp11", DIMS); // grid 12 → 11: no 11-photo spread
    expect(r.reflowed).toBe(true);
    expect(r.doc.pages.length).toBe(d.pages.length);
    expect(r.doc.pages[6].layout).not.toBe("m-p-spread-grid");
    expect(r.doc.pages[6].side).toBeUndefined();
    expect(r.doc.pages[6].id).toBe("s6");
    expect(r.doc.pages[7].id).toBe("s7");
    expect(new Set(slotIds(r.doc))).toEqual(new Set(slotIds(d).filter((x) => x !== "sp11")));
    expectValid(r.doc, "sp11");
  });

  it("a spread with a user caption keeps the caption when it splits", () => {
    const d = withUserCaption(modern(), 2, "Henna night");
    const r = stripPhotoFromDoc(d, "sp3", DIMS); // mosaic 7 → 6
    expect(r.reflowed).toBe(true);
    const caps = r.doc.pages.filter((p) => p.caption?.source === "user").map((p) => p.caption?.text);
    expect(caps).toEqual(["Henna night"]);
    expect(new Set(slotIds(r.doc))).toEqual(new Set(slotIds(d).filter((x) => x !== "sp3")));
    expectValid(r.doc, "sp3");
  });

  it("removing a single page shifts later spreads onto right pages → repairSpreads splits them (photos kept)", () => {
    const d = modern();
    const r = stripPhotoFromDoc(d, "sp0", DIMS); // one-band page, AI caption only → removed
    expect(r.reflowed).toBe(true);
    expect(r.doc.pages.map((p) => p.id)).not.toContain("s0");
    expect(new Set(slotIds(r.doc))).toEqual(new Set(slotIds(d).filter((x) => x !== "sp0")));
    expectValid(r.doc, "sp0");
  });
});

describe("stripPhotoFromDoc reflow — single pages + captions", () => {
  it("a page that loses a photo refits to a smaller layout of the same style; its AI caption goes (D-031)", () => {
    const d = modern();
    const r = stripPhotoFromDoc(d, "sp1", DIMS); // two-panel → one photo
    const p = r.doc.pages[1];
    expect(p.id).toBe("s1");
    expect(p.slots.map((s) => s.photoId)).toEqual(["sp2"]);
    expect(p.layout.startsWith("m-p-")).toBe(true);
    expect(p.caption).toBeNull();
    expect(r.doc.pages.length).toBe(d.pages.length);
    expectValid(r.doc, "sp1");
  });

  it("a user caption survives the refit (caption-area layout preferred)", () => {
    const d = withUserCaption(modern(), 1, "Mehndi colours");
    const r = stripPhotoFromDoc(d, "sp1", DIMS);
    expect(r.doc.pages[1].caption).toMatchObject({ text: "Mehndi colours", source: "user" });
    expectValid(r.doc, "sp1");
  });

  it("a page left with no photos but a user caption stays (emptied slot), never dropped", () => {
    const d = withUserCaption(modern(), 0, "ليلة الحناء");
    const r = stripPhotoFromDoc(d, "sp0", DIMS);
    expect(r.doc.pages[0].id).toBe("s0");
    expect(r.doc.pages[0].slots.map((s) => s.photoId)).toEqual([null]);
    expect(r.doc.pages[0].caption?.text).toBe("ليلة الحناء");
    expect(r.doc.pages.length).toBe(d.pages.length);
    expectValid(r.doc, "sp0");
  });

  it("the cover photo is cleared; no dims passed → photos count as square and still fit", () => {
    const d = modern();
    const r = stripPhotoFromDoc({ ...d, cover: { ...d.cover, photoId: "sp1" } }, "sp1");
    expect(r.doc.cover.photoId).toBeNull();
    expect(r.doc.pages[1].slots.map((s) => s.photoId)).toEqual(["sp2"]);
  });

  it("a chapter that loses all its pages is removed", () => {
    const d = modern();
    const solo: BookDoc = {
      ...d,
      chapters: [...d.chapters, { id: "c9", title: "Solo", dateLabel: "", place: null }],
      pages: d.pages.map((p, i) => (i === 12 ? { ...p, chapterId: "c9" } : p)), // m-p-full
    };
    const gone = solo.pages[12].slots[0].photoId as string;
    const r = stripPhotoFromDoc(solo, gone, DIMS);
    expect(r.doc.chapters.map((c) => c.id)).not.toContain("c9");
    expectValid(r.doc, gone);
  });
});

describe("stripPhotoFromDoc reflow — fallback", () => {
  it("a design style without layouts (geometric row) falls back to nulling the slot (no throw)", () => {
    const d = modern();
    const geo: BookDoc = { ...d, style: { ...d.style, designStyle: "geometric" } };
    const r = stripPhotoFromDoc(geo, "sp1", DIMS);
    expect(r.changed).toBe(true);
    expect(r.reflowed).toBe(false);
    expect(r.doc.pages[1].layout).toBe("m-p-two-panel");
    expect(r.doc.pages[1].slots.map((s) => s.photoId)).toEqual([null, "sp2"]);
  });
});

describe("removeSlotPhotos — empty spread with a user caption (keepUserCaptionPages)", async () => {
  const { removeSlotPhotos } = await import("@/lib/book/relayout");
  const { getLayout } = await import("@/lib/layouts");
  it("becomes its caption half's single-page twin with empty slots; without the flag it is dropped", () => {
    const d = withUserCaption(modern(), 2, "Henna night");
    const mosaic = new Set(d.pages[2].slots.map((s) => s.photoId as string));
    const photo = (id: string) => ({ id, width: 1500, height: 1000, takenAt: null, status: "kept" as const, place: null, dupGroup: null, blurScore: null });
    let n = 100;
    const base = { keep: (id: string) => !mosaic.has(id), photo, design: { format: "A5_PORTRAIT" as const, designStyle: "modern" as const }, nextPageId: () => `p${n++}` };
    const kept = removeSlotPhotos(d, { ...base, keepUserCaptionPages: true });
    const p = kept.pages[2];
    expect(p.id).toBe("s2");
    expect(p.side).toBeUndefined();
    expect(getLayout("m-p-spread-mosaic")?.twin).toContain(p.layout);
    expect(getLayout(p.layout)?.caption).not.toBeNull();
    expect(p.slots.every((s) => s.photoId === null)).toBe(true);
    expect(p.caption?.text).toBe("Henna night");
    expect(kept.pages.length).toBe(d.pages.length - 1);
    const dropped = removeSlotPhotos(d, base);
    expect(dropped.pages.length).toBe(d.pages.length - 2);
  });
});
