// M29 T8 — publish + save checks for the 22 user-chosen cover styles (M29_COVERS).
// * Public snapshot (toPublicDoc / parsePublicDoc / publicDocToRenderDoc): M29 cover ids survive a
//   JSON round trip; a classic portrait book with an M29 cover publishes v2 (the M9 viewer can't
//   draw it), and back on the M1 cover v1 again. `fit` is a LAYOUT field (catalogue), never a doc
//   field: a stray cover.fit is dropped by toPublicDoc / serializeDoc and rejected by the strict
//   snapshot schema; the viewer's panels (which use fit) equal the editor's.
// * Server-side editor save (validateEditorDoc): any M29 cover of the book's format + style is
//   accepted; one of another format or style → invalid_doc (setCoverLayout: layout_not_for_book).
// * Save path: a v1 classic portrait book switched to c-p-cover-window stores v2 and re-loads.

import { describe, expect, it } from "vitest";
import { serializeDoc, usesV2Features } from "@/lib/book/doc-version";
import { EditOpError, setCoverLayout } from "@/lib/book/edit-ops";
import { coverRenderModel } from "@/lib/book/render";
import { BOOK_FORMATS, DESIGN_STYLES, LayoutSchema, LayoutTextSchema, parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import { autoCoversFor, coverStylesFor, layoutsFor } from "@/lib/book/spreads";
import type { BookDoc, BookFormat, DesignStyle, Layout } from "@/lib/book/types";
import { validateEditorDoc } from "@/lib/book/validate-editor-doc";
import { CLASSIC_PORTRAIT_LAYOUTS, M29_COVERS } from "@/lib/layouts";
import { parsePublicDoc, publicDocToRenderDoc, publicPhotoIds, toPublicDoc } from "@/lib/publish/public-doc";
import { upgradeDocV1 } from "@/lib/book/doc-version";
import { devPreviewDoc } from "@/lib/book/dev-preview";
import { representativeDocV1 } from "./golden/m9-inputs";

const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COVER_PHOTO = pid(1);

interface Design {
  format: BookFormat;
  designStyle: DesignStyle;
}
const DESIGNS: Design[] = BOOK_FORMATS.flatMap((format) => DESIGN_STYLES.map((designStyle) => ({ format, designStyle })));
const fits = (l: Layout, d: Design) => l.format === d.format && l.style === d.designStyle;

/** A valid book of design `d` (its default auto cover + one filled page). */
function docFor(d: Design, coverId = autoCoversFor(d.format, d.designStyle)[0].id): BookDoc {
  const page = layoutsFor(d.format, d.designStyle, "page").find((l) => l.photoCount >= 1)!;
  return {
    version: 2,
    format: d.format,
    occasion: "family",
    cover: { layout: coverId, photoId: COVER_PHOTO, title: "Eid at home", subtitle: "2026" },
    chapters: [{ id: "c1", title: "Morning", dateLabel: "March 2026", place: "Abu Dhabi" }],
    pages: [
      {
        id: "pg0",
        chapterId: "c1",
        layout: page.id,
        slots: Array.from({ length: page.slots.length }, (_, i) => ({ photoId: pid(10 + i), crop: { x: 0.5, y: 0.5, zoom: 1 } })),
        caption: page.caption ? { text: "عيد سعيد", font: "Cairo", align: "center", source: "user" } : null,
      },
    ],
    style: { background: { kind: "color", hex: "#F5EFE6" }, designStyle: d.designStyle, font: "Playfair" },
  };
}
const designOf = (l: Layout): Design => ({ format: l.format, designStyle: l.style });
const docWithCover = (l: Layout) => docFor(designOf(l), l.id);
const photoIdsOf = (d: BookDoc) => new Set([d.cover.photoId!, ...d.pages.flatMap((p) => p.slots.map((s) => s.photoId!))]);
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof EditOpError ? e.code : `other: ${String(e)}`;
  }
  return null;
};
const RENDER_PHOTOS = { [COVER_PHOTO]: { url: "https://x.test/c.jpg", width: 4000, height: 3000 } };

describe("M29 covers: catalogue + LayoutText.fit", () => {
  it("every design gets its M29 covers via coverStylesFor, never via autoCoversFor", () => {
    for (const d of DESIGNS) {
      const mine = M29_COVERS.filter((l) => fits(l, d)).map((l) => l.id);
      expect(mine.length, `${d.format}/${d.designStyle}`).toBeGreaterThanOrEqual(2);
      const all = coverStylesFor(d.format, d.designStyle).map((l) => l.id);
      const auto = autoCoversFor(d.format, d.designStyle).map((l) => l.id);
      for (const id of mine) {
        expect(all).toContain(id);
        expect(auto).not.toContain(id);
      }
    }
  });

  it("fit is a layout field: 0.5–1 or absent; M29 covers that set it pass LayoutSchema", () => {
    const base = { bind: "coverTitle", box: { x: 0, y: 0, w: 100, h: 100 }, align: "center", font: "title" };
    expect(LayoutTextSchema.safeParse(base).success).toBe(true);
    expect(LayoutTextSchema.safeParse({ ...base, fit: 0.75 }).success).toBe(true);
    expect(LayoutTextSchema.safeParse({ ...base, fit: 0.4 }).success).toBe(false);
    expect(LayoutTextSchema.safeParse({ ...base, fit: 1.1 }).success).toBe(false);
    const withFit = M29_COVERS.filter((l) => l.texts?.some((t) => t.fit !== undefined));
    expect(withFit.map((l) => l.id).sort()).toEqual(["g-l-cover-hex"]);
    for (const l of M29_COVERS) expect(LayoutSchema.safeParse(l).success, l.id).toBe(true);
  });
});

describe.each(M29_COVERS.map((l) => [l.id, l] as const))("publish: %s", (_id, l) => {
  it("snapshot round-trips through JSON (v2), cover id + photo kept, no `fit` anywhere", () => {
    const doc = docWithCover(l);
    const pub = toPublicDoc(doc, { captionLang: "en" });
    expect(pub.version).toBe(2);
    const json = JSON.stringify(pub);
    expect(json).not.toContain('"fit"');
    const parsed = parsePublicDoc(JSON.parse(json));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc).toEqual(pub);
    expect(parsed.doc.cover.layout).toBe(l.id);
    // OG / viewer: the cover photo is the first public photo.
    expect(publicPhotoIds(parsed.doc)[0]).toBe(COVER_PHOTO);
  });

  it("the viewer draws the same cover as the editor (panels sized with the layout's fit)", () => {
    // occasion is not published (privacy), so the viewer renders the "other" occasion accent
    // sticker — pre-existing for every scrapbook layout with "occasion-accent" since M10c. Compare
    // against the same doc with occasion "other"; the rest (slot, panels, fit) must match exactly.
    const doc = { ...docWithCover(l), occasion: "other" as const };
    const render = publicDocToRenderDoc(toPublicDoc(doc));
    expect(render.cover.layout).toBe(l.id);
    expect(coverRenderModel(render, RENDER_PHOTOS, "en")).toEqual(coverRenderModel(doc, RENDER_PHOTOS, "en"));
    expect(coverRenderModel(render, RENDER_PHOTOS, "en", { bleed: true })).toEqual(
      coverRenderModel(doc, RENDER_PHOTOS, "en", { bleed: true }),
    );
  });

  it("a stray cover.fit in a doc is dropped on save and on publish; the strict snapshot rejects it", () => {
    const doc = docWithCover(l);
    const dirty = { ...doc, cover: { ...doc.cover, fit: 0.75 } } as unknown as BookDoc;
    const parsed = parseBookDoc(JSON.parse(JSON.stringify(dirty)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.stringify(serializeDoc(parsed.doc))).not.toContain('"fit"');
    expect(JSON.stringify(toPublicDoc(dirty))).not.toContain('"fit"');
    const pub = JSON.parse(JSON.stringify(toPublicDoc(doc)));
    pub.cover.fit = 0.75;
    expect(parsePublicDoc(pub).ok).toBe(false);
  });

  it("server save accepts it for its own format + style; stored JSON re-loads to the same doc", () => {
    const doc = docWithCover(l);
    const r = validateEditorDoc(doc, { photoIds: photoIdsOf(doc), maxPages: 20, savedDoc: {}, design: designOf(l) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.cover.layout).toBe(l.id);
    expect(r.placedPhotoIds).toContain(COVER_PHOTO);
    const stored = JSON.parse(JSON.stringify(serializeDoc(r.doc)));
    expect(stored.version).toBe(2); // every M29 cover is outside CLASSIC_PORTRAIT_LAYOUTS
    const back = parseBookDoc(stored);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.doc).toEqual(r.doc);
    // A second save of the re-loaded doc is accepted too.
    expect(validateEditorDoc(stored, { photoIds: photoIdsOf(doc), maxPages: 20, savedDoc: stored, design: designOf(l) }).ok).toBe(true);
  });

  it("any other design rejects it: invalid_doc on save, layout_not_for_book in the editor op", () => {
    for (const d of DESIGNS.filter((d) => !fits(l, d))) {
      const own = docFor(d);
      expect(validateBookDoc(own, { photoIds: photoIdsOf(own), maxPages: 20 }), `${d.format}/${d.designStyle}`).toEqual([]);
      const bad = { ...own, cover: { ...own.cover, layout: l.id } };
      const ctx = { photoIds: photoIdsOf(own), maxPages: 20, savedDoc: {}, design: d };
      expect(validateEditorDoc(bad, ctx), `${l.id} on ${d.format}/${d.designStyle}`).toEqual({ ok: false, code: "invalid_doc" });
      expect(validateBookDoc(bad, { photoIds: photoIdsOf(own), maxPages: 20 }).some((i) => i.startsWith("cover:"))).toBe(true);
      expect(code(() => setCoverLayout(own, l.id))).toBe("layout_not_for_book");
    }
  });
});

describe("save path: v1 classic portrait book → M29 classic portrait cover", () => {
  const CLASSIC_PORTRAIT_M29 = M29_COVERS.filter((l) => l.format === "A5_PORTRAIT" && l.style === "classic");
  const v1Ids = new Set(CLASSIC_PORTRAIT_LAYOUTS.map((l) => l.id));

  it("the classic portrait M29 covers are outside the M9 set (force v2)", () => {
    expect(CLASSIC_PORTRAIT_M29.map((l) => l.id).sort()).toEqual(["c-p-cover-split", "c-p-cover-title-first", "c-p-cover-window"]);
    for (const l of CLASSIC_PORTRAIT_M29) expect(v1Ids.has(l.id), l.id).toBe(false);
  });

  it("c-p-cover-window: saves as v2, re-loads, publishes v2; switching back to the M1 cover is v1 again (byte-identical)", () => {
    // The editor dev fixture: a classic portrait book that stores as v1 (editor-valid, unlike the
    // m9 render fixture, which repeats photos).
    const v1Json = JSON.parse(JSON.stringify(serializeDoc(devPreviewDoc())));
    expect(v1Json.version).toBe(1);
    const loaded = parseBookDoc(v1Json);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const original = loaded.doc;
    expect(usesV2Features(original)).toBe(false);
    expect(serializeDoc(original).version).toBe(1);

    const photoIds = photoIdsOf(original);
    const ctx = { photoIds, maxPages: 100, savedDoc: v1Json, design: { format: "A5_PORTRAIT" as const, designStyle: "classic" as const } };

    const edited = setCoverLayout(original, "c-p-cover-window");
    expect(edited.cover).toEqual({ ...original.cover, layout: "c-p-cover-window" });
    const saved = validateEditorDoc(edited, ctx);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const stored = JSON.parse(JSON.stringify(serializeDoc(saved.doc)));
    expect(stored.version).toBe(2);
    expect(stored.cover.layout).toBe("c-p-cover-window");

    // Re-load (editor / print / publish all start from parseBookDoc of the stored JSON).
    const reloaded = parseBookDoc(stored);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.doc).toEqual(saved.doc);
    expect(validateEditorDoc(stored, { ...ctx, savedDoc: stored }).ok).toBe(true);
    const pub = toPublicDoc(reloaded.doc);
    expect(pub.version).toBe(2);
    expect(parsePublicDoc(JSON.parse(JSON.stringify(pub))).ok).toBe(true);

    // Back to the M1 cover → v1 JSON again, identical to the original apart from the forced meta.
    const back = setCoverLayout(reloaded.doc, "cover");
    const backSaved = validateEditorDoc(back, { ...ctx, savedDoc: stored });
    expect(backSaved.ok).toBe(true);
    if (!backSaved.ok) return;
    const backStored = serializeDoc(backSaved.doc);
    expect(backStored.version).toBe(1);
    expect(JSON.stringify({ ...backStored, meta: undefined })).toBe(
      JSON.stringify({ ...serializeDoc(upgradeDocV1(v1Json)), meta: undefined }),
    );
    expect(toPublicDoc(backSaved.doc).version).toBe(1);
  });

  it.each(CLASSIC_PORTRAIT_M29.map((l) => l.id))("%s on a v1 book serialises v2 and round-trips", (id) => {
    const loaded = parseBookDoc(JSON.parse(JSON.stringify(representativeDocV1())));
    if (!loaded.ok) throw new Error("fixture");
    const edited = setCoverLayout(loaded.doc, id);
    expect(usesV2Features(edited)).toBe(true);
    const stored = JSON.parse(JSON.stringify(serializeDoc(edited)));
    expect(stored.version).toBe(2);
    const back = parseBookDoc(stored);
    expect(back.ok && back.doc.cover.layout).toBe(id);
  });
});
