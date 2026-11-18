// @vitest-environment jsdom
// M30 T13 — editor tools for the magazine / editorial styles: chapter description (tap target,
// textarea, word counter, AI help with the description body shape), accent colour (one undo step,
// source "user", absent for the older styles), the M30 covers in Cover style, the "Sans" caption
// face, and the /dev-editor?style= fixture books. Panels run in jsdom on the real reducer.

import { act, useMemo, useReducer, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { devEditorFixture } from "@/app/dev-editor/dev-states";
import { BookPage } from "@/components/book/BookPage";
import { DESCRIPTION_PLACEHOLDER } from "@/components/editor/EditablePage";
import { panelDocksOnMobile, selectionKey } from "@/components/editor/EditorToolbar";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { AccentColourPanel, accentColourTool, applyAccent } from "@/components/editor/tools/accent-colour";
import { aiDescriptionTool, chapterDescriptionTool } from "@/components/editor/tools/chapter-description";
import { autoOpenTool, EDITOR_TOOLS, MAX_PRIMARY_TOOLS, splitTools, visibleTools } from "@/components/editor/tools/registry";
import { BOOK_FORMATS } from "@/lib/book/schema";
import { m30EditorDoc } from "@/lib/book/dev-m30";
import { devPreviewDoc } from "@/lib/book/dev-preview";
import { devSampleDoc, devSamplePhotos } from "@/lib/book/dev-sample";
import { serializeDoc } from "@/lib/book/doc-version";
import { DESCRIPTION_MAX, EditOpError, markUserEdited, setChapterDescription, setColourway } from "@/lib/book/edit-ops";
import { pageRenderModel } from "@/lib/book/render";
import { hasUserDescriptions, isAiReplaceableDoc } from "@/lib/book/replaceable";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import { coverStylesFor } from "@/lib/book/spreads";
import type { BookDoc } from "@/lib/book/types";
import { validateEditorDoc } from "@/lib/book/validate-editor-doc";
import { colourwaysFor } from "@/lib/design/colourways";
import { accentAvailable, accentOptions } from "@/lib/editor/accent";
import { captionFontOptions, descriptionLengthInfo, pickerFontOf, requestRewrite } from "@/lib/editor/caption-tools";
import { coverStyleOptions } from "@/lib/editor/cover-styles";
import { devEditorData } from "@/lib/editor/dev-fixture";
import { editorReducer, EDIT_ERROR_COPY, initEditorState, validSelection, type EditorSelection, type EditorState } from "@/lib/editor/store";
import { layoutIdShowsDescription } from "@/lib/layouts/description";
import { albumEditedByUser } from "@/lib/review/ui";

// The editor registry → UpgradeSheet → UpgradeButton imports the upgrade server action (server-only).
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STYLES = ["magazine", "editorial"] as const;
const PHOTO_IDS = new Set(Object.keys(devSamplePhotos()));
const issues = (doc: BookDoc) => validateBookDoc(doc, { photoIds: PHOTO_IDS, maxPages: 20 });
const BOOK_ID = "00000000-0000-4000-8000-000000000000";

// ---- harness: a panel on the real reducer --------------------------------------------------------

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const live: { state: EditorState | null; active: string | null } = { state: null, active: null };

function Harness({
  doc,
  selection,
  page,
  toolId,
  ai = "replay",
  readOnly = false,
}: {
  doc: BookDoc;
  selection: EditorSelection;
  page: "cover" | number;
  toolId: string;
  ai?: "off" | "replay";
  readOnly?: boolean;
}) {
  const [state, dispatch] = useReducer(editorReducer, null, () => ({ ...initEditorState(doc, { page, readOnly }), selection }));
  const [active, setActive] = useState<string | null>(toolId);
  const [rewrites, setRewrites] = useState({ used: 0, left: 20 });
  live.state = state;
  live.active = active;
  const ctx = useMemo(
    () =>
      ({
        book: { ...devEditorData("ok").book, id: BOOK_ID, captionLang: "en" },
        state,
        actions: {
          edit: (op: (d: BookDoc) => BookDoc, o = {}) => dispatch({ type: "apply", op, ...o }),
          undo: () => dispatch({ type: "undo" }),
          redo: () => dispatch({ type: "redo" }),
          select: (s: EditorSelection) => dispatch({ type: "select", selection: s }),
        },
        photos: { photos: [], byId: new Map(), web: {}, thumbs: {}, idForUrl: () => undefined, reportBroken: () => {} },
        readOnly: state.readOnly,
        ai: { mode: ai, rewritesUsed: rewrites.used, rewritesLeft: rewrites.left, setRewrites: (used: number, left: number) => setRewrites({ used, left }), blocked: null, blockSession: () => {} },
        activeTool: active,
        openTool: setActive,
        closeTool: () => setActive(null),
      }) as unknown as EditorContextValue,
    [state, active, ai, rewrites],
  );
  const tool = EDITOR_TOOLS.find((t) => t.id === active);
  const Panel = tool?.Panel;
  return (
    <div>
      <button type="button" data-testid="undo" onClick={() => ctx.actions.undo()} />
      {Panel ? <Panel ctx={ctx} close={() => setActive(null)} /> : null}
    </div>
  );
}

function render(el: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  act(() => r.render(el));
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

const q = <T extends HTMLElement>(testid: string) => host!.querySelector<T>(`[data-testid="${testid}"]`);
const all = (testid: string) => Array.from(host!.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`));
const click = (testid: string) => act(async () => q(testid)!.click());
function type(value: string) {
  const el = q<HTMLTextAreaElement>("description-input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const doc = () => live.state!.doc;
const chapter = (id: string) => doc().chapters.find((c) => c.id === id)!;

/** Index of the first page whose layout shows the description and whose chapter is `chapterId`. */
const descPage = (d: BookDoc, chapterId: string) => d.pages.findIndex((p) => p.chapterId === chapterId && p.side !== "right" && layoutIdShowsDescription(p.layout));

// ---- fixtures --------------------------------------------------------------------------------------

describe("dev fixture books (/dev-editor?style=…)", () => {
  for (const style of STYLES) {
    for (const format of BOOK_FORMATS) {
      it(`${style} ${format}: valid, has a description page, an empty description page and a spread`, () => {
        for (const o of [{}, { arabic: true }, { descriptions: false }]) {
          const d = m30EditorDoc(style, format, o);
          expect(issues(d), JSON.stringify(o)).toEqual([]);
          expect(parseBookDoc(serializeDoc(d)).ok).toBe(true);
        }
        const d = m30EditorDoc(style, format);
        expect(d.style.designStyle).toBe(style);
        expect(d.style.colourway).toEqual({ id: colourwaysFor(style)[1].id, source: "ai" });
        expect(descPage(d, "c1")).toBe(0);
        expect(d.chapters[0].description?.source).toBe("ai");
        expect(descPage(d, "c2")).toBe(2);
        expect(d.chapters[1].description).toBeUndefined();
        expect(d.pages.some((p) => p.side === "left")).toBe(true);
        expect(m30EditorDoc(style, format, { descriptions: false }).chapters.every((c) => c.description === undefined)).toBe(true);
      });
    }
  }

  it("devEditorFixture: style switch builds the book; without it the classic fixture is unchanged", () => {
    const base = { mode: "ok" as const, ai: "replay" as const, pages: null, published: false, paid: false, format: "A5_PORTRAIT" as const, bg: false, lightVeil: false, sample: null, state: null };
    const mg = devEditorFixture({ ...base, m30: { style: "magazine", arabic: false, descriptions: true } }).data;
    expect(mg.doc.style.designStyle).toBe("magazine");
    expect(mg.book.occasion).toBe("travel");
    expect(mg.aiMode).toBe("replay");
    const used = new Set([mg.doc.cover.photoId, ...mg.doc.pages.flatMap((p) => p.slots.map((s) => s.photoId))]);
    for (const id of used) expect(mg.photos.some((p) => p.id === id), String(id)).toBe(true);
    const ar = devEditorFixture({ ...base, format: "A5_LANDSCAPE", m30: { style: "editorial", arabic: true, descriptions: false } }).data;
    expect(ar.book.captionLang).toBe("ar");
    expect(ar.doc.format).toBe("A5_LANDSCAPE");
    expect(devEditorFixture(base).data.doc).toEqual(devEditorData("ok", "replay").doc);
    expect(devEditorFixture({ ...base, m30: null }).data.doc).toEqual(devEditorData("ok", "replay").doc);
  });
});

// ---- edit ops ---------------------------------------------------------------------------------------

describe("setChapterDescription / setColourway", () => {
  const d0 = m30EditorDoc("magazine", "A5_PORTRAIT");

  it("writes user text, clips to 400, removes on blank, no-ops return the input", () => {
    const d1 = setChapterDescription(d0, "c2", "A slow day.");
    expect(d1.chapters[1].description).toEqual({ text: "A slow day.", source: "user" });
    expect(d0.chapters[1].description).toBeUndefined();
    expect(issues(d1)).toEqual([]);
    expect(setChapterDescription(d1, "c2", "A slow day.")).toBe(d1);
    // Same text but written by the AI → becomes the user's.
    const ai = d0.chapters[0].description!.text;
    expect(setChapterDescription(d0, "c1", ai).chapters[0].description).toEqual({ text: ai, source: "user" });
    const long = setChapterDescription(d0, "c2", "ك".repeat(500));
    expect(long.chapters[1].description!.text.length).toBe(DESCRIPTION_MAX);
    expect(issues(long)).toEqual([]);
    for (const blank of ["", "   ", "\n"]) {
      const cleared = setChapterDescription(d0, "c1", blank);
      expect("description" in cleared.chapters[0]).toBe(false);
      expect(issues(cleared)).toEqual([]);
      expect(setChapterDescription(d0, "c2", blank)).toBe(d0);
    }
    expect(() => setChapterDescription(d0, "nope", "x")).toThrow(EditOpError);
  });

  it("a user description counts as a user edit everywhere", () => {
    const d1 = setChapterDescription(d0, "c2", "Mine.");
    expect(hasUserDescriptions(d0)).toBe(false);
    expect(hasUserDescriptions(d1)).toBe(true);
    expect(isAiReplaceableDoc(d1)).toBe(false);
    expect(albumEditedByUser(d0)).toBe(false);
    expect(albumEditedByUser(d1)).toBe(true);
  });

  it("setColourway: source user, style-checked, older styles refuse", () => {
    const d1 = setColourway(d0, "teal");
    expect(d1.style.colourway).toEqual({ id: "teal", source: "user" });
    expect(d1.pages).toBe(d0.pages);
    expect(issues(d1)).toEqual([]);
    expect(setColourway(d1, "teal")).toBe(d1);
    // The AI's pick confirmed by the user is stored as the user's.
    expect(setColourway(d0, d0.style.colourway!.id).style.colourway!.source).toBe("user");
    expect(() => setColourway(d0, "cobalt")).toThrow(EditOpError); // editorial only
    expect(() => setColourway(devPreviewDoc(), "lime")).toThrow(EditOpError);
    expect(() => setColourway(devSampleDoc("geometric-portrait"), "lime")).toThrow(EditOpError);
    expect(EDIT_ERROR_COPY.invalid_colourway).toMatch(/colour/);
  });

  it("the save path accepts both edits and keeps their sources", () => {
    for (const style of STYLES) {
      const base = m30EditorDoc(style, "A5_LANDSCAPE");
      const edited = markUserEdited(setColourway(setChapterDescription(base, "c2", "وصف قصير لهذا الفصل."), colourwaysFor(style)[4].id));
      const r = validateEditorDoc(serializeDoc(edited), { photoIds: PHOTO_IDS, maxPages: 20, savedDoc: serializeDoc(base) });
      expect(r.ok, style).toBe(true);
      if (!r.ok) continue;
      expect(r.doc.style.colourway).toEqual({ id: colourwaysFor(style)[4].id, source: "user" });
      expect(r.doc.chapters[1].description).toEqual({ text: "وصف قصير لهذا الفصل.", source: "user" });
      expect(r.doc.chapters[0].description?.source).toBe("ai");
    }
  });
});

// ---- selection + tools ------------------------------------------------------------------------------

describe("description selection and toolbar", () => {
  const d0 = m30EditorDoc("magazine", "A5_PORTRAIT");
  const ctxFor = (d: BookDoc, selection: EditorSelection, page: "cover" | number, readOnly = false) =>
    ({ book: devEditorData("ok").book, state: { ...initEditorState(d, { page, readOnly }), selection }, readOnly, sidebar: false, activeTool: null, photos: { web: {}, thumbs: {} } }) as unknown as EditorContextValue;
  const ids = (t: { id: string }[]) => t.map((x) => x.id);

  it("valid only on a description layout of a page in a chapter", () => {
    const plain = d0.pages.findIndex((p) => !layoutIdShowsDescription(p.layout));
    expect(validSelection(d0, { kind: "description", pageIdx: 0 })).toEqual({ kind: "description", pageIdx: 0 });
    expect(validSelection(d0, { kind: "description", pageIdx: plain })).toBeNull();
    expect(validSelection(d0, { kind: "description", pageIdx: 99 })).toBeNull();
    const orphan = { ...d0, pages: d0.pages.map((p, i) => (i === 0 ? { ...p, chapterId: null } : p)) };
    expect(validSelection(orphan, { kind: "description", pageIdx: 0 })).toBeNull();
    expect(selectionKey({ kind: "description", pageIdx: 2 })).toBe("description:2");
    expect(panelDocksOnMobile({ kind: "description", pageIdx: 2 })).toBe(true);
  });

  it("description selected: Edit + AI help in the row, the editor opens by itself, ≤ 3 tools + More", () => {
    const ctx = ctxFor(d0, { kind: "description", pageIdx: 0 }, 0);
    const shown = visibleTools(EDITOR_TOOLS, ctx);
    const split = splitTools(shown, ctx);
    expect(ids(split.primary)).toEqual(["description", "ai-description"]);
    expect(split.primary.length).toBeLessThanOrEqual(MAX_PRIMARY_TOOLS);
    expect(ids(split.more)).toContain("chapter");
    expect(autoOpenTool(EDITOR_TOOLS, ctx)?.id).toBe("description");
    expect(chapterDescriptionTool.panelTitle).toBe("About this chapter");
    expect(aiDescriptionTool.label).toBe("AI help");
    // Read-only: both are hidden.
    expect(ids(visibleTools(EDITOR_TOOLS, ctxFor(d0, { kind: "description", pageIdx: 0 }, 0, true)))).not.toContain("description");
  });

  it("Accent colour: behind More next to Background for magazine / editorial, absent for the older styles", () => {
    for (const style of STYLES) {
      const d = m30EditorDoc(style, "A5_PORTRAIT");
      for (const page of ["cover", 0] as const) {
        const ctx = ctxFor(d, null, page);
        const split = splitTools(visibleTools(EDITOR_TOOLS, ctx), ctx);
        expect(ids(split.primary), `${style} ${page}`).toEqual([page === "cover" ? "cover-style" : "layout", "background", "pages"]);
        expect(ids(split.more)[0]).toBe("accent");
      }
      expect(ids(visibleTools(EDITOR_TOOLS, ctxFor(d, { kind: "slot", pageIdx: 0, slotIdx: 0 }, 0)))).not.toContain("accent");
      expect(ids(visibleTools(EDITOR_TOOLS, ctxFor(d, null, 0, true)))).not.toContain("accent");
    }
    expect(accentColourTool.label).toBe("Accent colour");
    expect(accentColourTool.dockOnMobile).toBe(true);
    const older = [devPreviewDoc(), devSampleDoc("modern-portrait"), devSampleDoc("geometric-portrait"), devSampleDoc("scrapbook-landscape")];
    for (const d of older) {
      expect(accentAvailable(d)).toBe(false);
      expect(accentOptions(d)).toEqual([]);
      for (const page of ["cover", 0] as const) {
        const ctx = ctxFor(d, null, page);
        const shown = ids(visibleTools(EDITOR_TOOLS, ctx));
        expect(shown).not.toContain("accent");
        expect(shown).not.toContain("description");
      }
    }
  });

  it("accentOptions: six per style, one current (stored id, or the style default when none is stored)", () => {
    for (const style of STYLES) {
      const d = m30EditorDoc(style, "A5_PORTRAIT");
      const opts = accentOptions(d);
      expect(opts.map((o) => o.colourway.id)).toEqual(colourwaysFor(style).map((c) => c.id));
      expect(opts).toHaveLength(6);
      expect(opts.filter((o) => o.current).map((o) => o.colourway.id)).toEqual([d.style.colourway!.id]);
      const styleRest = { ...d.style };
      delete styleRest.colourway;
      const bare = accentOptions({ style: styleRest });
      expect(bare.filter((o) => o.current).map((o) => o.colourway.id)).toEqual([colourwaysFor(style)[0].id]);
      for (const o of opts) expect(o.swatch.base).not.toBe(o.swatch.dot);
    }
  });
});

// ---- page markup -----------------------------------------------------------------------------------

describe("description area on the page", () => {
  const photos = devSamplePhotos();
  const d0 = m30EditorDoc("magazine", "A5_PORTRAIT");

  it("edit targets: filled and empty areas, only with editTargets, spread halves point at the left page", () => {
    expect(pageRenderModel(d0, 0, photos)!.descriptionAreas).toBeUndefined();
    const filled = pageRenderModel(d0, 0, photos, "en", { editTargets: true })!.descriptionAreas!;
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ ownerIndex: 0, chapterId: "c1", empty: false });
    const empty = pageRenderModel(d0, 2, photos, "en", { editTargets: true })!.descriptionAreas!;
    expect(empty[0]).toMatchObject({ ownerIndex: 2, chapterId: "c2", empty: true });
    const left = d0.pages.findIndex((p) => p.side === "left");
    const halves = [left, left + 1].flatMap((i) => pageRenderModel(d0, i, photos, "en", { editTargets: true })!.descriptionAreas ?? []);
    expect(halves).toHaveLength(1);
    expect(halves[0].ownerIndex).toBe(left);
    expect(halves[0].rect.x).toBeGreaterThanOrEqual(0);
    expect(halves[0].rect.x + halves[0].rect.w).toBeLessThanOrEqual(100);
    // The view / print model is the same with and without the option.
    const rest = { ...pageRenderModel(d0, 0, photos, "en", { editTargets: true })! };
    delete rest.descriptionAreas;
    expect(rest).toEqual(pageRenderModel(d0, 0, photos));
  });

  it("the hint is drawn in edit mode only — never in the viewer or print", () => {
    const hint = (area: { empty: boolean }) => (area.empty ? <span data-testid="hint">{DESCRIPTION_PLACEHOLDER}</span> : <span data-testid="filled" />);
    const edit = renderToStaticMarkup(<BookPage doc={d0} page={2} mode="edit" photos={photos} renderDescription={hint} />);
    expect(edit).toContain('data-description-area="empty"');
    expect(edit).toContain(DESCRIPTION_PLACEHOLDER);
    expect(renderToStaticMarkup(<BookPage doc={d0} page={0} mode="edit" photos={photos} renderDescription={hint} />)).toContain('data-description-area="filled"');
    for (const mode of ["view", "print"] as const) {
      const html = renderToStaticMarkup(<BookPage doc={d0} page={2} mode={mode} photos={photos} renderDescription={hint} />);
      expect(html).not.toContain("data-description-area");
      expect(html).not.toContain(DESCRIPTION_PLACEHOLDER);
      expect(html).toBe(renderToStaticMarkup(<BookPage doc={d0} page={2} mode={mode} photos={photos} />));
    }
    // Edit mode without the callback (read-only editor): nothing either.
    expect(renderToStaticMarkup(<BookPage doc={d0} page={2} mode="edit" photos={photos} />)).not.toContain("data-description-area");
  });

  it("clearing the description collapses the panel and its `when` blocks", () => {
    for (const style of STYLES) {
      for (const format of BOOK_FORMATS) {
        const d = m30EditorDoc(style, format);
        const before = pageRenderModel(d, 0, photos)!;
        expect(before.texts!.some((t) => t.bind === "chapterDescription")).toBe(true);
        const after = pageRenderModel(setChapterDescription(d, "c1", ""), 0, photos)!;
        expect((after.texts ?? []).some((t) => t.bind === "chapterDescription")).toBe(false);
        expect((after.blocks ?? []).length).toBeLessThanOrEqual((before.blocks ?? []).length);
        const html = renderToStaticMarkup(<BookPage doc={setChapterDescription(d, "c1", "")} page={0} mode="view" photos={photos} />);
        expect(html).not.toContain('data-text-panel="chapterDescription"');
      }
    }
    // The magazine opener's rule / box under the text goes with it.
    const mg = m30EditorDoc("magazine", "A5_PORTRAIT");
    expect(pageRenderModel(setChapterDescription(mg, "c1", ""), 0, photos)!.blocks!.length).toBeLessThan(pageRenderModel(mg, 0, photos)!.blocks!.length);
  });
});

// ---- panels (jsdom) -----------------------------------------------------------------------------------

describe("About this chapter panel", () => {
  const d0 = m30EditorDoc("magazine", "A5_PORTRAIT");
  const original = d0.chapters[0].description!.text;

  it("textarea: dir=auto, counter, hard cap; typing is ONE undo step back to the previous text", async () => {
    render(<Harness doc={d0} selection={{ kind: "description", pageIdx: 0 }} page={0} toolId="description" />);
    const input = q<HTMLTextAreaElement>("description-input")!;
    expect(input.getAttribute("dir")).toBe("auto");
    expect(input.maxLength).toBe(400);
    expect(input.value).toBe(original);
    expect(q("description-count")!.textContent).toBe(`45 of 45 words · ${original.length}/400`);
    expect(q("description-long-hint")).toBeNull();

    type("A");
    type("A new");
    type("A new line about the hills.");
    expect(chapter("c1").description).toEqual({ text: "A new line about the hills.", source: "user" });
    expect(q("description-count")!.textContent).toBe("6 of 45 words · 27/400");
    expect(live.state!.past).toHaveLength(1);
    expect(issues(doc())).toEqual([]);

    await click("undo");
    expect(chapter("c1").description).toEqual({ text: original, source: "ai" });
    expect(live.state!.past).toHaveLength(0);
    expect(q<HTMLTextAreaElement>("description-input")!.value).toBe(original);
  });

  it("soft hint past 45 words; Arabic text switches the field to Arabic", () => {
    render(<Harness doc={d0} selection={{ kind: "description", pageIdx: 2 }} page={2} toolId="description" />);
    expect(q<HTMLTextAreaElement>("description-input")!.value).toBe("");
    type(Array.from({ length: 46 }, (_, i) => `w${i}`).join(" "));
    expect(q("description-long-hint")).not.toBeNull();
    expect(descriptionLengthInfo("a b c").long).toBe(false);
    type("يومان هادئان على طريق الوادي");
    const input = q<HTMLTextAreaElement>("description-input")!;
    expect(input.lang).toBe("ar");
    expect(input.getAttribute("dir")).toBe("auto");
    expect(q("description-long-hint")).toBeNull();
    expect(chapter("c2").description).toEqual({ text: "يومان هادئان على طريق الوادي", source: "user" });
    expect(issues(doc())).toEqual([]);
  });

  it("clearing the field removes the description; undo brings it back in one step", async () => {
    render(<Harness doc={d0} selection={{ kind: "description", pageIdx: 0 }} page={0} toolId="description" />);
    type("");
    expect("description" in chapter("c1")).toBe(false);
    expect(issues(doc())).toEqual([]);
    // Still selected: the empty area stays editable.
    expect(live.state!.selection).toEqual({ kind: "description", pageIdx: 0 });
    expect(q("description-input")).not.toBeNull();
    await click("undo");
    expect(chapter("c1").description).toEqual({ text: original, source: "ai" });
  });

  it("read-only: the field is disabled", () => {
    render(<Harness doc={d0} selection={{ kind: "description", pageIdx: 0 }} page={0} toolId="description" readOnly />);
    expect(q<HTMLTextAreaElement>("description-input")!.disabled).toBe(true);
  });
});

describe("AI help for the description", () => {
  const d0 = m30EditorDoc("editorial", "A5_PORTRAIT");
  const original = d0.chapters[0].description!.text;
  const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("rewrite / shorter / translate only; posts the description body; “Use this” saves it as the user's", async () => {
    const fetchMock = respond(200, { text: "Up before dawn, into the hills.", lang: "en", remaining: 7 });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness doc={d0} selection={{ kind: "description", pageIdx: 0 }} page={0} toolId="description" />);
    await click("description-open-ai");
    expect(live.active).toBe("ai-description");
    expect(q("ai-description-menu")!.dataset.state).toBe("idle");
    expect(Array.from(host!.querySelectorAll('[data-testid^="ai-option-"]')).map((e) => e.getAttribute("data-testid"))).toEqual([
      "ai-option-rewrite",
      "ai-option-shorter",
      "ai-option-translate",
    ]);

    await click("ai-option-shorter");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ai/rewrite");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ bookId: BOOK_ID, target: "description", chapterId: "c1", instruction: "shorter", text: original });
    expect("pageId" in body).toBe(false);

    // Preview only: the doc is untouched until "Use this".
    expect(q("ai-description-menu")!.dataset.state).toBe("preview");
    expect(q("ai-preview")!.textContent).toBe("Up before dawn, into the hills.");
    expect(q("ai-preview")!.getAttribute("dir")).toBe("auto");
    expect(q("ai-rewrites-left")!.textContent).toBe("7 rewrites left");
    expect(chapter("c1").description).toEqual({ text: original, source: "ai" });

    await click("ai-use-this");
    expect(chapter("c1").description).toEqual({ text: "Up before dawn, into the hills.", source: "user" });
    expect(live.state!.past).toHaveLength(1);
    expect(live.active).toBe("description");
    expect(issues(doc())).toEqual([]);
    await click("undo");
    expect(chapter("c1").description).toEqual({ text: original, source: "ai" });
  });

  it("“Keep mine” changes nothing", async () => {
    vi.stubGlobal("fetch", respond(200, { text: "Other words.", lang: "en", remaining: 3 }));
    render(<Harness doc={d0} selection={{ kind: "description", pageIdx: 0 }} page={0} toolId="ai-description" />);
    await click("ai-option-rewrite");
    await click("ai-keep-mine");
    expect(q("ai-description-menu")!.dataset.state).toBe("idle");
    expect(live.state!.past).toHaveLength(0);
  });

  it("limit, AI off, empty text and errors", async () => {
    vi.stubGlobal("fetch", respond(429, { error: "limit", remaining: 0 }));
    render(<Harness doc={d0} selection={{ kind: "description", pageIdx: 0 }} page={0} toolId="ai-description" />);
    await click("ai-option-rewrite");
    expect(q("ai-description-limit")).not.toBeNull();
    expect(q<HTMLButtonElement>("ai-option-rewrite")!.disabled).toBe(true);
    act(() => root!.unmount());
    host!.remove();

    vi.stubGlobal("fetch", respond(502, { error: "refusal", retryable: false }));
    render(<Harness doc={d0} selection={{ kind: "description", pageIdx: 0 }} page={0} toolId="ai-description" />);
    await click("ai-option-translate");
    expect(q("ai-description-message")!.textContent).toContain("Can't rewrite this text");
    act(() => root!.unmount());
    host!.remove();

    const never = vi.fn();
    vi.stubGlobal("fetch", never);
    render(<Harness doc={d0} selection={{ kind: "description", pageIdx: 0 }} page={0} toolId="ai-description" ai="off" />);
    expect(q("ai-description-blocked")!.textContent).toBe("AI writing isn't switched on yet");
    expect(all("ai-option-rewrite")[0].hasAttribute("disabled")).toBe(true);
    act(() => root!.unmount());
    host!.remove();

    // No description yet: nothing to rewrite.
    render(<Harness doc={d0} selection={{ kind: "description", pageIdx: 2 }} page={2} toolId="ai-description" />);
    expect(q("ai-description-blocked")!.textContent).toBe("Write a few lines first — AI can then rewrite them.");
    expect(never).not.toHaveBeenCalled();
  });

  it("requestRewrite keeps the caption body as it was", async () => {
    const fetchImpl = respond(200, { text: "x", lang: "en", remaining: 1 });
    await requestRewrite({ bookId: "b", pageId: "p", instruction: "tone:fun", text: "t" }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ bookId: "b", pageId: "p", instruction: "tone:fun", text: "t" });
  });
});

describe("Accent colour panel", () => {
  it("six named swatches, the current one marked; a tap = one undo step, source user; the panel stays", async () => {
    const d0 = m30EditorDoc("magazine", "A5_PORTRAIT");
    render(<Harness doc={d0} selection={null} page="cover" toolId="accent" />);
    const swatches = () => all("accent-option");
    expect(swatches().map((s) => s.dataset.colourway)).toEqual(["lime", "sunset", "sky", "coral", "teal", "gold"]);
    expect(swatches().map((s) => s.textContent)).toEqual(["Lime", "Sunset", "Sky", "Coral", "Teal", "Gold"]);
    expect(swatches().filter((s) => s.dataset.current === "true").map((s) => s.dataset.colourway)).toEqual(["sunset"]);

    await act(async () => swatches()[4].click());
    expect(doc().style.colourway).toEqual({ id: "teal", source: "user" });
    expect(live.state!.past).toHaveLength(1);
    expect(live.active).toBe("accent");
    expect(swatches()[4].getAttribute("aria-pressed")).toBe("true");
    expect(issues(doc())).toEqual([]);
    // Tapping the one in use is not an edit.
    await act(async () => swatches()[4].click());
    expect(live.state!.past).toHaveLength(1);

    await act(async () => swatches()[0].click());
    expect(doc().style.colourway).toEqual({ id: "lime", source: "user" });
    await click("undo");
    expect(doc().style.colourway).toEqual({ id: "teal", source: "user" });
    await click("undo");
    expect(doc().style.colourway).toEqual({ id: "sunset", source: "ai" });
    expect(live.state!.past).toHaveLength(0);
  });

  it("the user's colour survives later edits; read-only and the AI's own pick are no-ops", () => {
    const d0 = m30EditorDoc("editorial", "A5_LANDSCAPE");
    let state = initEditorState(d0, { page: "cover" });
    const ctx = (readOnly = false) =>
      ({ readOnly, state, actions: { edit: (op: (d: BookDoc) => BookDoc) => (state = editorReducer(state, { type: "apply", op })) } }) as unknown as EditorContextValue;
    applyAccent(ctx(true), "cobalt");
    applyAccent(ctx(), d0.style.colourway!.id);
    expect(state.doc).toBe(d0);
    applyAccent(ctx(), "cobalt");
    state = editorReducer(state, { type: "apply", op: (d) => setChapterDescription(d, "c2", "Later edit.") });
    expect(state.doc.style.colourway).toEqual({ id: "cobalt", source: "user" });
    expect(state.past).toHaveLength(2);
    expect(issues(state.doc)).toEqual([]);
    expect(renderToStaticMarkup(<AccentColourPanel ctx={ctx(true)} close={() => {}} />)).toContain("disabled");
  });
});

// ---- cover styles + fonts ------------------------------------------------------------------------------

describe("Cover style and caption font for the M30 styles", () => {
  it("lists every M30 cover (auto + the three user covers) with a preview that keeps the book", () => {
    for (const style of STYLES) {
      for (const format of BOOK_FORMATS) {
        const d = m30EditorDoc(style, format);
        const opts = coverStyleOptions(d);
        expect(opts.map((o) => o.layout.id)).toEqual(coverStylesFor(format, style).map((l) => l.id));
        expect(opts).toHaveLength(4);
        expect(opts.filter((o) => o.layout.autoPick === false)).toHaveLength(3);
        expect(opts.filter((o) => o.current).map((o) => o.layout.id)).toEqual([d.cover.layout]);
        for (const o of opts) {
          expect(issues(o.preview), o.layout.id).toEqual([]);
          expect(o.preview.style.colourway).toEqual(d.style.colourway);
          expect(o.preview.cover.title).toBe(d.cover.title);
        }
      }
    }
  });

  it("font picker: Poppins first for magazine / editorial, the classic four for every other style", () => {
    const classic = ["Inter", "Playfair", "Cairo", "Tajawal"];
    for (const style of STYLES) expect(captionFontOptions(style)).toEqual(["Poppins", ...classic]);
    for (const style of ["classic", "modern", "geometric", "scrapbook", undefined, null] as const) expect(captionFontOptions(style)).toEqual(classic);
    const mg = captionFontOptions("magazine");
    expect(pickerFontOf({ text: "Hello", font: "Poppins" }, mg, "en")).toBe("Poppins");
    expect(pickerFontOf({ text: "مرحبا", font: "Tajawal" }, mg, "ar")).toBe("Tajawal");
    // Faces the picker does not offer fall back to the classic face they render as (as before).
    expect(pickerFontOf({ text: "Hello", font: "Cormorant" }, captionFontOptions("modern"), "en")).toBe("Playfair");
    expect(pickerFontOf({ text: "Hello", font: "Poppins" }, captionFontOptions("classic"), "en")).toBe("Playfair");
  });
});
