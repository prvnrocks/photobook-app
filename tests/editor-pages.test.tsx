import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { dismissEditorToast, showEditorToast, useEditorToast } from "@/components/editor/EditorToast";
import { openUpgrade, UPGRADE_TOOL_ID, UpgradeSheet, upgradeReasonCopy, upgradeTool } from "@/components/editor/UpgradeSheet";
import { addPageTool, runAddPage } from "@/components/editor/tools/add-page";
import { PageMenu, pageMenuTool } from "@/components/editor/tools/page-menu";
import { PagesSheet, pagesTool } from "@/components/editor/tools/pages";
import { EDITOR_TOOLS, visibleTools } from "@/components/editor/tools/registry";
import { deletePage, usedPhotoIds } from "@/lib/book/edit-ops";
import type { BookDoc } from "@/lib/book/types";
import { devEditorData } from "@/lib/editor/dev-fixture";
import { parseDevPages, withDevPages, withDevPagesData } from "@/lib/editor/dev-pages-fixture";
import {
  addPageDecision,
  chapterLabel,
  indexAfterChapterMove,
  movePageById,
  pageCountLabel,
  positionAfterMove,
} from "@/lib/editor/pages";
import {
  editorReducer,
  initEditorState,
  type EditorAction,
  type EditorPosition,
  type EditorSelection,
  type EditorState,
} from "@/lib/editor/store";

// The editor registry → UpgradeSheet → UpgradeButton imports the upgrade server action (server-only).
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

const FREE = { isPaid: false, maxPages: 20 };
const PAID = { isPaid: true, maxPages: 100 };

function doc20(): BookDoc {
  return withDevPages(devEditorData("ok").doc, 20);
}

/** A ctx whose actions run the real reducer, so tool logic is tested end to end. */
function liveCtx(
  doc: BookDoc,
  opts: { book?: Partial<typeof FREE>; page?: EditorPosition; selection?: EditorSelection; readOnly?: boolean; activeTool?: string | null } = {},
) {
  const data = devEditorData("ok");
  const box: { state: EditorState } = {
    state: { ...initEditorState(doc, { readOnly: opts.readOnly, page: opts.page }), selection: opts.selection ?? null },
  };
  const dispatch = (a: EditorAction) => {
    box.state = editorReducer(box.state, a);
  };
  const openTool = vi.fn();
  const edit = vi.fn((op, o = {}) => dispatch({ type: "apply", op, ...o }));
  const ctx = {
    book: { ...data.book, ...opts.book },
    get state() {
      return box.state;
    },
    readOnly: opts.readOnly === true,
    actions: {
      edit,
      undo: () => dispatch({ type: "undo" }),
      goTo: (page: EditorPosition) => dispatch({ type: "goTo", page }),
    },
    photos: { web: {}, thumbs: {} },
    activeTool: opts.activeTool ?? null,
    openTool,
    closeTool: vi.fn(),
  } as unknown as EditorContextValue;
  return { ctx, box, openTool, edit };
}

describe("addPageDecision", () => {
  it("adds after the current page, before page 1 from the cover", () => {
    const doc = devEditorData("ok").doc;
    expect(addPageDecision(doc, FREE, 2)).toEqual({ kind: "add", afterIdx: 2 });
    expect(addPageDecision(doc, FREE, "cover")).toEqual({ kind: "add", afterIdx: -1 });
  });

  it("free book at 20 pages → upgrade; paid at 20 → add; paid at 100 → full", () => {
    const d = doc20();
    expect(addPageDecision(d, FREE, 5)).toEqual({ kind: "upgrade" });
    expect(addPageDecision(d, PAID, 5)).toEqual({ kind: "add", afterIdx: 5 });
    const d100 = withDevPages(devEditorData("ok").doc, 20);
    const full = { ...d100, pages: Array.from({ length: 100 }, (_, i) => ({ ...d100.pages[0], id: `f${i}` })) };
    expect(addPageDecision(full, PAID, 0)).toEqual({ kind: "full" });
  });

  it("a doc already over the limit also opens the upgrade sheet", () => {
    const d = doc20();
    expect(addPageDecision(d, { isPaid: false, maxPages: 12 }, 0)).toEqual({ kind: "upgrade" });
  });
});

describe("Add page tool", () => {
  it("free book at 20 pages: opens Upgrade, never creates page 21", () => {
    const { ctx, box, openTool, edit } = liveCtx(doc20(), { page: 19 });
    runAddPage(ctx);
    expect(openTool).toHaveBeenCalledWith(UPGRADE_TOOL_ID);
    expect(edit).not.toHaveBeenCalled();
    expect(box.state.doc.pages).toHaveLength(20);
    expect(addPageTool.isDisabled?.(ctx)).toBe(false);
  });

  it("below the limit: inserts an empty page after the current one and jumps to it", () => {
    const d = doc20();
    const d19 = { ...d, pages: d.pages.slice(0, 19) };
    const { ctx, box, openTool } = liveCtx(d19, { page: 4 });
    runAddPage(ctx);
    expect(openTool).not.toHaveBeenCalled();
    expect(box.state.doc.pages).toHaveLength(20);
    expect(box.state.page).toBe(5);
    expect(box.state.doc.pages[5].slots.every((s) => s.photoId === null)).toBe(true);
    // Now at 20: the next tap opens Upgrade.
    runAddPage(ctx);
    expect(box.state.doc.pages).toHaveLength(20);
    expect(openTool).toHaveBeenCalledWith(UPGRADE_TOOL_ID);
  });

  it("from the cover: the new page becomes page 1", () => {
    const doc = devEditorData("ok").doc;
    const { ctx, box } = liveCtx(doc, { page: "cover" });
    runAddPage(ctx);
    expect(box.state.doc.pages).toHaveLength(doc.pages.length + 1);
    expect(box.state.page).toBe(0);
  });

  it("read-only: does nothing; paid book at 100: disabled", () => {
    const { ctx, edit, openTool } = liveCtx(devEditorData("ok").doc, { readOnly: true });
    runAddPage(ctx);
    expect(edit).not.toHaveBeenCalled();
    expect(openTool).not.toHaveBeenCalled();
    const d = doc20();
    const full = { ...d, pages: Array.from({ length: 100 }, (_, i) => ({ ...d.pages[0], id: `f${i}` })) };
    expect(addPageTool.isDisabled?.(liveCtx(full, { book: PAID }).ctx)).toBe(true);
  });
});

describe("page moves", () => {
  it("positionAfterMove follows the shown page", () => {
    expect(positionAfterMove("cover", 1, 3)).toBe("cover");
    expect(positionAfterMove(1, 1, 3)).toBe(3);
    expect(positionAfterMove(2, 1, 3)).toBe(1);
    expect(positionAfterMove(3, 1, 3)).toBe(2);
    expect(positionAfterMove(4, 1, 3)).toBe(4);
    expect(positionAfterMove(1, 3, 1)).toBe(2);
    expect(positionAfterMove(3, 3, 1)).toBe(1);
    expect(positionAfterMove(0, 3, 1)).toBe(0);
  });

  it("movePageById moves by id, takes the previous page's chapter, ignores unknown ids", () => {
    const d = doc20();
    const a = d.pages[0];
    const target = d.pages[10];
    const out = movePageById(d, a.id, target.id);
    expect(out.pages[10].id).toBe(a.id);
    expect(out.pages[10].chapterId).toBe(out.pages[9].chapterId);
    expect(movePageById(d, "nope", target.id)).toBe(d);
    expect(movePageById(d, a.id, a.id)).toBe(d);
  });

  it("indexAfterChapterMove appends to the chapter", () => {
    const d = doc20();
    const last = d.chapters[d.chapters.length - 1].id;
    expect(indexAfterChapterMove(d, 0, last)).toBe(19);
    const first = d.chapters[0].id;
    const lastOfFirst = d.pages.map((p) => p.chapterId).lastIndexOf(first);
    expect(indexAfterChapterMove(d, 19, first)).toBe(lastOfFirst + 1);
    expect(indexAfterChapterMove(d, 0, "missing")).toBeNull();
    expect(indexAfterChapterMove(d, 99, first)).toBeNull();
  });

  it("labels", () => {
    const d = doc20();
    expect(chapterLabel(d, d.chapters[0].id)).toBe("The ceremony");
    expect(chapterLabel(d, null)).toBeNull();
    expect(chapterLabel({ ...d, chapters: [{ ...d.chapters[0], title: " " }] }, d.chapters[0].id)).toBe("Untitled chapter");
    expect(pageCountLabel(12, 20)).toBe("12 of 20 pages");
  });
});

describe("tool visibility", () => {
  it("Pages / Page / Upgrade show with nothing selected; Page is hidden on the cover", () => {
    const ids = (ctx: EditorContextValue) => visibleTools([pagesTool, addPageTool, pageMenuTool, upgradeTool], ctx).map((t) => t.id);
    expect(ids(liveCtx(doc20(), { page: 3 }).ctx)).toEqual(["pages", "add-page", "page-menu", "upgrade"]);
    expect(ids(liveCtx(doc20(), { page: "cover" }).ctx)).toEqual(["pages", "add-page", "upgrade"]);
    const slot: EditorSelection = { kind: "slot", pageIdx: 3, slotIdx: 0 };
    expect(ids(liveCtx(doc20(), { page: 3, selection: slot }).ctx)).toEqual(["add-page"]);
    // While open, Upgrade stays visible whatever the selection (opened from another tool).
    expect(ids(liveCtx(doc20(), { page: 3, selection: slot, activeTool: UPGRADE_TOOL_ID }).ctx)).toContain("upgrade");
    // Paid books never see Upgrade; read-only keeps navigation + Upgrade only.
    expect(ids(liveCtx(doc20(), { page: 3, book: PAID }).ctx)).not.toContain("upgrade");
    expect(ids(liveCtx(doc20(), { page: 3, readOnly: true }).ctx)).toEqual(["pages", "upgrade"]);
  });

  it("all Task 11 tools are registered", () => {
    const ids = EDITOR_TOOLS.map((t) => t.id);
    for (const id of ["pages", "add-page", "page-menu", UPGRADE_TOOL_ID]) expect(ids).toContain(id);
  });

  it("openUpgrade is a no-op for paid books", () => {
    const openTool = vi.fn();
    openUpgrade({ book: { ...devEditorData("ok").book, isPaid: true }, openTool });
    expect(openTool).not.toHaveBeenCalled();
    openUpgrade({ book: devEditorData("ok").book, openTool });
    expect(openTool).toHaveBeenCalledWith(UPGRADE_TOOL_ID);
  });
});

describe("render smoke", () => {
  it("UpgradeSheet: price, features, live Upgrade button (payments on)", () => {
    const book = devEditorData("ok").book;
    const html = renderToStaticMarkup(<UpgradeSheet reason="pages" ctx={{ book, paymentsEnabled: true }} />);
    expect(html).toContain("Upgrade this book");
    expect(html).toContain("AED 39");
    expect(html).toContain("Up to 100 pages");
    expect(html).toContain("No watermark");
    expect(html).toContain("PDF download");
    expect(html).toContain("Permanent link");
    expect(html).toContain("Upgrade this book — AED 39");
    expect(html).toMatch(/<button type="button" class="[^"]*" data-testid="upgrade-button"/); // no disabled=""
    expect(html).not.toContain("Coming soon");
    expect(html).not.toContain("upgrade-button-unavailable");
    expect(html).toContain(upgradeReasonCopy("pages")!);
    expect(upgradeReasonCopy("general")).toBeNull();
  });

  it("UpgradeSheet: payments off → disabled + Payments unavailable; absent flag counts as off", () => {
    const book = devEditorData("ok").book;
    for (const paymentsEnabled of [false, undefined]) {
      const html = renderToStaticMarkup(<UpgradeSheet reason="rewrites" ctx={{ book, paymentsEnabled }} />);
      expect(html).toMatch(/<button type="button" disabled=""[^>]*data-testid="upgrade-button"/);
      expect(html).toContain('data-testid="upgrade-button-unavailable"');
      expect(html).toContain("Payments unavailable");
      expect(html).not.toMatch(/coming soon/i);
    }
  });

  it("UpgradeSheet: paid book → no button", () => {
    const book = { ...devEditorData("ok").book, isPaid: true };
    const html = renderToStaticMarkup(<UpgradeSheet ctx={{ book, paymentsEnabled: true }} />);
    expect(html).not.toContain('data-testid="upgrade-button"');
    expect(html).toContain('data-testid="upgrade-already-paid"');
  });

  it("PagesSheet: one sortable tile per page with move buttons, count label", () => {
    const { ctx } = liveCtx(doc20(), { page: 2 });
    const html = renderToStaticMarkup(<PagesSheet ctx={ctx} close={() => {}} />);
    expect(html.match(/data-testid="pages-tile"/g)).toHaveLength(20);
    expect(html).toContain("20 of 20 pages");
    expect(html).toContain('aria-label="Move page 1 earlier"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Move page 1 earlier"/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Move page 20 later"/);
    expect(html).toContain('aria-label="Page 3, current page"');
  });

  it("PagesSheet read-only: no move buttons", () => {
    const { ctx } = liveCtx(doc20(), { readOnly: true });
    const html = renderToStaticMarkup(<PagesSheet ctx={ctx} close={() => {}} />);
    expect(html).not.toContain("pages-move-earlier");
    expect(html.match(/data-testid="pages-tile"/g)).toHaveLength(20);
  });

  it("PageMenu: chapters with dir=auto, current chapter disabled, delete button", () => {
    const { ctx } = liveCtx(doc20(), { page: 0 });
    const html = renderToStaticMarkup(<PageMenu ctx={ctx} close={() => {}} />);
    expect(html).toContain("Page 1 of 20");
    expect(html.match(/data-testid="page-menu-chapter"/g)).toHaveLength(3);
    expect(html).toContain('<span dir="auto" class="min-w-0 flex-1 truncate">عشاء العائلة</span>');
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-current="true"/);
    expect(html).toContain("Delete page 1");
  });

  it("PageMenu on the cover renders nothing", () => {
    const { ctx } = liveCtx(doc20(), { page: "cover" });
    expect(renderToStaticMarkup(<PageMenu ctx={ctx} close={() => {}} />)).toBe("");
  });
});

describe("toast store", () => {
  function Probe() {
    const t = useEditorToast();
    return <span>{t ? `${t.message}|${t.action?.label ?? ""}` : "none"}</span>;
  }

  it("server snapshot is empty; show / dismiss by id; flat action alias", () => {
    expect(renderToStaticMarkup(<Probe />)).toContain("none");
    const run = vi.fn();
    const id = showEditorToast({ message: "Page 3 deleted", actionLabel: "Undo", onAction: run });
    dismissEditorToast(id + 1); // stale id: ignored
    const id2 = showEditorToast({ message: "x", action: { label: "Undo", run } });
    expect(id2).toBeGreaterThan(id);
    dismissEditorToast(id2);
    dismissEditorToast();
  });
});

describe("Delete + undo via the reducer", () => {
  it("delete a page, then undo restores it", () => {
    const d = doc20();
    const { ctx, box } = liveCtx(d, { page: 4 });
    ctx.actions.edit((doc) => deletePage(doc, 4), { select: null });
    expect(box.state.doc.pages).toHaveLength(19);
    ctx.actions.undo();
    expect(box.state.doc).toBe(d);
  });
});

describe("dev pages fixture", () => {
  it("20 pages in 3 chapters, every photo used once, only ?pages=20 accepted", () => {
    const d = doc20();
    expect(d.pages).toHaveLength(20);
    expect(new Set(d.pages.map((p) => p.id)).size).toBe(20);
    expect(new Set(d.pages.map((p) => p.chapterId))).toEqual(new Set(d.chapters.map((c) => c.id)));
    const placed = d.pages.flatMap((p) => p.slots.map((s) => s.photoId)).filter((x) => x !== null);
    expect(placed.length).toBe(usedPhotoIds(d, { includeCover: false }).size);
    expect(parseDevPages("20")).toBe(20);
    expect(parseDevPages("21")).toBeNull();
    expect(parseDevPages(undefined)).toBeNull();
    const data = devEditorData("ok");
    expect(withDevPagesData(data, null)).toBe(data);
  });
});
