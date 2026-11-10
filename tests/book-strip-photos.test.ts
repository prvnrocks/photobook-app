// M10a review S3/B1: removing references to deleted photos from a book doc.
import { describe, expect, it } from "vitest";
import { serializeDoc } from "@/lib/book/doc-version";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import { FALLBACK_BOOK_BACKGROUND, stripMissingBackgrounds, stripPhotoFromDoc } from "@/lib/book/strip-photos";
import type { BookDoc, BookPage } from "@/lib/book/types";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const photoBg = (photoId: string) => ({ kind: "photo" as const, photoId, veil: 0.6, veilColor: "#FFFFFF" });
const page = (id: string, layout: string, ids: (string | null)[], extra: Partial<BookPage> = {}): BookPage => ({
  id,
  chapterId: null,
  layout,
  slots: ids.map((photoId) => ({ photoId, crop: { x: 0.5, y: 0.5, zoom: 1 } })),
  caption: null,
  ...extra,
});
function doc(): BookDoc {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "travel",
    cover: { layout: "cover", photoId: A, title: "T", subtitle: "" },
    chapters: [],
    pages: [
      page("p1", "two-vertical", [A, B], { background: { ...photoBg(C), source: "user" } }),
      page("p2", "one-portrait", [C]),
    ],
    style: { background: photoBg(B), designStyle: "classic", font: "Playfair" },
    meta: { generator: "rule", generatorVersion: 1, runId: null, userEdited: true },
  };
}

describe("stripPhotoFromDoc", () => {
  it("cover + slots → null, layouts and page count unchanged", () => {
    const d = doc();
    const r = stripPhotoFromDoc(d, A);
    expect(r.changed).toBe(true);
    expect(r.doc.cover.photoId).toBeNull();
    expect(r.doc.pages[0].slots.map((s) => s.photoId)).toEqual([null, B]);
    expect(r.doc.pages.map((p) => p.layout)).toEqual(["two-vertical", "one-portrait"]);
    expect(r.doc.pages[1]).toBe(d.pages[1]);
    expect(validateBookDoc(r.doc, { photoIds: new Set([B, C]), maxPages: 20 })).toEqual([]);
    expect(d.cover.photoId).toBe(A); // input not mutated
  });

  it("book default background using the photo → white colour; the slot is emptied too", () => {
    const r = stripPhotoFromDoc(doc(), B);
    expect(r.doc.style.background).toEqual(FALLBACK_BOOK_BACKGROUND);
    expect(r.doc.pages[0].slots.map((s) => s.photoId)).toEqual([A, null]);
    expect(r.doc.pages[0].background).toEqual({ ...photoBg(C), source: "user" });
  });

  it("page override using the photo → removed (falls back to the book default)", () => {
    const r = stripPhotoFromDoc(doc(), C);
    expect("background" in r.doc.pages[0]).toBe(false);
    expect(r.doc.pages[1].slots[0].photoId).toBeNull();
    expect(r.doc.style.background).toEqual(photoBg(B));
    expect(parseBookDoc(serializeDoc(r.doc)).ok).toBe(true);
  });

  it("unrelated photo → same object, changed:false", () => {
    const d = doc();
    const r = stripPhotoFromDoc(d, "44444444-4444-4444-8444-444444444444");
    expect(r).toEqual({ doc: d, changed: false });
    expect(r.doc).toBe(d);
  });

  it("removing the last v2 feature lets the doc serialize as v1 again", () => {
    const d = doc();
    d.style = { ...d.style, background: { kind: "color", hex: "#FFFFFF" } };
    d.pages[0] = { ...d.pages[0], background: { ...photoBg(C), source: "user" } };
    const r = stripPhotoFromDoc(d, C);
    expect((serializeDoc(r.doc) as { version: number }).version).toBe(1);
  });
});

describe("stripMissingBackgrounds", () => {
  it("keeps backgrounds whose photo exists, drops the rest", () => {
    const d = doc();
    expect(stripMissingBackgrounds(d, () => true)).toEqual({ doc: d, changed: false });
    const r = stripMissingBackgrounds(d, (id) => id === B);
    expect(r.changed).toBe(true);
    expect(r.doc.style.background).toEqual(photoBg(B));
    expect("background" in r.doc.pages[0]).toBe(false);
    expect(r.doc.pages[0].slots).toBe(d.pages[0].slots); // slots untouched
  });
});
