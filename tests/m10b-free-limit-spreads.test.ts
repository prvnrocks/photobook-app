// M10b A16 (tester): spreads count 2 pages toward the FREE limit (LIMITS.free.maxPages = 20), with
// the real modern landscape catalogue (no test-only layouts): edit ops, the Layout picker's options
// and the editor-save validator agree. Mirrors e2e/m10b.spec.ts test b without the live DB.
//
// Note: at an even cap (20) a spread that needs a NEW page can never be refused — only an odd page
// count has a left page without a next page, and 19 + 1 = 20 fits. The refusal itself is shown here
// with an odd cap (19) and in tests/edit-ops-spreads.test.ts (test layouts).

import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/ai/limits";
import { addPageResult, canAddPage, changeLayout, EditOpError } from "@/lib/book/edit-ops";
import { isSpreadAligned } from "@/lib/book/spreads";
import type { BookDoc, BookPage } from "@/lib/book/types";
import { validateEditorDoc } from "@/lib/book/validate-editor-doc";
import { layoutOptions } from "@/lib/editor/layout-options";

const FREE = LIMITS.free.maxPages;
const DESIGN = { format: "A5_LANDSCAPE", designStyle: "modern" } as const;
const PHOTOS = Array.from({ length: 200 }, (_, i) => `p${i + 1}`);
const PHOTO_SET = new Set(PHOTOS);
const CROP = { x: 0.5, y: 0.5, zoom: 1 };

let next = 0;
function single(): BookPage {
  const id = PHOTOS[next++];
  return { id: `pg${next}`, chapterId: "c1", layout: "m-l-one", slots: [{ photoId: id, crop: { ...CROP } }], caption: null };
}

function docOf(n: number): BookDoc {
  next = 0;
  return {
    version: 2,
    format: "A5_LANDSCAPE",
    occasion: "travel",
    cover: { layout: "m-l-cover-panel", photoId: null, title: "Trip", subtitle: "" },
    chapters: [{ id: "c1", title: "Day one", dateLabel: "", place: null }],
    pages: Array.from({ length: n }, single),
    style: { background: { kind: "color", hex: "#FFFFFF" }, designStyle: "modern", font: "Cormorant" },
  } as BookDoc;
}

const ctx = (savedDoc: BookDoc, maxPages: number = FREE) => ({ photoIds: PHOTO_SET, maxPages, savedDoc, design: { ...DESIGN } });

const errCode = (f: () => unknown) => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof EditOpError ? e.code : String(e);
  }
};

describe("free book (20 pages): spreads count 2", () => {
  it("fixture is a valid modern landscape doc", () => {
    const d = docOf(19);
    const r = validateEditorDoc(d, ctx(d));
    expect(r.ok ? r.pageCount : r.code).toBe(19);
  });

  it("19 pages: a spread on page 19 (left, no next page) is offered and adds page 20", () => {
    const d = docOf(19);
    const opts = layoutOptions(d, 18, FREE);
    expect(opts.spreads.map((o) => o.layout.id).sort()).toEqual(["m-l-spread-grid", "m-l-spread-mosaic", "m-l-spread-panorama"]);
    expect(opts.spreads.every((o) => !o.disabled)).toBe(true);

    const r = changeLayout(d, 18, "m-l-spread-grid", { maxPages: FREE });
    expect(r.pagesAdded).toBe(1);
    expect(r.doc.pages).toHaveLength(FREE);
    expect(r.doc.pages[18]).toMatchObject({ layout: "m-l-spread-grid", side: "left" });
    expect(r.doc.pages[19]).toMatchObject({ layout: "m-l-spread-grid", side: "right", slots: [], caption: null });
    expect(isSpreadAligned(r.doc)).toBe(true);

    const v = validateEditorDoc(r.doc, ctx(d));
    expect(v.ok ? v.pageCount : v.code).toBe(FREE);

    // Full: no page 21 by Add page.
    expect(canAddPage(r.doc, FREE)).toBe(false);
    expect(errCode(() => addPageResult(r.doc, 5, undefined, FREE))).toBe("page_limit");
  });

  it("20 pages: a spread on page 19 merges pages 19 + 20 (no new page needed)", () => {
    const d = docOf(20);
    const r = changeLayout(d, 18, "m-l-spread-mosaic", { maxPages: FREE });
    expect(r.pagesAdded).toBe(0);
    expect(r.doc.pages).toHaveLength(FREE);
    expect(r.doc.pages[18].slots.filter((s) => s.photoId).length).toBe(2);
    expect(validateEditorDoc(r.doc, ctx(d)).ok).toBe(true);
    // Right page (odd index) can't start a spread.
    expect(layoutOptions(d, 19, FREE).spreads.every((o) => o.disabled && o.reason === "Starts on a left page")).toBe(true);
  });

  it("server: 21 pages whose spread counts 2 → page_limit (paid: fine)", () => {
    const d = docOf(20);
    const withSpread = changeLayout(d, 18, "m-l-spread-panorama", { maxPages: FREE }).doc; // 20 pages
    const extra: BookPage = { id: "pgx", chapterId: "c1", layout: "m-l-one", slots: [{ photoId: null, crop: { ...CROP } }], caption: null };
    const d21 = { ...withSpread, pages: [...withSpread.pages, extra] };
    expect(validateEditorDoc(d21, ctx(d))).toEqual({ ok: false, code: "page_limit" });
    expect(validateEditorDoc(d21, ctx(d, LIMITS.paid.maxPages)).ok).toBe(true);
  });

  it("odd cap: a spread needing a new page at the cap is refused (op + picker reason)", () => {
    const d = docOf(19);
    expect(errCode(() => changeLayout(d, 18, "m-l-spread-grid", { maxPages: 19 }))).toBe("page_limit");
    const opts = layoutOptions(d, 18, 19);
    expect(opts.spreads.every((o) => o.disabled && o.reason === "No room for another page")).toBe(true);
  });

  it("save ignores client format/style: columns win", () => {
    const d = docOf(4);
    const tampered = { ...d, format: "A5_PORTRAIT", style: { ...d.style, designStyle: "classic" } };
    const r = validateEditorDoc(tampered, ctx(d));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.format).toBe("A5_LANDSCAPE");
    expect(r.doc.style.designStyle).toBe("modern");
  });
});
