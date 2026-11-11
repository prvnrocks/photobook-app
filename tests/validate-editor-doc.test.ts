// M5 T14 (tester): edge cases for the pure editor-save validator (D-036). The route-level
// behaviour lives in tests/doc-save-route.test.ts; this file pins the validator on its own.
import { describe, expect, it } from "vitest";
import { addPage, deletePage, movePage, setCaption, setCaptionFont, setCover } from "@/lib/book/edit-ops";
import { devPreviewDoc } from "@/lib/book/dev-preview";
import type { BookDoc } from "@/lib/book/types";
import { forcedMeta, validateEditorDoc, type EditorDocContext } from "@/lib/book/validate-editor-doc";

const ALL_IDS = new Set(Array.from({ length: 16 }, (_, i) => `d${i}`));

function ctx(over: Partial<EditorDocContext> = {}): EditorDocContext {
  return { photoIds: ALL_IDS, maxPages: 20, savedDoc: devPreviewDoc(), ...over };
}

function withChapters(doc: BookDoc): BookDoc {
  return {
    ...doc,
    chapters: [
      { id: "c1", title: "Morning", dateLabel: "1 Jan", place: null },
      { id: "c2", title: "Night", dateLabel: "1 Jan", place: "Abu Dhabi" },
    ],
    pages: doc.pages.map((p, i) => ({ ...p, chapterId: i < 3 ? "c1" : "c2" })),
  };
}

/** Grow the fixture to n pages by appending empty one-portrait pages. */
function grow(doc: BookDoc, n: number): BookDoc {
  let d = doc;
  while (d.pages.length < n) d = addPage(d, d.pages.length - 1, "one-portrait", 100);
  return d;
}

describe("validateEditorDoc — shape and limits", () => {
  it("accepts the dev fixture and reports page count + placed ids", () => {
    const r = validateEditorDoc(devPreviewDoc(), ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pageCount).toBe(devPreviewDoc().pages.length);
    expect(r.placedPhotoIds).toContain("d0"); // cover
    expect(new Set(r.placedPhotoIds).size).toBe(r.placedPhotoIds.length);
    expect(r.doc.meta?.userEdited).toBe(true);
  });

  it.each([null, undefined, 42, "doc", [], {}])("non-object / empty input %j → invalid_doc", (input) => {
    expect(validateEditorDoc(input, ctx())).toEqual({ ok: false, code: "invalid_doc" });
  });

  it("exactly maxPages is fine, maxPages + 1 is page_limit (free 20 / paid 100)", () => {
    const d20 = grow(devPreviewDoc(), 20);
    expect(validateEditorDoc(d20, ctx()).ok).toBe(true);
    const d21 = grow(devPreviewDoc(), 21);
    expect(validateEditorDoc(d21, ctx())).toEqual({ ok: false, code: "page_limit" });
    expect(validateEditorDoc(d21, ctx({ maxPages: 100 })).ok).toBe(true);
  });

  it("page_limit wins over other problems in a 21-page doc (raw page count checked first)", () => {
    const d21 = grow(devPreviewDoc(), 21);
    const broken = { ...d21, version: 2 }; // would be invalid_doc
    expect(validateEditorDoc(broken, ctx())).toEqual({ ok: false, code: "page_limit" });
  });

  it("a book with zero pages is valid (all pages deleted)", () => {
    let d = devPreviewDoc();
    while (d.pages.length) d = deletePage(d, 0);
    const r = validateEditorDoc(d, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pageCount).toBe(0);
  });

  it("unknown layout, cover layout on a page, wrong slot count → invalid_doc", () => {
    const base = devPreviewDoc();
    const unknown = { ...base, pages: base.pages.map((p, i) => (i === 0 ? { ...p, layout: "nope" } : p)) };
    expect(validateEditorDoc(unknown, ctx())).toEqual({ ok: false, code: "invalid_doc" });
    const coverOnPage = { ...base, pages: base.pages.map((p, i) => (i === 0 ? { ...p, layout: "cover" } : p)) };
    expect(validateEditorDoc(coverOnPage, ctx())).toEqual({ ok: false, code: "invalid_doc" });
    const slots = { ...base, pages: base.pages.map((p, i) => (i === 0 ? { ...p, slots: [...p.slots, p.slots[0]] } : p)) };
    // extra slot duplicates a photo → duplicate_photo is detected before the structural check
    expect(validateEditorDoc(slots, ctx()).ok).toBe(false);
  });

  it("duplicate page ids and dangling chapterId → invalid_doc", () => {
    const base = withChapters(devPreviewDoc());
    const dupId = { ...base, pages: base.pages.map((p, i) => (i === 1 ? { ...p, id: base.pages[0].id } : p)) };
    expect(validateEditorDoc(dupId, ctx())).toEqual({ ok: false, code: "invalid_doc" });
    const dangling = { ...base, pages: base.pages.map((p, i) => (i === 0 ? { ...p, chapterId: "ghost" } : p)) };
    expect(validateEditorDoc(dangling, ctx())).toEqual({ ok: false, code: "invalid_doc" });
  });

  it("crop out of range (zoom 5, x -0.1) → invalid_doc (schema bounds)", () => {
    const base = devPreviewDoc();
    for (const crop of [{ x: 0.5, y: 0.5, zoom: 5 }, { x: -0.1, y: 0.5, zoom: 1 }, { x: 0.5, y: 0.5, zoom: 0.5 }]) {
      const d = {
        ...base,
        pages: base.pages.map((p, i) => (i === 0 ? { ...p, slots: p.slots.map((s) => ({ ...s, crop })) } : p)),
      };
      expect(validateEditorDoc(d, ctx())).toEqual({ ok: false, code: "invalid_doc" });
    }
  });

  it("caption over 200 units or with a lone surrogate → invalid_doc", () => {
    const base = devPreviewDoc();
    const idx = base.pages.findIndex((p) => p.caption);
    const mk = (text: string) => ({
      ...base,
      pages: base.pages.map((p, i) => (i === idx ? { ...p, caption: { ...p.caption!, text } } : p)),
    });
    expect(validateEditorDoc(mk("a".repeat(201)), ctx())).toEqual({ ok: false, code: "invalid_doc" });
    expect(validateEditorDoc(mk("ok \ud83d"), ctx())).toEqual({ ok: false, code: "invalid_doc" });
    expect(validateEditorDoc(mk("a".repeat(200)), ctx()).ok).toBe(true);
  });

  it("meta with unknown keys → invalid_doc (strict meta)", () => {
    const d = { ...devPreviewDoc(), meta: { generator: "ai", generatorVersion: 1, runId: null, userEdited: true, x: 1 } };
    expect(validateEditorDoc(d, ctx())).toEqual({ ok: false, code: "invalid_doc" });
  });
});

describe("validateEditorDoc — photos", () => {
  it("photoIds come from the context only: an empty set rejects any placed photo", () => {
    expect(validateEditorDoc(devPreviewDoc(), ctx({ photoIds: new Set() }))).toEqual({ ok: false, code: "foreign_photo" });
  });

  it("cover photo may repeat once on a page, but a page photo may not repeat on pages", () => {
    const base = devPreviewDoc();
    const coverOnPage = setCover(base, { photoId: base.pages[0].slots[0].photoId });
    expect(validateEditorDoc(coverOnPage, ctx()).ok).toBe(true);
    const twice = {
      ...base,
      pages: base.pages.map((p, i) => (i === 1 ? { ...p, slots: p.slots.map(() => base.pages[0].slots[0]) } : p)),
    };
    expect(validateEditorDoc(twice, ctx())).toEqual({ ok: false, code: "duplicate_photo" });
  });

  it("placedPhotoIds deduplicates the cover photo that also sits on a page", () => {
    const base = devPreviewDoc();
    const id = base.pages[0].slots[0].photoId!;
    const r = validateEditorDoc(setCover(base, { photoId: id }), ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.placedPhotoIds.filter((x) => x === id)).toHaveLength(1);
  });

  it("no cover photo + all slots empty → ok with no placed photos", () => {
    const base = devPreviewDoc();
    const empty = {
      ...base,
      cover: { ...base.cover, photoId: null },
      pages: base.pages.map((p) => ({ ...p, slots: p.slots.map((s) => ({ ...s, photoId: null })) })),
    };
    const r = validateEditorDoc(empty, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.placedPhotoIds).toEqual([]);
  });
});

describe("validateEditorDoc — fonts", () => {
  it("every editor font is accepted on a caption", () => {
    const base = devPreviewDoc();
    const idx = base.pages.findIndex((p) => p.caption);
    for (const f of ["Inter", "Playfair", "Cairo", "Tajawal"] as const) {
      expect(validateEditorDoc(setCaptionFont(base, idx, f), ctx()).ok).toBe(true);
    }
  });

  it("a non-editor font on a NEW caption is invalid_font; kept legacy font on the same page is ok", () => {
    const base = devPreviewDoc();
    const idx = base.pages.findIndex((p) => p.caption);
    const legacySaved = {
      ...base,
      pages: base.pages.map((p, i) => (i === idx ? { ...p, caption: { ...p.caption!, font: "Georgia" } } : p)),
    };
    // The same legacy font stays on its page with edited text → ok.
    const edited = setCaption(legacySaved, idx, "New words");
    expect(edited.pages[idx].caption?.font).toBe("Georgia");
    expect(validateEditorDoc(edited, ctx({ savedDoc: legacySaved })).ok).toBe(true);
    // Against a saved doc without the legacy font → invalid_font.
    expect(validateEditorDoc(edited, ctx({ savedDoc: base }))).toEqual({ ok: false, code: "invalid_font" });
    // savedDoc {} (never saved) → invalid_font.
    expect(validateEditorDoc(edited, ctx({ savedDoc: {} }))).toEqual({ ok: false, code: "invalid_font" });
  });

  it("a legacy font survives a page reorder (keyed by page id, not index)", () => {
    const base = devPreviewDoc();
    const idx = base.pages.findIndex((p) => p.caption);
    const legacy = {
      ...base,
      pages: base.pages.map((p, i) => (i === idx ? { ...p, caption: { ...p.caption!, font: "Georgia" } } : p)),
    };
    const moved = movePage(legacy, idx, legacy.pages.length - 1);
    expect(validateEditorDoc(moved, ctx({ savedDoc: legacy })).ok).toBe(true);
  });

  it("style.font outside the editor fonts is invalid_font (T3 gap closed in the M5 review)", () => {
    const d = { ...devPreviewDoc(), style: { ...devPreviewDoc().style, font: "Comic Sans" } };
    expect(validateEditorDoc(d, ctx())).toEqual({ ok: false, code: "invalid_font" });
    expect(validateEditorDoc(d, ctx({ savedDoc: {} }))).toEqual({ ok: false, code: "invalid_font" });
  });

  it("every editor font is accepted as style.font; a saved legacy style.font may stay", () => {
    for (const f of ["Inter", "Playfair", "Cairo", "Tajawal"] as const) {
      const d = { ...devPreviewDoc(), style: { ...devPreviewDoc().style, font: f } };
      expect(validateEditorDoc(d, ctx()).ok).toBe(true);
    }
    const legacy = { ...devPreviewDoc(), style: { ...devPreviewDoc().style, font: "Georgia" } };
    expect(validateEditorDoc(legacy, ctx({ savedDoc: legacy })).ok).toBe(true);
    // Changing to a different non-editor font is still refused.
    const other = { ...legacy, style: { ...legacy.style, font: "Comic Sans" } };
    expect(validateEditorDoc(other, ctx({ savedDoc: legacy }))).toEqual({ ok: false, code: "invalid_font" });
  });
});

describe("validateEditorDoc — title + meta", () => {
  it("whitespace-only cover title → title null (keep books.title)", () => {
    const r = validateEditorDoc(setCover(devPreviewDoc(), { title: "   " }), ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBeNull();
  });

  it("Arabic title with emoji is clipped by code points, never splitting a surrogate pair", () => {
    const title = "👨‍👩‍👧 عائلتنا ".repeat(20);
    const d = setCover(devPreviewDoc(), { title });
    const r = validateEditorDoc(d, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok || r.title === null) return;
    expect([...r.title].length).toBeLessThanOrEqual(120);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(r.title)).toBe(false);
  });

  it("forcedMeta: saved AI meta wins over client meta; userEdited always true", () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const saved = { ...devPreviewDoc(), meta: { generator: "ai", generatorVersion: 3, runId, userEdited: false } };
    const client = { ...devPreviewDoc(), meta: { generator: "rule", generatorVersion: 1, runId: null, userEdited: false } };
    const r = validateEditorDoc(client, ctx({ savedDoc: saved }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.meta).toEqual({ generator: "ai", generatorVersion: 3, runId, userEdited: true });
  });

  it.each([null, undefined, "x", [], { meta: null }, { meta: [] }])("forcedMeta(%j) → rule defaults", (saved) => {
    expect(forcedMeta(saved)).toEqual({ generator: "rule", generatorVersion: 1, runId: null, userEdited: true });
  });

  it("does not mutate the input doc", () => {
    const d = devPreviewDoc();
    const snapshot = JSON.stringify(d);
    validateEditorDoc(d, ctx());
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});

describe("validateEditorDoc — format + design style from the book's columns (M10b A6, D-063)", () => {
  const PORTRAIT_CLASSIC = { format: "A5_PORTRAIT", designStyle: "classic" } as const;

  it("client format / designStyle are overwritten by ctx.design (no longer an error)", () => {
    const d = devPreviewDoc();
    const landscape = validateEditorDoc({ ...d, format: "A5_LANDSCAPE" }, ctx({ design: PORTRAIT_CLASSIC }));
    expect(landscape.ok && landscape.doc.format).toBe("A5_PORTRAIT");
    const scrapbook = validateEditorDoc({ ...d, style: { ...d.style, designStyle: "scrapbook" } }, ctx({ design: PORTRAIT_CLASSIC }));
    expect(scrapbook.ok && scrapbook.doc.style.designStyle).toBe("classic");
  });

  it("the columns win over the saved doc too", () => {
    const d = devPreviewDoc();
    const savedModern: BookDoc = { ...d, style: { ...d.style, designStyle: "modern" } };
    const r = validateEditorDoc(d, ctx({ savedDoc: savedModern, design: PORTRAIT_CLASSIC }));
    expect(r.ok && r.doc.style.designStyle).toBe("classic");
  });

  it("layouts of another format or style than the book's → invalid_doc", () => {
    const d = devPreviewDoc();
    // Classic portrait layouts in a landscape book / a modern book.
    expect(validateEditorDoc(d, ctx({ design: { format: "A5_LANDSCAPE", designStyle: "classic" } }))).toEqual({ ok: false, code: "invalid_doc" });
    expect(validateEditorDoc(d, ctx({ design: { format: "A5_PORTRAIT", designStyle: "modern" } }))).toEqual({ ok: false, code: "invalid_doc" });
  });

  it("no ctx.design (dev fixtures / tests only) → the saved doc's own design", () => {
    const d = devPreviewDoc();
    expect(validateEditorDoc({ ...d, format: "A5_LANDSCAPE" }, ctx({ savedDoc: {} })).ok).toBe(true);
    const savedModern: BookDoc = { ...d, style: { ...d.style, designStyle: "modern" } };
    expect(validateEditorDoc(d, ctx({ savedDoc: savedModern }))).toEqual({ ok: false, code: "invalid_doc" });
  });

  it("side is not pinned any more, but a side on a single-page layout is still invalid_doc", () => {
    const d = devPreviewDoc();
    const sided = { ...d, pages: d.pages.map((p, i) => (i === 1 ? { ...p, side: "right" as const } : p)) };
    expect(validateEditorDoc(sided, ctx({ design: PORTRAIT_CLASSIC }))).toEqual({ ok: false, code: "invalid_doc" });
    // Saved with a side, client removes it → fine now (the saved doc no longer pins sides).
    expect(validateEditorDoc(d, ctx({ savedDoc: sided, design: PORTRAIT_CLASSIC })).ok).toBe(true);
  });
});

describe("validateEditorDoc — texture tint must be a light swatch (review N9)", () => {
  const withTint = (tint: string | undefined, where: "book" | "page") => {
    const d = devPreviewDoc();
    const bg = { kind: "texture" as const, textureId: "kraft" as const, ...(tint === undefined ? {} : { tint }) };
    return where === "book"
      ? { ...d, style: { ...d.style, background: bg } }
      : { ...d, pages: d.pages.map((p, i) => (i === 0 ? { ...p, background: { ...bg, source: "user" as const } } : p)) };
  };

  it("light swatches (any case) and no tint pass, on the book default and on a page", () => {
    for (const where of ["book", "page"] as const) {
      for (const tint of [undefined, "#FFFFFF", "#CAD6C1", "#cad6c1", "#F5EEDC", "#CFCBC4"]) {
        expect(validateEditorDoc(withTint(tint, where), ctx()).ok, `${where} ${tint}`).toBe(true);
      }
    }
  });

  it("dark swatches and off-catalogue colours → invalid_doc", () => {
    for (const where of ["book", "page"] as const) {
      for (const tint of ["#1E2A47", "#111111", "#A65A3F", "#CAD6C2", "#000000"]) {
        expect(validateEditorDoc(withTint(tint, where), ctx()), `${where} ${tint}`).toEqual({ ok: false, code: "invalid_doc" });
      }
    }
  });
});

// M10b A19 (review B1): the v2 OFL faces are accepted as caption / book fonts for every book.
describe("validateEditorDoc — M10b fonts (review B1)", async () => {
  const { devSampleDoc, SAMPLE_PHOTO_COUNT } = await import("@/lib/book/dev-sample");
  const { usesV2Features, serializeDoc } = await import("@/lib/book/doc-version");
  const { getLayout } = await import("@/lib/layouts");
  const SAMPLE_IDS = new Set(["d0", ...Array.from({ length: SAMPLE_PHOTO_COUNT }, (_, i) => `sp${i}`)]);
  const modernCtx = (savedDoc: unknown): EditorDocContext => ({
    photoIds: SAMPLE_IDS,
    maxPages: 100,
    savedDoc,
    design: { format: "A5_PORTRAIT", designStyle: "modern" },
  });
  /** The modern sample with no captions at all (a fresh AI-less album). */
  function uncaptioned(): BookDoc {
    const d = devSampleDoc("modern-portrait");
    return { ...d, pages: d.pages.map((p) => ({ ...p, caption: null })) };
  }
  const captionable = (d: BookDoc) =>
    d.pages.findIndex((p) => p.side !== "right" && getLayout(p.layout)?.caption);

  it("modern book: the first user caption (Cormorant / Amiri via newCaptionFont) saves ok", () => {
    const saved = uncaptioned();
    const idx = captionable(saved);
    expect(idx).toBeGreaterThanOrEqual(0);
    const en = setCaption(saved, idx, "A day by the sea");
    expect(en.pages[idx].caption?.font).toBe("Cormorant");
    expect(validateEditorDoc(en, modernCtx(saved)).ok).toBe(true);
    const ar = setCaption(saved, idx, "يوم على البحر");
    expect(ar.pages[idx].caption?.font).toBe("Amiri");
    expect(validateEditorDoc(ar, modernCtx(saved)).ok).toBe(true);
  });

  it("modern book: a caption on a NEW page id (not in the saved doc) with a v2 face saves ok", () => {
    const saved = uncaptioned();
    const idx = captionable(saved);
    const d = setCaption(saved, idx, "Hello");
    const renamed = { ...d, pages: d.pages.map((p, i) => (i === idx ? { ...p, id: "brand-new" } : p)) };
    expect(validateEditorDoc(renamed, modernCtx(saved)).ok).toBe(true);
  });

  it("every M10b face is accepted as a caption font and as style.font", () => {
    for (const f of ["Cormorant", "Amiri", "Bebas", "Lalezar", "GreatVibes", "ArefRuqaa"] as const) {
      const base = devPreviewDoc();
      const idx = base.pages.findIndex((p) => p.caption);
      const d = setCaptionFont(base, idx, f);
      expect(validateEditorDoc(d, ctx({ savedDoc: {} })).ok).toBe(true);
      const s = { ...base, style: { ...base.style, font: f } };
      expect(validateEditorDoc(s, ctx({ savedDoc: {} })).ok).toBe(true);
    }
  });

  it("classic book stays v1 with M5 faces; choosing a v2 face makes it v2", () => {
    const base = devPreviewDoc();
    const idx = base.pages.findIndex((p) => p.caption);
    const plain = setCaption(base, idx, "Still classic");
    const r1 = validateEditorDoc(plain, ctx());
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(usesV2Features(r1.doc)).toBe(false);
      expect((serializeDoc(r1.doc) as { version: number }).version).toBe(1);
    }
    const pair = setCaptionFont(plain, idx, "Cormorant");
    const r2 = validateEditorDoc(pair, ctx());
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(usesV2Features(r2.doc)).toBe(true);
      expect((serializeDoc(r2.doc) as { version: number }).version).toBe(2);
    }
  });

  it("an unknown font is still invalid_font", () => {
    const saved = uncaptioned();
    const idx = captionable(saved);
    const d = setCaption(saved, idx, "x");
    const bad = { ...d, pages: d.pages.map((p, i) => (i === idx ? { ...p, caption: { ...p.caption!, font: "Comic" } } : p)) };
    expect(validateEditorDoc(bad, modernCtx(saved))).toEqual({ ok: false, code: "invalid_font" });
  });
});
