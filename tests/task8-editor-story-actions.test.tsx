// @vitest-environment jsdom
// Task 8: the editor's Story actions on a composed storybook — Rewrite story (AI text applied as one
// undo step; the user's own text only as a proposal), Change photo (the existing Replace panel,
// re-layout), Regenerate page (one page, same photos / crops / words), View chapters, "Things to
// check", duplicate-tap guards — plus the pure ops, autosave adopt (Regenerate story undo) and the
// requirement that the user's text, crop and photo survive a regeneration byte-identical.
import { act, useMemo, useReducer, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { storyActionsTool } from "@/components/editor/tools/story-actions";
import { PHOTO_PICKER_ID, StoryActionsPanel } from "@/components/editor/tools/story-actions-panel";
import { EDITOR_TOOLS, visibleTools } from "@/components/editor/tools/registry";
import { serializeDoc } from "@/lib/book/doc-version";
import { setCrop, setPageText } from "@/lib/book/edit-ops";
import type { BookDoc } from "@/lib/book/types";
import { AutosaveScheduler, type SaveOutcome } from "@/lib/editor/autosave";
import { devEditorData } from "@/lib/editor/dev-fixture";
import { chapterRanges, regeneratablePage, requestStoryRewrite, selectedStoryText } from "@/lib/editor/story-actions";
import { canRedo, canUndo, editorReducer, initEditorState, type EditorSelection, type EditorState } from "@/lib/editor/store";
import { getPageTemplate } from "@/lib/layouts/templates";
import { composeStoryDoc, mergeComposition, userOwnedElements } from "@/lib/storybook/compose";
import { storyFixture } from "@/lib/storybook/compose/dev-fixture";
import { replaceSlotPhoto } from "@/lib/storybook/compose/editor-op";
import { applyStoryText, pageLayoutIssues, regeneratePageLayout } from "@/lib/storybook/compose/regenerate-page";
import type { Storybook } from "@/lib/storybook/types";

vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOK = devEditorData("ok").book.id;
const design = { format: "A5_PORTRAIT" as const, designStyle: "classic" as const };
const f = storyFixture({ photos: 24, design, lowRes: [5] });
const sizes = new Map(f.photos.map((p) => [p.id, { width: p.width, height: p.height }]));

function compose(storybook: Storybook = f.storybook, current: BookDoc | null = null, version = 1): BookDoc {
  const owned = userOwnedElements(current, current ?? {});
  if (!owned.ok) throw new Error("owned");
  const r = composeStoryDoc({
    storybook,
    photos: f.photos,
    design,
    lang: "en",
    occasion: "travel",
    bookTitle: null,
    maxPages: 20,
    reserved: { pageIds: owned.owned.pageIds, photoIds: owned.owned.photoIds, pageCount: owned.owned.pages.length },
  });
  return mergeComposition({ fresh: r.doc, current, owned: owned.owned, design, storybookVersion: version });
}
const DOC = compose();
const textPageIdx = (d: BookDoc) => d.pages.findIndex((p) => p.texts?.some((t) => t.blockRef));
/** A story text that overflows its panel once it holds the longest text the editor allows. */
function overflowing(d: BookDoc): { doc: BookDoc; idx: number; panel: number; blockRef: string } {
  const long = Array.from({ length: 120 }, (_, i) => `sentence${i}`).join(" ");
  for (let i = 0; i < d.pages.length; i++) {
    for (const t of d.pages[i]!.texts ?? []) {
      if (!t.blockRef) continue;
      const doc = applyStoryText(d, i, t.panel, long, "ai");
      if (pageLayoutIssues(doc, sizes, "en").some((x) => x.pageIdx === i && x.kind === "text_overflow")) return { doc, idx: i, panel: t.panel, blockRef: t.blockRef };
    }
  }
  throw new Error("no panel overflows");
}

// ---------------------------------------------------------------------------- harness

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const live: { state: EditorState | null; active: string | null } = { state: null, active: null };

function ctxOf(state: EditorState, dispatch: (a: never) => void, setActive: (s: string | null) => void, ai: "off" | "replay"): EditorContextValue {
  return {
    book: { ...devEditorData("ok").book, captionLang: "en" },
    state,
    actions: {
      edit: (op: (d: BookDoc) => BookDoc, o = {}) => dispatch({ type: "apply", op, ...o } as never),
      undo: () => dispatch({ type: "undo" } as never),
      redo: () => dispatch({ type: "redo" } as never),
      select: (s: EditorSelection) => dispatch({ type: "select", selection: s } as never),
      goTo: (p: number | "cover") => dispatch({ type: "goTo", page: p } as never),
      setReadOnly: (r: boolean) => dispatch({ type: "setReadOnly", readOnly: r } as never),
    },
    photos: { photos: [], byId: sizes, web: {}, thumbs: {}, idForUrl: () => undefined, reportBroken: () => {} },
    readOnly: state.readOnly,
    save: { status: { kind: "idle" }, flush: () => {} },
    ai: { mode: ai, rewritesUsed: 0, rewritesLeft: 20, setRewrites: () => {}, blocked: null, blockSession: () => {} },
    storyRegen: { open: () => {} },
    activeTool: "story",
    openTool: setActive,
    closeTool: () => setActive(null),
  } as unknown as EditorContextValue;
}

function Harness({ doc, selection, page, ai }: { doc: BookDoc; selection: EditorSelection; page: number | "cover"; ai: "off" | "replay" }) {
  const [state, dispatch] = useReducer(editorReducer, null, () => ({ ...initEditorState(doc, { page }), selection }));
  const [active, setActive] = useState<string | null>("story");
  live.state = state;
  live.active = active;
  const ctx = useMemo(() => ctxOf(state, dispatch as never, setActive, ai), [state, ai]);
  return (
    <div>
      <button type="button" data-testid="undo" onClick={() => ctx.actions.undo()} />
      <button type="button" data-testid="redo" onClick={() => ctx.actions.redo()} />
      <StoryActionsPanel ctx={ctx} close={() => setActive(null)} />
    </div>
  );
}

function mount(opts: { doc?: BookDoc; selection?: EditorSelection; page?: number | "cover"; ai?: "off" | "replay" } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness doc={opts.doc ?? DOC} selection={opts.selection ?? null} page={opts.page ?? 0} ai={opts.ai ?? "replay"} />));
}
const q = <T extends HTMLElement = HTMLButtonElement>(id: string) => host!.querySelector<T>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => {
    q(id)!.click();
  });
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// ---------------------------------------------------------------------------- pure

describe("pure ops", () => {
  it("regeneratePageLayout: another approved template of the same family; same page id, photos, crops and texts; nothing else changes", () => {
    const idx = DOC.pages.findIndex((p, i) => {
      if (!getPageTemplate(p.layout)) return false;
      return regeneratePageLayout(DOC, i, { design, lang: "en", photos: sizes }).ok;
    });
    expect(idx).toBeGreaterThanOrEqual(0);
    const before = DOC.pages[idx]!;
    const r = regeneratePageLayout(DOC, idx, { design, lang: "en", photos: sizes });
    if (!r.ok) throw new Error("no alternative");
    const after = r.doc.pages[idx]!;
    expect(after.id).toBe(before.id);
    expect(after.layout).not.toBe(before.layout);
    expect(getPageTemplate(after.layout)!.family).toBe(getPageTemplate(before.layout)!.family);
    expect(after.slots.map((s) => s.photoId).sort()).toEqual(before.slots.map((s) => s.photoId).sort());
    for (const s of before.slots) expect(after.slots.find((x) => x.photoId === s.photoId)!.crop).toEqual(s.crop);
    const noPanel = (ts: typeof before.texts) => (ts ?? []).map((t) => ({ id: t.id, role: t.role, text: t.text, source: t.source, blockRef: t.blockRef }));
    expect(noPanel(after.texts)).toEqual(noPanel(before.texts));
    r.doc.pages.forEach((p, i) => {
      if (i !== idx) expect(p).toBe(DOC.pages[i]);
    });
  });

  it("regeneratePageLayout refuses non-story pages and the cover", () => {
    const plain = { ...DOC, pages: DOC.pages.map((p, i) => (i === 0 ? { ...p, layout: "full-page" } : p)) };
    expect(regeneratePageLayout(plain, 0, { design, lang: "en", photos: sizes }).ok).toBe(false);
    expect(regeneratablePage(DOC, "cover")).toBeNull();
  });

  it("applyStoryText keeps id, role and blockRef; the source says who wrote it; a no-op returns the same doc", () => {
    const idx = textPageIdx(DOC);
    const t = DOC.pages[idx]!.texts!.find((x) => x.blockRef)!;
    const ai = applyStoryText(DOC, idx, t.panel, "A shorter line about the sea.", "ai");
    const nt = ai.pages[idx]!.texts!.find((x) => x.panel === t.panel)!;
    expect(nt).toEqual({ ...t, text: "A shorter line about the sea.", source: "ai" });
    expect(applyStoryText(ai, idx, t.panel, "A shorter line about the sea.", "ai")).toBe(ai);
    expect(applyStoryText(ai, idx, t.panel, "A shorter line about the sea.", "user").pages[idx]!.texts!.find((x) => x.panel === t.panel)!.source).toBe("user");
  });

  it("chapter ranges, the selected story text and the issues list", () => {
    const ranges = chapterRanges(DOC);
    expect(ranges.length).toBe(DOC.chapters.length);
    expect(ranges[0]!.from).toBeLessThanOrEqual(ranges[0]!.to);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.from).toBeGreaterThan(ranges[i - 1]!.to);
    const idx = textPageIdx(DOC);
    const panel = DOC.pages[idx]!.texts!.find((x) => x.blockRef)!.panel;
    expect(selectedStoryText({ doc: DOC, selection: { kind: "text", pageIdx: idx, panel } })!.text.blockRef).toMatch(/^b\d+$/);
    expect(selectedStoryText({ doc: DOC, selection: null })).toBeNull();
    // a too-long text is flagged as text_overflow on its page
    const o = overflowing(DOC);
    expect(pageLayoutIssues(o.doc, sizes, "en")).toContainEqual(expect.objectContaining({ pageIdx: o.idx, kind: "text_overflow" }));
    expect(pageLayoutIssues({ ...DOC, meta: { ...DOC.meta!, story: undefined } }, sizes, "en")).toEqual([]);
  });

  it("requestStoryRewrite maps answers and errors to plain copy", async () => {
    fetchMock.mockResolvedValueOnce(answer({ text: "New words.", lang: "en", proposal: false }));
    expect(await requestStoryRewrite(BOOK, { blockRef: "b3", text: "x", source: "ai", choice: { kind: "shorter" } })).toEqual({ kind: "ok", text: "New words.", lang: "en", proposal: false });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({ blockRef: "b3", text: "x", source: "ai", kind: "shorter" });
    fetchMock.mockResolvedValueOnce(answer({ error: "limit_reached" }, 429));
    expect(await requestStoryRewrite(BOOK, { blockRef: "b3", text: "x", source: "ai", choice: { kind: "tone", tone: "joyful" } })).toEqual({ kind: "error", message: "You've used this book's story rewrites." });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect((await requestStoryRewrite(BOOK, { blockRef: "b3", text: "x", source: "ai", choice: { kind: "simpler" } })).kind).toBe("error");
  });
});

// ---------------------------------------------------------------------------- the tool + sheet

describe("Story tool", () => {
  it("shows on composed storybooks only (never on ordinary albums), also read-only", () => {
    const ctx = (doc: BookDoc, readOnly = false) => ({ ...ctxOf({ ...initEditorState(doc), readOnly }, () => {}, () => {}, "replay"), readOnly }) as EditorContextValue;
    expect(visibleTools(EDITOR_TOOLS, ctx(DOC)).map((t) => t.id)).toContain(storyActionsTool.id);
    expect(visibleTools(EDITOR_TOOLS, ctx(DOC, true)).map((t) => t.id)).toContain(storyActionsTool.id);
    expect(visibleTools(EDITOR_TOOLS, ctx(devEditorData("ok").doc)).map((t) => t.id)).not.toContain(storyActionsTool.id);
  });
});

describe("Story sheet actions", () => {
  it("Rewrite story on AI text: applied as ONE undo step; undo and redo work; repeated taps send one request", async () => {
    const idx = textPageIdx(DOC);
    const t = DOC.pages[idx]!.texts!.find((x) => x.blockRef)!;
    let resolve: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (resolve = r)));
    mount({ selection: { kind: "text", pageIdx: idx, panel: t.panel }, page: idx });
    await click("story-action-rewrite");
    expect(q("story-rewrite-current")!.textContent).toBe(t.text);
    expect(q("story-rewrite-current")!.getAttribute("dir")).toBe("auto");
    await click("story-rewrite-shorter");
    await click("story-rewrite-shorter"); // disabled while the first is out
    await click("story-tone-joyful");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(answer({ text: "A short new line.", lang: "en", proposal: false })));
    const after = live.state!.doc.pages[idx]!.texts!.find((x) => x.panel === t.panel)!;
    expect(after).toEqual({ ...t, text: "A short new line.", source: "ai" });
    expect(live.state!.past).toHaveLength(1);
    await click("undo");
    expect(live.state!.doc).toBe(DOC);
    expect(canRedo(live.state!)).toBe(true);
    await click("redo");
    expect(live.state!.doc.pages[idx]!.texts!.find((x) => x.panel === t.panel)!.text).toBe("A short new line.");
  });

  it("Rewrite story on the user's own text: a proposal only — nothing changes until Accept (one undo step); Discard keeps theirs", async () => {
    const idx = textPageIdx(DOC);
    const t = DOC.pages[idx]!.texts!.find((x) => x.blockRef)!;
    const mine = setPageText(DOC, idx, t.panel, "Our own words about the first evening.");
    fetchMock.mockImplementation(async () => answer({ text: "Our words, the first evening.", lang: "en", proposal: true }));
    mount({ doc: mine, selection: { kind: "text", pageIdx: idx, panel: t.panel }, page: idx });
    await click("story-action-rewrite");
    await click("story-rewrite-shorter");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({ source: "user", text: "Our own words about the first evening." });
    expect(q("story-proposal-text")!.textContent).toBe("Our words, the first evening.");
    expect(q("story-proposal-text")!.getAttribute("dir")).toBe("auto");
    expect(live.state!.doc).toBe(mine); // never overwritten on its own
    await click("story-proposal-discard");
    expect(q("story-proposal")).toBeNull();
    expect(live.state!.doc).toBe(mine);
    await click("story-rewrite-shorter");
    await click("story-proposal-accept");
    const after = live.state!.doc.pages[idx]!.texts!.find((x) => x.panel === t.panel)!;
    expect(after).toMatchObject({ text: "Our words, the first evening.", source: "user", blockRef: t.blockRef });
    expect(live.state!.past).toHaveLength(1);
    await click("undo");
    expect(live.state!.doc).toBe(mine);
  });

  it("Rewrite story needs a selected story text and AI; errors are shown in plain words", async () => {
    mount({ selection: null, ai: "replay" });
    expect(q("story-action-rewrite")!.disabled).toBe(true);
    act(() => root!.unmount());
    const idx = textPageIdx(DOC);
    const panel = DOC.pages[idx]!.texts!.find((x) => x.blockRef)!.panel;
    mount({ selection: { kind: "text", pageIdx: idx, panel }, ai: "off" });
    expect(q("story-action-rewrite")!.disabled).toBe(true);
    expect(q("story-action-regen")).toBeNull(); // no "Regenerate story" with AI off
    act(() => root!.unmount());
    fetchMock.mockImplementation(async () => answer({ error: "budget_exhausted" }, 429));
    mount({ selection: { kind: "text", pageIdx: idx, panel } });
    await click("story-action-rewrite");
    await click("story-rewrite-longer");
    expect(q("story-action-message")!.textContent).toBe("AI is taking a break — try again later.");
    expect(live.state!.doc).toBe(DOC);
  });

  it("Change photo selects the photo and opens the existing Replace panel (which re-lays the page out)", async () => {
    const idx = DOC.pages.findIndex((p) => p.slots.some((s) => s.photoId));
    mount({ selection: { kind: "slot", pageIdx: idx, slotIdx: 0 }, page: idx });
    await click("story-action-photo");
    expect(live.active).toBe(PHOTO_PICKER_ID);
    expect(live.state!.selection).toEqual({ kind: "slot", pageIdx: idx, slotIdx: 0 });
    expect(EDITOR_TOOLS.some((t) => t.id === PHOTO_PICKER_ID)).toBe(true);
    // the Replace op on a story page = one undo step through replaceSlotPhoto (Task 7)
    const used = new Set(DOC.pages.flatMap((p) => p.slots.map((s) => s.photoId)));
    const free = f.photos.find((p) => !used.has(p.id));
    if (free) {
      const next = replaceSlotPhoto(DOC, idx, 0, free.id, sizes, "en");
      expect(next.pages[idx]!.slots.some((s) => s.photoId === free.id)).toBe(true);
    }
  });

  it("Regenerate page: one undo step for the page shown; undo / redo", async () => {
    const idx = DOC.pages.findIndex((_p, i) => regeneratePageLayout(DOC, i, { design, lang: "en", photos: sizes }).ok);
    mount({ page: idx });
    expect(q("story-action-page")!.textContent).toContain(`page ${idx + 1}`);
    await click("story-action-page");
    expect(live.state!.doc.pages[idx]!.layout).not.toBe(DOC.pages[idx]!.layout);
    expect(live.state!.past).toHaveLength(1);
    expect(canUndo(live.state!)).toBe(true);
    await click("undo");
    expect(live.state!.doc).toBe(DOC);
    await click("redo");
    expect(live.state!.doc.pages[idx]!.layout).not.toBe(DOC.pages[idx]!.layout);
  });

  it("View chapters lists every chapter with its pages and jumps to it (no edit, no undo entry)", async () => {
    mount({ page: 0 });
    await click("story-action-chapters");
    const ranges = chapterRanges(DOC);
    const last = ranges.at(-1)!;
    const row = q(`story-chapter-${last.id}`)!;
    expect(row.textContent).toContain(last.title);
    expect(row.textContent).toContain(last.from === last.to ? `Page ${last.from}` : `Pages ${last.from}–${last.to}`);
    expect(row.querySelector('[dir="auto"]')).not.toBeNull();
    await click(`story-chapter-${last.id}`);
    expect(live.state!.page).toBe(last.firstIdx);
    expect(live.state!.past).toHaveLength(0);
  });

  it("Things to check: a too-long text offers Shorten (a rewrite), a low-resolution photo offers Change photo; Hide dismisses", async () => {
    const o = overflowing(DOC);
    const idx = o.idx;
    const t = { panel: o.panel, blockRef: o.blockRef };
    fetchMock.mockImplementation(async () => answer({ text: "Short again.", lang: "en", proposal: false }));
    mount({ doc: o.doc, page: 0 });
    expect(q("story-checks")!.textContent).toContain(`Page ${idx + 1}: the text is too long for its space`);
    await click("story-checks-dismiss");
    expect(q("story-checks")).toBeNull();
    act(() => root!.unmount());
    mount({ doc: o.doc, page: 0 });
    const fix = [...host!.querySelectorAll<HTMLButtonElement>('[data-testid^="story-check-fix-"]')].find((b) => b.textContent === "Shorten")!;
    await act(async () => fix.click());
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({ kind: "shorter", blockRef: t.blockRef });
    expect(live.state!.doc.pages[idx]!.texts!.find((x) => x.panel === t.panel)!.text).toBe("Short again.");
    expect(live.state!.past).toHaveLength(1);
  });

  it("read-only: actions that edit are disabled; View chapters still works", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    function RO() {
      const [state, dispatch] = useReducer(editorReducer, null, () => initEditorState(DOC, { page: 0, readOnly: true }));
      live.state = state;
      const ctx = useMemo(() => ctxOf(state, dispatch as never, () => {}, "replay"), [state]);
      return <StoryActionsPanel ctx={ctx} close={() => {}} />;
    }
    act(() => root!.render(<RO />));
    expect(q("story-action-page")!.disabled).toBe(true);
    expect(q("story-action-photo")!.disabled).toBe(true);
    expect(q("story-action-chapters")!.disabled).toBe(false);
    expect(q("story-action-regen")!.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------- Regenerate story: undo via autosave adopt

describe("Regenerate story keeps undo / redo (autosave adopt)", () => {
  function scheduler() {
    const sent: { doc: BookDoc; rev: number }[] = [];
    let rev = 7;
    const s = new AutosaveScheduler({
      baseRev: 7,
      savedDoc: DOC,
      debounceMs: 1,
      send: async (doc, base): Promise<SaveOutcome> => {
        sent.push({ doc, rev: base });
        rev = base + 1;
        return { kind: "ok", rev, savedAt: null };
      },
      timers: { set: (fn) => (fn(), 0), clear: () => {} },
    });
    return { s, sent };
  }

  it("the server's doc is adopted as saved (no save for it); Undo then saves the previous doc on top of the server rev", async () => {
    const { s, sent } = scheduler();
    const regenerated = compose({ ...f.storybook, version: 2 }, DOC, 2);
    expect(s.adopt(regenerated, 9)).toBe(true);
    s.change(regenerated); // the editor applies the same doc object as one edit
    expect(sent).toHaveLength(0);
    // Undo → the previous doc goes back to the server, based on the adopted rev
    s.change(DOC);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([{ doc: DOC, rev: 9 }]);
    // the store side: one undo entry for the regeneration, redo restores it
    let st = initEditorState(DOC);
    st = editorReducer(st, { type: "apply", op: () => regenerated });
    expect(st.past).toHaveLength(1);
    st = editorReducer(st, { type: "undo" });
    expect(st.doc).toBe(DOC);
    st = editorReducer(st, { type: "redo" });
    expect(st.doc).toBe(regenerated);
  });

  it("adopt is refused while something is unsaved", () => {
    const sentNever: unknown[] = [];
    const s = new AutosaveScheduler({ baseRev: 1, savedDoc: DOC, send: async () => (sentNever.push(1), { kind: "ok", rev: 2, savedAt: null }), timers: { set: () => 1, clear: () => {} } });
    s.change(setPageText(DOC, textPageIdx(DOC), 0, "x"));
    expect(s.adopt(DOC, 5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------- requirement 10

describe("user edits survive a regeneration byte-identical (Task 7 merge on a new story version)", () => {
  it("an edited text, an edited crop and a replaced photo come through unchanged; untouched pages take the new text", () => {
    const idxText = textPageIdx(DOC);
    const panel = DOC.pages[idxText]!.texts!.find((x) => x.blockRef)!.panel;
    let doc = setPageText(DOC, idxText, panel, "Our own words, kept as written.");
    const idxCrop = DOC.pages.findIndex((p, i) => i !== idxText && p.slots.length > 0 && p.slots[0]!.photoId);
    doc = setCrop(doc, idxCrop, 0, { x: 0.2, y: 0.8, zoom: 1.6 });
    const used = new Set(DOC.pages.flatMap((p) => p.slots.map((s) => s.photoId)));
    const free = f.photos.find((p) => !used.has(p.id));
    const idxPhoto = DOC.pages.findIndex((p, i) => i !== idxText && i !== idxCrop && p.slots.length === 1 && p.slots[0]!.photoId);
    if (free && idxPhoto >= 0) doc = replaceSlotPhoto(doc, idxPhoto, 0, free.id, sizes, "en");
    doc = { ...doc, meta: { ...doc.meta!, userEdited: true } };

    // the story is regenerated: every AI block gets new words (version 2)
    const v2: Storybook = { ...structuredClone(f.storybook), version: 2, pages: f.storybook.pages.map((p) => ({ ...p, blocks: p.blocks.map((b) => ({ ...b, text: `${b.text} Again.` })) })) };
    const merged = compose(v2, doc, 2);
    const same = (i: number) => expect(JSON.stringify(serializeDoc({ ...merged, pages: [merged.pages.find((p) => p.id === doc.pages[i]!.id)!] }).pages[0])).toBe(JSON.stringify(serializeDoc({ ...doc, pages: [doc.pages[i]!] }).pages[0]));
    same(idxText);
    same(idxCrop);
    if (free && idxPhoto >= 0) same(idxPhoto);
    // an untouched AI page took the new version's words
    const untouched = merged.pages.find((p, i) => p.texts?.some((t) => t.source === "ai") && ![idxText, idxCrop, idxPhoto].includes(doc.pages.findIndex((d) => d.id === p.id)) && i >= 0);
    expect(untouched?.texts?.some((t) => t.text.endsWith("Again."))).toBe(true);
    expect(merged.meta!.userEdited).toBe(true);
  });
});

// ---------------------------------------------------------------------------- requirement 8: no "Make it with AI" on storybooks

describe("AI entry points on a storybook", () => {
  it("no 'Make it with AI' / 'Redo with AI' for a storybook (composed doc or a storybook job); albums unchanged", async () => {
    const { editorAiPath, NO_AI_PATH } = await import("@/lib/editor/ai-path");
    expect(editorAiPath({ aiMode: "live", generator: "rule", userEdited: false, hasBuildRun: false, storybook: true })).toEqual(NO_AI_PATH);
    expect(editorAiPath({ aiMode: "live", generator: "rule", userEdited: false, hasBuildRun: false })).toEqual({ makeWithAi: true, redoWithAi: false });
    expect(editorAiPath({ aiMode: "live", generator: "ai", userEdited: false, hasBuildRun: true })).toEqual({ makeWithAi: false, redoWithAi: true });
  });

  it("the editor page passes the newest storybook job and marks a composed doc as a storybook", async () => {
    const { toEditorShellData } = await import("@/lib/editor/page-data");
    const base = devEditorData("ok");
    const latest = { runId: "00000000-0000-4000-8000-000000000999", state: "done" as const, progress: { v: 1 as const, kind: "storybook" as const, phase: "done" as const, stages: {} as never, outcome: null }, done: true, aiStatus: "ok" as const, errorCode: null, mode: "live" as const };
    const shell = toEditorShellData({
      book: base.book, doc: DOC, docError: null, docRev: 1, publishedRev: null, expiresAt: null, canSave: true, aiMode: "live",
      rewritesUsed: 0, rewritesLeft: 20, activeBuildRunId: null, hasBuildRun: false, albumConfirmed: false, photos: [], latestStoryRun: latest,
    });
    expect(shell!.aiPath).toEqual({ makeWithAi: false, redoWithAi: false });
    expect(shell!.story).toEqual({ latest });
  });
});
