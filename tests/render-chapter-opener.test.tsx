// M10c polish: in geometric + scrapbook books the chapter title / date panels (and their plates)
// show only on the chapter's first page (a spread counts as one first page, both halves). Later
// pages of the chapter render nothing there; the page caption area stays. Classic / modern keep
// repeating them (frozen by tests/golden m9 + m10b).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookPage, type BookRenderMode } from "@/components/book/BookPage";
import { devSampleDoc, devSamplePhotos, M10C_SAMPLES } from "@/lib/book/dev-sample";
import { opensChapter, pageRenderModel } from "@/lib/book/render";
import type { BookDoc } from "@/lib/book/types";
import { getLayout } from "@/lib/layouts";

const chapterBinds = (doc: BookDoc, i: number) =>
  (pageRenderModel(doc, i, devSamplePhotos())!.texts ?? []).map((t) => t.bind).filter((b) => b === "chapterTitle" || b === "dateLabel");

/** Index of the page that decides whether page i opens its chapter (left half for a right half). */
const ownerIdx = (doc: BookDoc, i: number) => (doc.pages[i].side === "right" ? i - 1 : i);

describe("opensChapter", () => {
  it("first page, and a page whose chapterId differs from the previous page's", () => {
    const doc = devSampleDoc("scrapbook-portrait");
    expect(doc.pages.map((_, i) => opensChapter(doc, i))).toEqual(
      doc.pages.map((p, i) => i === 0 || doc.pages[i - 1].chapterId !== p.chapterId),
    );
    expect(opensChapter(doc, 0)).toBe(true);
    expect(opensChapter(doc, doc.pages.length)).toBe(false);
  });
});

describe("chapter panels only on the chapter's first page (geometric + scrapbook)", () => {
  for (const sample of M10C_SAMPLES) {
    it(sample, () => {
      const doc = devSampleDoc(sample);
      let laterWithPanels = 0;
      doc.pages.forEach((p, i) => {
        const declared = (getLayout(p.layout)?.texts ?? []).some((t) => t.bind === "chapterTitle" || t.bind === "dateLabel");
        const binds = chapterBinds(doc, i);
        if (opensChapter(doc, ownerIdx(doc, i))) return;
        if (declared) laterWithPanels++;
        expect(binds, `page ${i}`).toEqual([]);
        // The caption area stays (AI captions keep their place).
        const m = pageRenderModel(doc, i, devSamplePhotos())!;
        if (getLayout(p.layout)?.caption && p.side !== "right") expect(m.caption, `page ${i} caption`).not.toBeNull();
      });
      // The samples do have later pages whose layout declares chapter panels.
      expect(laterWithPanels).toBeGreaterThan(0);
      // Chapter openers keep their panels.
      const opener = doc.pages.findIndex(
        (p, i) => opensChapter(doc, i) && (getLayout(p.layout)?.texts ?? []).some((t) => t.bind === "chapterTitle"),
      );
      expect(chapterBinds(doc, opener)).toContain("chapterTitle");
    });
  }

  it("a spread opening a chapter shows its panels on both halves' geometry (right half resolves to the left)", () => {
    const doc = devSampleDoc("scrapbook-portrait");
    const left = doc.pages.findIndex((p, i) => p.side === "left" && opensChapter(doc, i));
    expect(left).toBeGreaterThan(-1);
    const both = [...chapterBinds(doc, left), ...chapterBinds(doc, left + 1)];
    expect(both).toContain("chapterTitle");
  });

  it("no empty plate in the markup of a later page (editor, viewer, print)", () => {
    const doc = devSampleDoc("scrapbook-portrait");
    const later = doc.pages.findIndex(
      (p, i) => !opensChapter(doc, ownerIdx(doc, i)) && (getLayout(p.layout)?.texts ?? []).some((t) => t.plate),
    );
    expect(later).toBeGreaterThan(-1);
    const title = doc.chapters.find((c) => c.id === doc.pages[later].chapterId)!.title;
    for (const mode of ["edit", "view", "print"] as BookRenderMode[]) {
      const html = renderToStaticMarkup(<BookPage doc={doc} page={later} mode={mode} photos={devSamplePhotos()} captionLang="en" />);
      expect(html).not.toContain(title);
      expect(html).not.toContain("data-text-panel=\"chapterTitle\"");
      expect(html).not.toContain("data-text-plate");
    }
  });

  it("a page after a page of another chapter opens it, even mid-book", () => {
    const doc = devSampleDoc("geometric-portrait");
    const i = doc.pages.findIndex((p, k) => k > 0 && doc.pages[k - 1].chapterId !== p.chapterId && !p.side);
    expect(chapterBinds(doc, i).length).toBeGreaterThan(0);
  });
});

describe("modern keeps repeating chapter panels", () => {
  it("modern-portrait: later pages of a chapter still show them", () => {
    const doc = devSampleDoc("modern-portrait");
    const later = doc.pages.findIndex(
      (p, i) =>
        !opensChapter(doc, ownerIdx(doc, i)) && (getLayout(p.layout)?.texts ?? []).some((t) => t.bind === "chapterTitle"),
    );
    if (later === -1) return; // sample has no such page; goldens m10b cover modern byte-for-byte
    expect(chapterBinds(doc, later)).toContain("chapterTitle");
  });
});
