import { describe, expect, it } from "vitest";
import { chapterForPage, chapterLabel, chapterStarts, labelFontStyle } from "@/lib/viewer/chapters";
import {
  firstVisiblePageIdx,
  flipLayout,
  flipPageKind,
  pageCounterLabel,
  startIndexFor,
} from "@/lib/viewer/pages";
import { whatsappShareUrl } from "@/lib/viewer/share";

describe("flipLayout", () => {
  it("phones: no filler, end card right after the last page", () => {
    expect(flipLayout(5, { endCard: true, spread: false })).toEqual({ docPages: 5, count: 7, endIndex: 6, fillerIndex: null });
    expect(flipLayout(4, { endCard: true, spread: false })).toEqual({ docPages: 4, count: 6, endIndex: 5, fillerIndex: null });
  });
  it("spread: total count is always even so the end card stands alone", () => {
    for (let d = 0; d <= 21; d++) {
      const l = flipLayout(d, { endCard: true, spread: true });
      expect(l.count % 2).toBe(0);
      expect(l.endIndex).toBe(l.count - 1);
      expect(l.fillerIndex).toBe(d % 2 === 1 ? d + 1 : null);
    }
  });
  it("phone 20 pages: 22 indexes, end card 21, no filler; spread odd: filler then end card", () => {
    expect(flipLayout(20, { endCard: true, spread: false })).toEqual({ docPages: 20, count: 22, endIndex: 21, fillerIndex: null });
    expect(flipLayout(19, { endCard: true, spread: false })).toEqual({ docPages: 19, count: 21, endIndex: 20, fillerIndex: null });
    expect(flipLayout(19, { endCard: true, spread: true })).toEqual({ docPages: 19, count: 22, endIndex: 21, fillerIndex: 20 });
    expect(flipLayout(20, { endCard: true, spread: true })).toEqual({ docPages: 20, count: 22, endIndex: 21, fillerIndex: null });
    for (let d = 0; d <= 101; d++) expect(flipLayout(d, { endCard: true, spread: false }).fillerIndex).toBeNull();
  });
  it("without end card it is just cover + pages", () => {
    expect(flipLayout(3, { endCard: false, spread: true })).toEqual({ docPages: 3, count: 4, endIndex: null, fillerIndex: null });
  });
  it("sanitises bad counts", () => {
    expect(flipLayout(-3, { endCard: true, spread: false }).count).toBe(2);
    expect(flipLayout(Number.NaN, { endCard: false, spread: false }).count).toBe(1);
  });
});

describe("flipPageKind / startIndexFor", () => {
  const l = flipLayout(3, { endCard: true, spread: true }); // 0 cover, 1-3 pages, 4 filler, 5 end
  it("classifies indexes", () => {
    expect(flipPageKind(l, 0)).toEqual({ kind: "cover" });
    expect(flipPageKind(l, 3)).toEqual({ kind: "page", pageIdx: 2 });
    expect(flipPageKind(l, 4)).toEqual({ kind: "filler" });
    expect(flipPageKind(l, 5)).toEqual({ kind: "end" });
  });
  it("maps 'past the last page' to the new end card on remount", () => {
    const single = flipLayout(3, { endCard: true, spread: false }); // end = 4
    expect(startIndexFor(single, 5)).toBe(4);
    expect(startIndexFor(l, 4)).toBe(5);
    expect(startIndexFor(l, 2)).toBe(2);
    expect(startIndexFor(l, -1)).toBe(0);
  });
});

describe("pageCounterLabel", () => {
  const single = flipLayout(20, { endCard: true, spread: false });
  const spread = flipLayout(20, { endCard: true, spread: true });
  it("single page", () => {
    expect(pageCounterLabel(single, 0, false)).toBe("Cover");
    expect(pageCounterLabel(single, 5, false)).toBe("5 / 20");
    expect(pageCounterLabel(single, 20, false)).toBe("20 / 20");
    expect(pageCounterLabel(single, 21, false)).toBe("End");
  });
  it("spread uses an en dash range", () => {
    expect(pageCounterLabel(spread, 0, true)).toBe("Cover");
    expect(pageCounterLabel(spread, 3, true)).toBe("3–4 / 20");
    expect(pageCounterLabel(spread, 4, true)).toBe("3–4 / 20");
    expect(pageCounterLabel(spread, 21, true)).toBe("End");
  });
  it("odd page count: last page pairs with the blank filler", () => {
    const odd = flipLayout(5, { endCard: true, spread: true });
    expect(pageCounterLabel(odd, 5, true)).toBe("5 / 5");
    expect(pageCounterLabel(odd, 7, true)).toBe("End");
  });
  it("first visible page index", () => {
    expect(firstVisiblePageIdx(spread, 0, true)).toBeNull();
    expect(firstVisiblePageIdx(spread, 4, true)).toBe(2);
    expect(firstVisiblePageIdx(single, 21, false)).toBeNull();
  });
});

describe("chapters", () => {
  const doc = {
    chapters: [
      { id: "a", title: "Arrival", dateLabel: "12 Feb" },
      { id: "b", title: "عشاء العائلة", dateLabel: null },
      { id: "empty", title: "Unused", dateLabel: null },
    ],
    pages: [{ chapterId: "a" }, { chapterId: "a" }, { chapterId: null }, { chapterId: "b" }, { chapterId: "a" }, { chapterId: "ghost" }],
  };
  it("chapter for a page index", () => {
    expect(chapterForPage(doc, 1)?.id).toBe("a");
    expect(chapterForPage(doc, 2)).toBeNull();
    expect(chapterForPage(doc, 3)?.id).toBe("b");
    expect(chapterForPage(doc, 5)).toBeNull();
    expect(chapterForPage(doc, null)).toBeNull();
    expect(chapterForPage(doc, 99)).toBeNull();
  });
  it("chapter starts in reading order, first appearance only, empty/unknown skipped", () => {
    expect(chapterStarts(doc).map((s) => [s.chapter.id, s.firstPageIdx, s.flipIndex])).toEqual([
      ["a", 0, 1],
      ["b", 3, 4],
    ]);
  });
  it("label joins title and date", () => {
    expect(chapterLabel(doc.chapters[0])).toBe("Arrival · 12 Feb");
    expect(chapterLabel(doc.chapters[1])).toBe("عشاء العائلة");
    expect(chapterLabel({ title: " ", dateLabel: "May" })).toBe("May");
    expect(chapterLabel(null)).toBe("");
  });
  it("Arabic labels get Cairo first", () => {
    expect(labelFontStyle("عشاء العائلة")?.fontFamily).toMatch(/^var\(--font-cairo\)/);
    expect(labelFontStyle("Arrival")).toBeUndefined();
  });
});

describe("whatsappShareUrl", () => {
  it("encodes title + space + url", () => {
    const u = whatsappShareUrl("Eid & family ✨ رحلتنا", "https://x.ae/b/abc?x=1");
    expect(u.startsWith("https://wa.me/?text=")).toBe(true);
    expect(decodeURIComponent(u.slice("https://wa.me/?text=".length))).toBe("Eid & family ✨ رحلتنا https://x.ae/b/abc?x=1");
    expect(u).not.toMatch(/\s/);
    expect(u.slice("https://wa.me/?text=".length)).not.toMatch(/[&?#]/);
  });
  it("no title → just the url", () => {
    expect(whatsappShareUrl("  ", "https://x.ae/b/a")).toBe(`https://wa.me/?text=${encodeURIComponent("https://x.ae/b/a")}`);
  });
});
