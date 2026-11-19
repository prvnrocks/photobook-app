// @vitest-environment jsdom
// Task 7: editor support for storybook pages — tap targets on page texts, the "Text" tool (dir=auto,
// word count, overflow notice, one undo step, blank removes), selection validity, and Replace photo
// re-laying out only that page (ordinary albums keep the plain replace).
import { act, useMemo, useReducer, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookPage } from "@/components/book/BookPage";
import { selectionKey } from "@/components/editor/EditorToolbar";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { autoOpenTool, EDITOR_TOOLS, visibleTools } from "@/components/editor/tools/registry";
import { PAGE_TEXT_TOOL_ID } from "@/components/editor/tools/page-text";
import { replacePhoto } from "@/lib/book/edit-ops";
import type { BookDoc } from "@/lib/book/types";
import { devEditorData } from "@/lib/editor/dev-fixture";
import { editorReducer, initEditorState, validSelection, type EditorSelection, type EditorState } from "@/lib/editor/store";
import { getPageTemplate } from "@/lib/layouts/templates";
import { composeStoryDoc, mergeComposition, userOwnedElements } from "@/lib/storybook/compose";
import { storyFixture, fixturePhotoId } from "@/lib/storybook/compose/dev-fixture";
import { replaceSlotPhoto } from "@/lib/storybook/compose/editor-op";

vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const design = { format: "A5_PORTRAIT" as const, designStyle: "modern" as const };
const f = storyFixture({ photos: 24, design });
function storyDoc(): BookDoc {
  const r = composeStoryDoc({ storybook: f.storybook, photos: f.photos, design, lang: "en", occasion: "travel", bookTitle: null, maxPages: 20 });
  const owned = userOwnedElements(null, {});
  return mergeComposition({ fresh: r.doc, current: null, owned: owned.ok ? owned.owned : (null as never), design, storybookVersion: 1 });
}
const textPage = (d: BookDoc) => d.pages.findIndex((p) => p.texts?.length);

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const live: { state: EditorState | null } = { state: null };

function ctxOf(state: EditorState, dispatch: (a: never) => void, active: string | null, setActive: (s: string | null) => void): EditorContextValue {
  return {
    book: { ...devEditorData("ok").book, captionLang: "en" },
    state,
    actions: {
      edit: (op: (d: BookDoc) => BookDoc, o = {}) => dispatch({ type: "apply", op, ...o } as never),
      undo: () => dispatch({ type: "undo" } as never),
      redo: () => dispatch({ type: "redo" } as never),
      select: (s: EditorSelection) => dispatch({ type: "select", selection: s } as never),
    },
    photos: { photos: [], byId: new Map(), web: {}, thumbs: {}, idForUrl: () => undefined, reportBroken: () => {} },
    readOnly: false,
    ai: { mode: "off", rewritesUsed: 0, rewritesLeft: 20, setRewrites: () => {}, blocked: null, blockSession: () => {} },
    activeTool: active,
    openTool: setActive,
    closeTool: () => setActive(null),
  } as unknown as EditorContextValue;
}

function Harness({ doc, selection }: { doc: BookDoc; selection: EditorSelection }) {
  const [state, dispatch] = useReducer(editorReducer, null, () => ({ ...initEditorState(doc, { page: 0, readOnly: false }), selection }));
  const [active, setActive] = useState<string | null>(PAGE_TEXT_TOOL_ID);
  live.state = state;
  const ctx = useMemo(() => ctxOf(state, dispatch as never, active, setActive), [state, active]);
  const tool = EDITOR_TOOLS.find((t) => t.id === active);
  const Panel = tool?.Panel;
  return (
    <div>
      <button type="button" data-testid="undo" onClick={() => ctx.actions.undo()} />
      {Panel ? <Panel ctx={ctx} close={() => setActive(null)} /> : null}
    </div>
  );
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});
const q = <T extends HTMLElement>(id: string) => host!.querySelector<T>(`[data-testid="${id}"]`);
function type(value: string) {
  const el = q<HTMLTextAreaElement>("page-text-input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("page text tool", () => {
  it("selection: valid only where the layout has that pageText panel; key + auto-open", () => {
    const d = storyDoc();
    const i = textPage(d);
    expect(validSelection(d, { kind: "text", pageIdx: i, panel: 0 })).toEqual({ kind: "text", pageIdx: i, panel: 0 });
    expect(validSelection(d, { kind: "text", pageIdx: i, panel: 3 })).toBeNull();
    expect(selectionKey({ kind: "text", pageIdx: 2, panel: 1 })).toBe("text:2:1");
    const ctx = ctxOf({ ...initEditorState(d, { page: i, readOnly: false }), selection: { kind: "text", pageIdx: i, panel: 0 } }, () => {}, null, () => {});
    expect(visibleTools(EDITOR_TOOLS, ctx).map((t) => t.id)).toContain(PAGE_TEXT_TOOL_ID);
    expect(autoOpenTool(EDITOR_TOOLS, ctx)?.id).toBe(PAGE_TEXT_TOOL_ID);
  });

  it("edit mode draws a tap target per text panel; view / print draw none", () => {
    const d = storyDoc();
    const i = textPage(d);
    const edit = renderToStaticMarkup(<BookPage doc={d} page={i} mode="edit" photos={{}} renderPageText={() => <span data-testid="target" />} />);
    expect(edit).toContain('data-page-text-area="filled"');
    expect(renderToStaticMarkup(<BookPage doc={d} page={i} mode="view" photos={{}} />)).not.toContain("data-page-text-area");
  });

  it("textarea: dir=auto, word count; typing is ONE undo step; blank removes; source becomes user", () => {
    const d = storyDoc();
    const i = textPage(d);
    const original = d.pages[i]!.texts![0]!;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness doc={d} selection={{ kind: "text", pageIdx: i, panel: original.panel }} />));
    const input = q<HTMLTextAreaElement>("page-text-input")!;
    expect(input.getAttribute("dir")).toBe("auto");
    expect(input.value).toBe(original.text);
    type("Our own");
    type("Our own words here.");
    const t = live.state!.doc.pages[i]!.texts![0]!;
    expect(t).toMatchObject({ id: original.id, text: "Our own words here.", source: "user", blockRef: original.blockRef });
    expect(q("page-text-count")!.textContent).toContain("4 words");
    act(() => q("undo")!.click());
    expect(live.state!.doc.pages[i]!.texts![0]!.text).toBe(original.text);
    // the hard cap (900 units) always fits the main panel of a story page: no overflow notice
    type("word ".repeat(600));
    expect(live.state!.doc.pages[i]!.texts![0]!.text.length).toBeLessThanOrEqual(900);
    expect(q("page-text-count")!.textContent).not.toContain("too long");
    type("   ");
    expect(live.state!.doc.pages[i]!.texts?.some((x) => x.panel === original.panel) ?? false).toBe(false);
  });
});

describe("page text tool on a story v4 chapter story page", () => {
  const fv4 = storyFixture({ photos: 24, design, skeleton: "v4", sample: true });
  const v4Doc = (): BookDoc => composeStoryDoc({ storybook: fv4.storybook, photos: fv4.photos, design, lang: "en", occasion: "travel", bookTitle: null, maxPages: 20 }).doc;
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    act(() => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("edits title, subtitle, headline, story and closing line in one panel; each field is its own undo step", () => {
    const d = v4Doc();
    const i = d.pages.findIndex((p) => getPageTemplate(p.layout)?.chapterStory);
    expect(i).toBeGreaterThanOrEqual(0);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness doc={d} selection={{ kind: "text", pageIdx: i, panel: 2 }} />));
    expect(q("page-text-editor")!.getAttribute("data-chapter-story")).toBe("true");
    const fields = ["title", "subtitle", "headline", "intro", "closing_line"].map((k) => q<HTMLInputElement | HTMLTextAreaElement>(`page-text-field-${k}`)!);
    for (const f of fields) expect(f.getAttribute("dir")).toBe("auto");
    // the tapped line (panel 2 = headline) takes the focus
    expect(document.activeElement).toBe(fields[2]);
    const chapterId = d.pages[i]!.chapterId!;
    setValue(fields[0]!, "Our own title");
    setValue(fields[2]!, "A line in our own words.");
    setValue(fields[4]!, "We kept the evening.");
    const page = () => live.state!.doc.pages[i]!;
    expect(live.state!.doc.chapters.find((c) => c.id === chapterId)!.title).toBe("Our own title");
    expect(page().texts!.find((t) => t.panel === 2)).toMatchObject({ role: "headline", text: "A line in our own words.", source: "user" });
    expect(page().texts!.find((t) => t.panel === 3)).toMatchObject({ role: "closing_line", text: "We kept the evening.", source: "user" });
    act(() => q("undo")!.click());
    expect(page().texts!.find((t) => t.panel === 3)!.text).toBe(d.pages[i]!.texts!.find((t) => t.panel === 3)!.text);
    expect(page().texts!.find((t) => t.panel === 2)!.text).toBe("A line in our own words.");
    act(() => q("undo")!.click());
    expect(page().texts!.find((t) => t.panel === 2)!.text).toBe(d.pages[i]!.texts!.find((t) => t.panel === 2)!.text);
    act(() => q("undo")!.click());
    expect(live.state!.doc.chapters.find((c) => c.id === chapterId)!.title).toBe(d.chapters.find((c) => c.id === chapterId)!.title);
    // emptying a line removes it (the divider hides with the closing line)
    setValue(q<HTMLTextAreaElement>("page-text-field-closing_line")!, " ");
    expect(page().texts!.some((t) => t.panel === 3)).toBe(false);
  });
});

describe("Replace photo on a storybook page", () => {
  it("relays out only that page when the new photo no longer fits; ordinary albums keep replacePhoto", () => {
    const d = storyDoc();
    const i = d.pages.findIndex((p) => getPageTemplate(p.layout)?.family === "storytelling" && p.slots.length === 1 && getPageTemplate(p.layout)?.orientations[0] === "landscape");
    const portrait = { id: fixturePhotoId(990), width: 3000, height: 4000 };
    const sizes = new Map([...f.photos, portrait].map((p) => [p.id, { width: p.width, height: p.height }]));
    const next = replaceSlotPhoto(d, i, 0, portrait.id, sizes, "en");
    expect(next.pages[i]!.layout).not.toBe(d.pages[i]!.layout);
    expect(next.pages[i]!.texts).toEqual(d.pages[i]!.texts);
    next.pages.forEach((p, k) => k !== i && expect(p).toBe(d.pages[k]));
    const plain = { ...d, meta: { ...d.meta!, story: undefined } };
    delete plain.meta.story;
    expect(replaceSlotPhoto(plain, i, 0, portrait.id, sizes, "en")).toEqual(replacePhoto(plain, i, 0, portrait.id));
  });
});
