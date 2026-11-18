// D-089: photo filters — catalogue + maths (screen CSS vs print affine), the print copy, the doc
// field (edit op, v1/v2 storage, save validator, publish snapshot, photo deletion), default looks
// for new albums and the rendered markup.
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

import { BookPage } from "@/components/book/BookPage";
import { filterTarget, photoFilterTool } from "@/components/editor/tools/photo-filter";
import { EDITOR_TOOLS } from "@/components/editor/tools/registry";
import { autolayout } from "@/lib/autolayout";
import { placedPhotoIds, withDefaultFilters } from "@/lib/book/default-filters";
import { devPreviewDoc } from "@/lib/book/dev-preview";
import { serializeDoc } from "@/lib/book/doc-version";
import { EditOpError, replacePhoto, setPhotoFilter } from "@/lib/book/edit-ops";
import { coverRenderModel, pageRenderModel } from "@/lib/book/render";
import { parseBookDoc } from "@/lib/book/schema";
import { stripPhotoFromDoc } from "@/lib/book/strip-photos";
import type { BookDoc } from "@/lib/book/types";
import { validateEditorDoc } from "@/lib/book/validate-editor-doc";
import { DEFAULT_FILTER_POOL, DEFAULT_FILTER_SHARE, defaultPhotoFilters } from "@/lib/design/photo-filter-defaults";
import { applyAffine, applyCssOps, filterAffine } from "@/lib/design/photo-filter-matrix";
import { filterCss, isPhotoFilterId, PHOTO_FILTER_IDS, PHOTO_FILTERS, type PhotoFilterId } from "@/lib/design/photo-filters";
import { applyPhotoFilter, encodePrintImage } from "@/lib/pdf/images";
import { parsePublicDoc, publicDocToRenderDoc, toPublicDoc } from "@/lib/publish/public-doc";
import { momentSet } from "./fixtures/autolayout-sets";

const stored = (d: BookDoc): unknown => JSON.parse(JSON.stringify(serializeDoc(d)));
const firstPhoto = (d: BookDoc) => d.pages.flatMap((p) => p.slots.map((s) => s.photoId)).find((id): id is string => !!id)!;

describe("catalogue", () => {
  it("ids match the catalogue, unique, with short labels; the asked-for looks are there", () => {
    expect(PHOTO_FILTERS.map((f) => f.id)).toEqual([...PHOTO_FILTER_IDS]);
    expect(new Set(PHOTO_FILTER_IDS).size).toBe(PHOTO_FILTER_IDS.length);
    for (const f of PHOTO_FILTERS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.label.length).toBeLessThanOrEqual(14);
      expect(f.ops.length).toBeGreaterThan(0);
    }
    for (const id of ["mono", "noir", "sepia", "soft", "vivid"]) expect(isPhotoFilterId(id)).toBe(true);
    expect(isPhotoFilterId("nope")).toBe(false);
    expect(isPhotoFilterId("constructor")).toBe(false);
  });

  it("filterCss: standard CSS functions in order; nothing for none / unknown", () => {
    expect(filterCss("vivid")).toBe("saturate(1.35) contrast(1.1) brightness(1.03)");
    expect(filterCss("rose")).toContain("hue-rotate(-12deg)");
    expect(filterCss("mono")).toBe("grayscale(1) contrast(1.05)");
    expect(filterCss(null)).toBeUndefined();
    expect(filterCss("nope")).toBeUndefined();
    for (const f of PHOTO_FILTERS) expect(filterCss(f.id)).toMatch(/^[a-z-]+\([-\d.]+(deg)?\)( [a-z-]+\([-\d.]+(deg)?\))*$/);
  });
});

describe("screen and print agree", () => {
  const grid: [number, number, number][] = [];
  for (const r of [0.08, 0.3, 0.55, 0.8, 0.95]) for (const g of [0.1, 0.45, 0.75, 0.92]) for (const b of [0.05, 0.4, 0.7, 0.9]) grid.push([r, g, b]);

  it("the composed transform (print) equals the CSS chain (screen) on a colour grid, within 2 % per channel", () => {
    for (const f of PHOTO_FILTERS) {
      const t = filterAffine(f.id)!;
      let worst = 0;
      for (const c of grid) {
        const a = applyAffine(t, c);
        const b = applyCssOps(f.id, c);
        for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      }
      expect(worst, f.id).toBeLessThan(0.02);
    }
  });

  it("black & white looks are grey; identity for none", () => {
    for (const id of ["mono", "noir", "silver"] as PhotoFilterId[]) {
      const [r, g, b] = applyAffine(filterAffine(id)!, [0.8, 0.3, 0.1]);
      expect(Math.abs(r - g)).toBeLessThan(1e-6);
      expect(Math.abs(g - b)).toBeLessThan(1e-6);
    }
    expect(filterAffine(null)).toBeNull();
    expect(filterAffine("nope")).toBeNull();
  });

  it("sharp applies the same transform to real pixels (recomb + linear, in that order)", async () => {
    const px: [number, number, number][] = [
      [200, 60, 30],
      [30, 120, 210],
      [128, 128, 128],
      [240, 230, 90],
    ];
    const input = Buffer.from(px.flat());
    for (const f of PHOTO_FILTERS) {
      const t = filterAffine(f.id)!;
      const out = await applyPhotoFilter(sharp(input, { raw: { width: 4, height: 1, channels: 3 } }), t).raw().toBuffer();
      px.forEach((c, i) => {
        const want = applyAffine(t, [c[0] / 255, c[1] / 255, c[2] / 255]).map((v) => Math.round(v * 255));
        for (let ch = 0; ch < 3; ch++) expect(Math.abs(out[i * 3 + ch] - want[ch]), `${f.id} px${i} ch${ch}`).toBeLessThanOrEqual(1);
      });
    }
  });

  it("encodePrintImage bakes the filter into the print copy (JPEG, same size); none / unknown = unchanged", async () => {
    const src = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 60, b: 30 } } }).png().toBuffer();
    const target = { width: 64, height: 48 };
    const plain = await encodePrintImage(src, target);
    const mono = await encodePrintImage(src, target, undefined, "mono");
    const meta = await sharp(mono).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([64, 48]);
    const p = await sharp(mono).raw().toBuffer();
    expect(Math.abs(p[0] - p[1])).toBeLessThanOrEqual(3); // grey
    expect(Math.abs(p[1] - p[2])).toBeLessThanOrEqual(3);
    const q = await sharp(plain).raw().toBuffer();
    expect(q[0] - q[2]).toBeGreaterThan(100); // still red
    expect((await encodePrintImage(src, target, undefined, "nope")).equals(plain)).toBe(true);
    expect((await encodePrintImage(src, target, undefined, null)).equals(plain)).toBe(true);
  });
});

describe("doc.filters", () => {
  it("setPhotoFilter: sets, changes, clears (key dropped when empty); follows the photo, not the slot", () => {
    const doc = devPreviewDoc();
    const id = firstPhoto(doc);
    const a = setPhotoFilter(doc, id, "noir");
    expect(a.filters).toEqual({ [id]: "noir" });
    expect(setPhotoFilter(a, id, "noir")).toBe(a);
    expect(setPhotoFilter(a, id, "sepia").filters).toEqual({ [id]: "sepia" });
    const cleared = setPhotoFilter(a, id, null);
    expect("filters" in cleared).toBe(false);
    expect(setPhotoFilter(doc, id, null)).toBe(doc);
    expect(() => setPhotoFilter(doc, id, "nope" as PhotoFilterId)).toThrow(EditOpError);
    expect(() => setPhotoFilter(doc, "not-in-book", "noir")).toThrow(EditOpError);
    // Moving the photo to another slot keeps its look (the map is keyed by photo).
    const moved = replacePhoto(a, 1, 0, id);
    expect(moved.filters).toEqual({ [id]: "noir" });
  });

  it("stored in v1 and v2 docs alike (not a v2 feature) and survives a round trip; unknown ids reject", () => {
    const doc = devPreviewDoc();
    const baseVersion = (stored(doc) as { version: number }).version;
    const id = firstPhoto(doc);
    const s = stored(setPhotoFilter(doc, id, "golden")) as { version: number; filters?: Record<string, string> };
    expect(s.version).toBe(baseVersion);
    expect(s.filters).toEqual({ [id]: "golden" });
    const back = parseBookDoc(s);
    expect(back.ok && back.doc.filters).toEqual({ [id]: "golden" });
    expect("filters" in (stored(doc) as object)).toBe(false);
    expect(parseBookDoc({ ...s, filters: { [id]: "nope" } }).ok).toBe(false);
    expect(parseBookDoc({ ...s, filters: [] }).ok).toBe(false);
  });

  it("save validator keeps filters of the book's photos and drops the rest", () => {
    const doc = setPhotoFilter(devPreviewDoc(), firstPhoto(devPreviewDoc()), "film");
    const id = firstPhoto(doc);
    const ids = new Set(placedPhotoIds(doc));
    const ctx = { photoIds: ids, maxPages: 20, savedDoc: null } as unknown as Parameters<typeof validateEditorDoc>[1];
    const withStray = { ...(stored(doc) as object), filters: { [id]: "film", "gone-photo": "noir" } };
    const r = validateEditorDoc(withStray, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.filters).toEqual({ [id]: "film" });
    const bad = validateEditorDoc({ ...(stored(doc) as object), filters: { [id]: "nope" } }, ctx);
    expect(bad.ok).toBe(false);
  });

  it("published snapshot: filters of shown photos only; renders back; strict", () => {
    const base = devPreviewDoc();
    const id = firstPhoto(base);
    const doc = { ...setPhotoFilter(base, id, "velvet"), filters: { [id]: "velvet", "unplaced-photo": "noir" } } as BookDoc;
    const pub = toPublicDoc(doc);
    expect((pub as { filters?: unknown }).filters).toEqual({ [id]: "velvet" });
    const parsed = parsePublicDoc(JSON.parse(JSON.stringify(pub)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(publicDocToRenderDoc(parsed.doc).filters).toEqual({ [id]: "velvet" });
    expect("filters" in toPublicDoc(base)).toBe(false);
    expect(parsePublicDoc({ ...JSON.parse(JSON.stringify(pub)), filters: { [id]: "nope" } }).ok).toBe(false);
  });

  it("deleting a photo removes its filter (no trace of the id)", () => {
    const base = devPreviewDoc();
    const id = firstPhoto(base);
    const other = placedPhotoIds(base).find((x) => x !== id)!;
    const doc = setPhotoFilter(setPhotoFilter(base, id, "noir"), other, "soft");
    const out = stripPhotoFromDoc(doc, id);
    expect(out.changed).toBe(true);
    expect(out.doc.filters).toEqual({ [other]: "soft" });
    expect(JSON.stringify(out.doc)).not.toContain(`"${id}"`);
    const last = stripPhotoFromDoc(setPhotoFilter(base, id, "noir"), id);
    expect("filters" in last.doc).toBe(false);
  });
});

describe("default looks for a new album", () => {
  it("deterministic, from the gentle pool, on roughly a third of the photos", () => {
    const ids = Array.from({ length: 600 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const a = defaultPhotoFilters(ids);
    expect(defaultPhotoFilters(ids)).toEqual(a);
    expect(defaultPhotoFilters([...ids].reverse())).toEqual(a);
    const share = Object.keys(a).length / ids.length;
    expect(share).toBeGreaterThan(DEFAULT_FILTER_SHARE - 0.08);
    expect(share).toBeLessThan(DEFAULT_FILTER_SHARE + 0.08);
    for (const f of Object.values(a)) expect(DEFAULT_FILTER_POOL).toContain(f);
    expect(new Set(Object.values(a)).size).toBeGreaterThan(3); // a mix, not one look
  });

  it("the rule album builder assigns them to placed photos only; the doc still validates", () => {
    const photos = momentSet(40, 7);
    const doc = autolayout(photos, { occasion: "travel", title: null, captionLang: "en", isPaid: false });
    const placed = new Set(placedPhotoIds(doc));
    const keys = Object.keys(doc.filters ?? {});
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(placed.has(k)).toBe(true);
    expect(parseBookDoc(stored(doc)).ok).toBe(true);
    expect(withDefaultFilters(doc).filters).toEqual(doc.filters);
  });
});

describe("rendering", () => {
  const photosOf = (doc: BookDoc) => Object.fromEntries(placedPhotoIds(doc).map((id) => [id, { url: `https://x.test/${id}.jpg`, width: 1200, height: 900 }]));

  it("render model carries the filter only for filtered photos (unfiltered slots keep their shape)", () => {
    const base = devPreviewDoc();
    const id = base.pages[0].slots[0].photoId!;
    const doc = setPhotoFilter(base, id, "golden");
    const m = pageRenderModel(doc, 0, photosOf(doc), "en")!;
    expect(m.slots[0].photo).toMatchObject({ filter: "golden" });
    const plain = pageRenderModel(base, 0, photosOf(base), "en")!;
    expect(Object.keys(plain.slots[0].photo!)).toEqual(["url", "style"]);
    if (doc.cover.photoId) {
      const c = coverRenderModel(setPhotoFilter(doc, doc.cover.photoId, "mono"), photosOf(doc), "en");
      expect(c.slot?.photo).toMatchObject({ filter: "mono" });
    }
  });

  it("screen: CSS filter on the photo; print: none (the print copy is pre-filtered)", () => {
    const base = devPreviewDoc();
    const id = base.pages[0].slots[0].photoId!;
    const doc = setPhotoFilter(base, id, "noir");
    const view = renderToStaticMarkup(<BookPage doc={doc} page={0} mode="view" photos={photosOf(doc)} captionLang="en" />);
    expect(view).toContain("filter:grayscale(1) brightness(0.95) contrast(1.25)");
    expect(view).toContain('data-photo-filter="noir"');
    const print = renderToStaticMarkup(<BookPage doc={doc} page={0} mode="print" photos={photosOf(doc)} captionLang="en" />);
    expect(print).not.toMatch(/filter:\s*grayscale/);
    expect(print).toContain('data-photo-filter="noir"');
    // An unfiltered book renders exactly as before.
    expect(renderToStaticMarkup(<BookPage doc={base} page={0} mode="view" photos={photosOf(base)} captionLang="en" />)).not.toContain("filter");
  });
});

describe("Filter tool", () => {
  it("registered for a filled slot and the cover photo; primary; docked on phones", () => {
    expect(EDITOR_TOOLS).toContain(photoFilterTool);
    expect(photoFilterTool.scopes).toEqual(["slot", "cover"]);
    expect(photoFilterTool.tier).toBe("primary");
    expect(photoFilterTool.dockOnMobile).toBe(true);
    const doc = setPhotoFilter(devPreviewDoc(), devPreviewDoc().pages[0].slots[0].photoId!, "soft");
    const ctx = (selection: unknown) => ({ state: { doc, selection }, photos: { thumbs: {}, web: {} } }) as unknown as Parameters<typeof filterTarget>[0];
    expect(filterTarget(ctx({ kind: "slot", pageIdx: 0, slotIdx: 0 }))).toMatchObject({ photoId: doc.pages[0].slots[0].photoId, current: "soft" });
    expect(filterTarget(ctx({ kind: "cover", part: "text" }))).toBeNull();
    expect(filterTarget(ctx(null))).toBeNull();
  });
});
