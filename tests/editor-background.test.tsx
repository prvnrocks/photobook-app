// M10a A8: background edit ops, save validation of backgrounds, and the Background picker tool.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EditorContextValue } from "@/components/editor/editor-context";
import type { EditorPhotos } from "@/components/editor/usePhotoUrls";
import { BackgroundPickerPanel, BackgroundPickerView, backgroundTool, type BackgroundPickerViewProps } from "@/components/editor/tools/background-picker";
import { EDITOR_TOOLS, visibleTools } from "@/components/editor/tools/registry";
import { DEV_BG_PHOTO_UUID, devPreviewDoc } from "@/lib/book/dev-preview";
import { serializeDoc } from "@/lib/book/doc-version";
import {
  EditOpError,
  pageBackgroundOverrideCount,
  resetPageBackground,
  sameBackground,
  setBookBackground,
  setPageBackground,
} from "@/lib/book/edit-ops";
import { resolveBackground } from "@/lib/book/render";
import type { Background, BookDoc } from "@/lib/book/types";
import { validateEditorDoc, type EditorDocContext } from "@/lib/book/validate-editor-doc";
import { BACKGROUND_SWATCHES, TEXTURE_IDS } from "@/lib/design/backgrounds";
import {
  availableScopes,
  backgroundPageIdx,
  backgroundPhotoCandidates,
  clampFade,
  currentBackground,
  initialTab,
  isSuggested,
  photoBackground,
  TINT_SWATCHES,
  VEIL_SWATCHES,
} from "@/lib/editor/background-picker";
import { DEV_DROPPED_BG_PHOTO_UUID, devEditorData, devTransport, withDevBackgroundPhotos } from "@/lib/editor/dev-fixture";
import { editorReducer, initEditorState, type EditorPosition } from "@/lib/editor/store";
import type { EditorShellPhoto } from "@/lib/editor/types";

vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

const NAVY: Background = { kind: "color", hex: "#1E2A47" };
const LINEN: Background = { kind: "texture", textureId: "linen" };
const KEPT = "11111111-1111-4111-8111-111111111111";
const DROPPED = "22222222-2222-4222-8222-222222222222";
const FOREIGN = "33333333-3333-4333-8333-333333333333";
const PHOTO: Background = { kind: "photo", photoId: KEPT, veil: 0.8, veilColor: "#FFFFFF" };

// ---- edit ops ------------------------------------------------------------------------------------

describe("background edit ops", () => {
  it("setPageBackground stores a user override on that page only (input untouched)", () => {
    const doc = devPreviewDoc();
    const out = setPageBackground(doc, 1, LINEN);
    expect(out.pages[1].background).toEqual({ kind: "texture", textureId: "linen", source: "user" });
    expect(out.pages[0]).toBe(doc.pages[0]);
    expect(doc.pages[1].background).toBeUndefined();
    expect(out.style).toBe(doc.style);
  });

  it("same background again is a no-op; on an AI suggestion it becomes the user's choice", () => {
    const doc = setPageBackground(devPreviewDoc(), 1, NAVY);
    expect(setPageBackground(doc, 1, { kind: "color", hex: "#1e2a47" })).toBe(doc);
    const ai: BookDoc = { ...doc, pages: doc.pages.map((p, i) => (i === 1 ? { ...p, background: { ...NAVY, source: "ai" as const } } : p)) };
    expect(setPageBackground(ai, 1, NAVY).pages[1].background?.source).toBe("user");
  });

  it("rejects invalid backgrounds (unknown texture, veil out of range, extra keys, bad page)", () => {
    const doc = devPreviewDoc();
    const bad = [
      { kind: "texture", textureId: "marble" },
      { ...PHOTO, veil: 0.4 },
      { ...PHOTO, veil: 0.95 },
      { ...NAVY, source: "user" },
      { kind: "photo", photoId: "d1", veil: 0.7, veilColor: "#FFFFFF" },
    ] as unknown as Background[];
    for (const bg of bad) {
      expect(() => setPageBackground(doc, 0, bg)).toThrow(EditOpError);
      expect(() => setBookBackground(doc, bg)).toThrow(EditOpError);
    }
    expect(() => setPageBackground(doc, 99, NAVY)).toThrow(/page_out_of_range/);
  });

  it("resetPageBackground removes the key (back to v1 storage when nothing else is v2)", () => {
    const doc = devPreviewDoc();
    const set = setPageBackground(doc, 2, LINEN);
    const reset = resetPageBackground(set, 2);
    expect("background" in reset.pages[2]).toBe(false);
    expect(resetPageBackground(reset, 2)).toBe(reset);
    expect((serializeDoc(reset) as { version: number }).version).toBe(1);
    expect((serializeDoc(set) as { version: number }).version).toBe(2);
  });

  it("setBookBackground sets the default and clears page overrides unless asked to keep them", () => {
    const doc = setPageBackground(setPageBackground(devPreviewDoc(), 0, LINEN), 3, PHOTO);
    expect(pageBackgroundOverrideCount(doc)).toBe(2);
    const out = setBookBackground(doc, NAVY);
    expect(out.style.background).toEqual(NAVY);
    expect(pageBackgroundOverrideCount(out)).toBe(0);
    expect(out.pages[1]).toBe(doc.pages[1]);
    const kept = setBookBackground(doc, NAVY, { keepPageOverrides: true });
    expect(pageBackgroundOverrideCount(kept)).toBe(2);
    expect(setBookBackground(out, NAVY)).toBe(out);
    // Every page and the cover now resolve navy with light ink.
    for (const p of out.pages) expect(resolveBackground(out, p)).toMatchObject({ kind: "color", hex: "#1E2A47", ink: "light" });
    expect(resolveBackground(out)).toMatchObject({ ink: "light" });
  });

  it("sameBackground ignores source and hex case", () => {
    expect(sameBackground({ ...LINEN, source: "ai" } as never, LINEN)).toBe(true);
    expect(sameBackground({ kind: "texture", textureId: "linen", tint: "#cad6c1" }, { kind: "texture", textureId: "linen", tint: "#CAD6C1" })).toBe(true);
    expect(sameBackground(LINEN, { kind: "texture", textureId: "linen", tint: "#CAD6C1" })).toBe(false);
    expect(sameBackground(null, undefined)).toBe(true);
  });

  it("works with undo/redo in the editor store (one entry per tap, fade drags coalesce)", () => {
    let s = initEditorState(devPreviewDoc(), { page: 1 });
    const original = s.doc;
    s = editorReducer(s, { type: "apply", op: (d) => setPageBackground(d, 1, LINEN) });
    s = editorReducer(s, { type: "apply", op: (d) => setBookBackground(d, NAVY) });
    expect(s.doc.pages[1].background).toBeUndefined();
    s = editorReducer(s, { type: "undo" });
    expect(s.doc.pages[1].background?.kind).toBe("texture");
    expect(s.doc.style.background).toEqual(original.style.background);
    s = editorReducer(s, { type: "undo" });
    expect(s.doc).toBe(original);
    s = editorReducer(s, { type: "redo" });
    expect(s.doc.pages[1].background?.kind).toBe("texture");

    let f = initEditorState(devPreviewDoc(), { page: 0 });
    f = editorReducer(f, { type: "apply", op: (d) => setPageBackground(d, 0, PHOTO) });
    for (const veil of [0.6, 0.65, 0.7]) {
      f = editorReducer(f, { type: "apply", op: (d) => setPageBackground(d, 0, { ...PHOTO, veil }), coalesceKey: "bg-fade:page:0:1" });
    }
    expect(f.past.length).toBe(2);
    f = editorReducer(f, { type: "undo" });
    expect(f.doc.pages[0].background).toMatchObject({ veil: 0.8 });
  });
});

// ---- save validation -----------------------------------------------------------------------------

const ALL_D = Array.from({ length: 16 }, (_, i) => `d${i}`);
function ctx(over: Partial<EditorDocContext> = {}): EditorDocContext {
  return { photoIds: new Set([...ALL_D, KEPT, DROPPED]), maxPages: 20, savedDoc: devPreviewDoc(), ...over };
}

describe("validateEditorDoc — backgrounds", () => {
  it("accepts page + book backgrounds of the book's photos (kept or dropped), not placed", () => {
    let doc = setBookBackground(devPreviewDoc(), { ...PHOTO, photoId: DROPPED });
    doc = setPageBackground(doc, 0, PHOTO);
    doc = setPageBackground(doc, 1, { kind: "texture", textureId: "kraft", tint: "#CAD6C1" });
    const r = validateEditorDoc(doc, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.placedPhotoIds).not.toContain(DROPPED);
    expect(r.placedPhotoIds).not.toContain(KEPT);
    expect(r.doc.pages[1].background).toMatchObject({ source: "user" });
  });

  it("a background photo may also be in a slot", () => {
    const doc = setPageBackground(devPreviewDoc(), 0, { ...PHOTO, photoId: KEPT });
    const placed: BookDoc = { ...doc, pages: doc.pages.map((p, i) => (i === 0 ? { ...p, slots: [{ ...p.slots[0], photoId: KEPT }, ...p.slots.slice(1)] } : p)) };
    expect(validateEditorDoc(placed, ctx()).ok).toBe(true);
  });

  it("unknown or foreign photo → foreign_photo (page override and book default)", () => {
    const page = setPageBackground(devPreviewDoc(), 0, { ...PHOTO, photoId: FOREIGN });
    expect(validateEditorDoc(page, ctx())).toEqual({ ok: false, code: "foreign_photo" });
    const book = setBookBackground(devPreviewDoc(), { ...PHOTO, photoId: FOREIGN });
    expect(validateEditorDoc(book, ctx())).toEqual({ ok: false, code: "foreign_photo" });
    // A photo of this book that isn't upload-ready is not in photoIds either.
    expect(validateEditorDoc(setPageBackground(devPreviewDoc(), 0, PHOTO), ctx({ photoIds: new Set(ALL_D) }))).toEqual({ ok: false, code: "foreign_photo" });
  });

  it("bad texture, veil out of bounds, non-uuid photo, unknown key, missing source → invalid_doc", () => {
    const base = devPreviewDoc();
    const withBg = (bg: unknown): unknown => ({ ...base, pages: base.pages.map((p, i) => (i === 0 ? { ...p, background: bg } : p)) });
    const cases = [
      { kind: "texture", textureId: "marble", source: "user" },
      { ...PHOTO, veil: 0.49, source: "user" },
      { ...PHOTO, veil: 0.91, source: "user" },
      { ...PHOTO, photoId: "d1", source: "user" },
      { ...NAVY, source: "user", extra: 1 },
      { ...NAVY },
      { ...NAVY, source: "robot" },
    ];
    for (const bg of cases) expect(validateEditorDoc(withBg(bg), ctx())).toEqual({ ok: false, code: "invalid_doc" });
    expect(validateEditorDoc({ ...base, style: { ...base.style, background: { kind: "texture", textureId: "nope" } } }, ctx())).toEqual({ ok: false, code: "invalid_doc" });
    // Bounds themselves are fine.
    for (const veil of [0.5, 0.9]) expect(validateEditorDoc(withBg({ ...PHOTO, veil, source: "user" }), ctx()).ok).toBe(true);
    for (const textureId of TEXTURE_IDS) expect(validateEditorDoc(withBg({ kind: "texture", textureId, source: "user" }), ctx()).ok).toBe(true);
  });
});

// ---- dev transport (what /dev-editor?bg=1 saves) --------------------------------------------------

describe("dev transport with the real validator", () => {
  it("stores a v2 doc for backgrounds and rejects a foreign background photo", async () => {
    const data = withDevBackgroundPhotos(devEditorData("ok"));
    expect(data.photos.map((p) => p.id)).toEqual(expect.arrayContaining([DEV_BG_PHOTO_UUID, DEV_DROPPED_BG_PHOTO_UUID]));
    const t = devTransport("ok", { validate: { photoIds: new Set(data.photos.map((p) => p.id)), maxPages: 20, savedDoc: data.doc } });
    const doc = setPageBackground(data.doc, 0, { ...PHOTO, photoId: DEV_DROPPED_BG_PHOTO_UUID });
    expect(await t.save(doc, 1, { keepalive: false })).toMatchObject({ kind: "ok" });
    const last = (globalThis as { __devEditorLastSave?: { stored: { version: number } } }).__devEditorLastSave;
    expect(last?.stored.version).toBe(2);
    const bad = setPageBackground(data.doc, 0, { ...PHOTO, photoId: FOREIGN });
    expect(await t.save(bad, 2, { keepalive: false })).toEqual({ kind: "invalid", code: "foreign_photo" });
  });
});

// ---- picker helpers --------------------------------------------------------------------------------

function photo(id: string, status: "kept" | "dropped"): EditorShellPhoto {
  return { id, status, userOverride: false, width: 1200, height: 1600, webUrl: `https://x/${id}.jpg`, thumbUrl: `https://x/${id}-t.jpg` };
}

describe("background picker helpers", () => {
  it("scopes: cover → only Whole book; a page → This page first", () => {
    const doc = devPreviewDoc();
    expect(backgroundPageIdx(doc, "cover")).toBeNull();
    expect(backgroundPageIdx(doc, 99)).toBeNull();
    expect(availableScopes(null)).toEqual(["book"]);
    expect(availableScopes(2)).toEqual(["page", "book"]);
  });

  it("currentBackground: page override (without source) else book default; initial tab follows", () => {
    const doc = setBookBackground(devPreviewDoc(), NAVY);
    const withPage = setPageBackground(doc, 1, LINEN);
    expect(currentBackground(withPage, "page", 1)).toEqual(LINEN);
    expect(currentBackground(withPage, "page", 0)).toEqual(NAVY);
    expect(currentBackground(withPage, "book", 1)).toEqual(NAVY);
    expect(initialTab(LINEN)).toBe("texture");
    expect(initialTab(PHOTO)).toBe("photo");
  });

  it("isSuggested only for an AI page background", () => {
    const doc = devPreviewDoc();
    const ai: BookDoc = { ...doc, pages: doc.pages.map((p, i) => (i === 0 ? { ...p, background: { ...LINEN, source: "ai" as const } } : p)) };
    expect(isSuggested(ai, 0)).toBe(true);
    expect(isSuggested(setPageBackground(ai, 0, NAVY), 0)).toBe(false);
    expect(isSuggested(ai, null)).toBe(false);
  });

  it("photo candidates: uuid ids only, kept first then dropped", () => {
    const list = [photo(DROPPED, "dropped"), photo("d1", "kept"), photo(KEPT, "kept")];
    expect(backgroundPhotoCandidates(list).map((p) => p.id)).toEqual([KEPT, DROPPED]);
  });

  it("fade clamps + snaps; photoBackground keeps fade/colour of the current photo", () => {
    expect(clampFade(0.1)).toBe(0.5);
    expect(clampFade(1)).toBe(0.9);
    expect(clampFade(0.7300001)).toBe(0.75);
    expect(clampFade(Number.NaN)).toBe(0.75);
    expect(photoBackground(DROPPED, { ...PHOTO, veil: 0.6, veilColor: "#1E2A47" })).toEqual({ kind: "photo", photoId: DROPPED, veil: 0.6, veilColor: "#1E2A47" });
    expect(photoBackground(DROPPED, NAVY)).toMatchObject({ veil: 0.75, veilColor: "#FFFFFF" });
  });

  it("veil colours white/cream/navy/black; tints are the light swatches without white", () => {
    expect(VEIL_SWATCHES.map((s) => s.id)).toEqual(["white", "cream", "navy", "black"]);
    expect(TINT_SWATCHES.every((s) => s.ink === "dark" && s.id !== "white")).toBe(true);
  });
});

// ---- picker static render -----------------------------------------------------------------------

function viewProps(over: Partial<BackgroundPickerViewProps> = {}): BackgroundPickerViewProps {
  const noop = () => {};
  return {
    scopes: ["page", "book"],
    scope: "page",
    onScope: noop,
    tab: "color",
    onTab: noop,
    current: { kind: "color", hex: "#FFFFFF" },
    suggested: false,
    hasOverride: false,
    overrideCount: 0,
    photos: [photo(KEPT, "kept"), photo(DROPPED, "dropped")],
    onApply: noop,
    onFade: noop,
    onReset: noop,
    ...over,
  };
}

const html = (over: Partial<BackgroundPickerViewProps> = {}) => renderToStaticMarkup(<BackgroundPickerView {...viewProps(over)} />);

describe("BackgroundPickerView", () => {
  it("tabs Colour / Paper / Photo with the selected tab marked", () => {
    const h = html({ tab: "texture" });
    expect(h).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*data-testid="bg-tab-color"[^>]*>Colour/);
    expect(h).toMatch(/aria-selected="true"[^>]*data-testid="bg-tab-texture"[^>]*>Paper/);
    expect(h).toContain(">Photo</button>");
    expect(h).toContain('data-testid="bg-panel-texture"');
  });

  it("scope toggle: This page default; cover → only Whole book with a note", () => {
    const page = html();
    expect(page).toMatch(/aria-checked="true"[^>]*data-testid="bg-scope-page"/);
    expect(page).not.toContain("bg-cover-note");
    const cover = html({ scopes: ["book"], scope: "book" });
    expect(cover).toMatch(/aria-checked="false" disabled=""[^>]*data-testid="bg-scope-page"/);
    expect(cover).toMatch(/aria-checked="true"[^>]*data-testid="bg-scope-book"/);
    expect(cover).toContain("The cover uses the book background.");
  });

  it("Whole book warns when pages have their own background", () => {
    expect(html({ scope: "book", overrideCount: 3 })).toContain("Also replaces the background of 3 pages that have its own.");
    expect(html({ scope: "book", overrideCount: 0 })).not.toContain("bg-replace-note");
  });

  it("colour tab: 16 labelled swatches, only the current one checked", () => {
    const h = html({ current: { kind: "color", hex: "#1e2a47" } });
    for (const s of BACKGROUND_SWATCHES) expect(h).toContain(`aria-label="${s.label}"`);
    expect(h.match(/data-testid="bg-colour-/g)?.length).toBe(16);
    expect(h.match(/aria-checked="true"[^>]*data-testid="bg-colour-/g)).toHaveLength(1);
    expect(h).toMatch(/aria-checked="true" aria-label="Navy"/);
  });

  it("paper tab: 6 textures with screen webp thumbs, tint row with No tint selected", () => {
    const h = html({ tab: "texture", current: LINEN });
    expect(h.match(/data-testid="bg-texture-/g)?.length).toBe(6);
    expect(h).toMatch(/aria-checked="true" aria-label="Linen"/);
    expect(h).toContain("/design/textures/linen.webp");
    expect(h).toContain("/design/textures/watercolour-blush-portrait.webp");
    expect(h).toMatch(/role="radio" aria-checked="true" aria-label="No tint"/);
    const tinted = html({ tab: "texture", current: { ...LINEN, tint: "#CAD6C1" } as Background });
    expect(tinted).toMatch(/aria-checked="true" aria-label="Sage tint"/);
    expect(tinted).toMatch(/aria-checked="false" aria-label="No tint"/);
    // Not a texture yet → the tint row is disabled.
    expect(html({ tab: "texture" })).toContain("Pick a paper first.");
  });

  it("photo tab: thumbs, fade 50–90 % slider with value, veil colours", () => {
    const h = html({ tab: "photo", current: { ...PHOTO, veil: 0.8, veilColor: "#1E2A47" } });
    expect(h.match(/data-testid="bg-photo"/g)?.length).toBe(2);
    expect(h).toContain(`src="https://x/${KEPT}-t.jpg"`);
    expect(h).toMatch(/aria-checked="true" aria-label="Current background photo"/);
    expect(h).toMatch(/type="range" min="0.5" max="0.9" step="0.05"[^>]*value="0.8"/);
    expect(h).toContain(">80%</span>");
    expect(h).toMatch(/aria-checked="true" aria-label="Navy fade"/);
    for (const l of ["White fade", "Cream fade", "Black fade"]) expect(h).toContain(`aria-label="${l}"`);
    expect(html({ tab: "photo", photos: [] })).toContain("No photos yet.");
  });

  it("Suggested chip + Reset only when relevant", () => {
    expect(html({ suggested: true })).toContain('data-testid="bg-suggested"');
    expect(html()).not.toContain("bg-suggested");
    expect(html({ hasOverride: true })).toContain("Reset to book background");
    expect(html()).not.toContain("bg-reset");
  });

  it("375 px: grids shrink (min-w-0, fractional columns), no fixed widths", () => {
    for (const tab of ["color", "texture", "photo"] as const) {
      const h = html({ tab, current: tab === "photo" ? PHOTO : tab === "texture" ? LINEN : NAVY });
      expect(h).not.toMatch(/\bw-\[\d+px\]|min-w-\[\d+px\]|\bw-(?:72|80|96)\b/);
      expect(h).toContain("min-w-0");
    }
    expect(html()).toContain("grid-cols-6");
  });

  it("read-only disables every control", () => {
    const h = html({ disabled: true, tab: "color" });
    expect(h.match(/data-testid="bg-colour-[^"]+"/g)?.length).toBe(16);
    expect(h.match(/disabled=""[^>]*data-testid="bg-colour-/g)?.length).toBe(16);
  });
});

// ---- panel + registry ------------------------------------------------------------------------------

function photosOf(list: EditorShellPhoto[]): EditorPhotos {
  return { photos: list, byId: new Map(list.map((p) => [p.id, p])), web: {}, thumbs: {}, idForUrl: () => undefined, reportBroken: () => {} } as unknown as EditorPhotos;
}

function ctxAt(page: EditorPosition, doc: BookDoc = devPreviewDoc(), edit = vi.fn()): EditorContextValue {
  const data = devEditorData("ok");
  const noop = () => {};
  return {
    book: data.book,
    state: { ...initEditorState(doc, { page }), selection: null },
    actions: { edit, undo: noop, redo: noop, goTo: noop, next: noop, prev: noop, select: noop, setReadOnly: noop, dismissError: noop, reset: noop },
    photos: photosOf([photo(KEPT, "kept")]),
    readOnly: false,
    activeTool: null,
    openTool: noop,
    closeTool: noop,
  } as unknown as EditorContextValue;
}

describe("Background tool", () => {
  it("is registered for 'nothing selected' after Layout, on pages and the cover", () => {
    expect(EDITOR_TOOLS).toContain(backgroundTool);
    expect(visibleTools(EDITOR_TOOLS, ctxAt(0)).map((t) => t.id)).toContain("background");
    expect(visibleTools(EDITOR_TOOLS, ctxAt("cover")).map((t) => t.id)).toContain("background");
    const ids = visibleTools(EDITOR_TOOLS, ctxAt(0)).map((t) => t.id);
    expect(ids.indexOf("background")).toBe(ids.indexOf("layout") + 1);
    const sel = { ...ctxAt(0), state: { ...ctxAt(0).state, selection: { kind: "slot" as const, pageIdx: 0, slotIdx: 0 } } };
    expect(visibleTools(EDITOR_TOOLS, sel).map((t) => t.id)).not.toContain("background");
  });

  it("panel opens on the current background's tab, This page scope; cover → Whole book", () => {
    const doc = setPageBackground(devPreviewDoc(), 1, LINEN);
    const page = renderToStaticMarkup(<BackgroundPickerPanel ctx={ctxAt(1, doc)} close={() => {}} />);
    expect(page).toContain('data-scope="page"');
    expect(page).toContain('data-testid="bg-panel-texture"');
    expect(page).toContain("bg-reset");
    const cover = renderToStaticMarkup(<BackgroundPickerPanel ctx={ctxAt("cover", doc)} close={() => {}} />);
    expect(cover).toContain('data-scope="book"');
    expect(cover).toContain('data-testid="bg-panel-color"');
    expect(cover).not.toContain("bg-reset");
  });
});
