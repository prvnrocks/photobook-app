// M13 T8 — simple editor: ≤ 3 primary tools per selection + "More" (registry.splitTools), every
// tool ≤ 2 taps away, MoreSheet markup (dialog, labelled, testids kept), plain-word labels.
// No DOM environment: open/close/focus flows are covered by e2e/editor.spec.ts.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

import { Circle } from "lucide-react";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { MoreSheet, MORE_SHEET_TITLE } from "@/components/editor/MoreSheet";
import {
  EDITOR_TOOLS,
  MAX_PRIMARY_TOOLS,
  splitTools,
  toolTier,
  visibleTools,
  type EditorTool,
} from "@/components/editor/tools/registry";
import { devEditorData } from "@/lib/editor/dev-fixture";
import { initEditorState, type EditorSelection } from "@/lib/editor/store";
import { REVIEW_EMPTY_TAB_COPY, REVIEW_MOVED_COPY, REVIEW_TAB_LABELS, UPDATE_ALBUM_LABEL } from "@/lib/review/ui";

function ctxFor(opts: { selection?: EditorSelection; page?: number | "cover"; isPaid?: boolean; readOnly?: boolean } = {}) {
  const data = devEditorData("ok");
  // Crop needs the web photo's url + size.
  const web = Object.fromEntries(
    data.doc.pages.flatMap((p) => p.slots.map((sl) => sl.photoId)).filter((id): id is string => !!id).map((id) => [id, { url: "u", width: 1600, height: 1200 }]),
  );
  return {
    book: { ...data.book, isPaid: opts.isPaid ?? false, maxPages: opts.isPaid ? 100 : 20 },
    state: { ...initEditorState(data.doc, { readOnly: opts.readOnly, page: opts.page ?? 0 }), selection: opts.selection ?? null },
    readOnly: opts.readOnly === true,
    paymentsEnabled: true,
    photos: { web, thumbs: {} },
    save: { status: { kind: "idle" }, flush: vi.fn(), settle: vi.fn() },
    activeTool: null,
    openTool: vi.fn(),
    closeTool: vi.fn(),
  } as unknown as EditorContextValue;
}

const split = (ctx: EditorContextValue) => {
  const s = splitTools(visibleTools(EDITOR_TOOLS, ctx), ctx);
  return { primary: s.primary.map((t) => t.id), more: s.more.map((t) => t.id) };
};

const SLOT: EditorSelection = { kind: "slot", pageIdx: 0, slotIdx: 0 };
const CAPTION: EditorSelection = { kind: "caption", pageIdx: 0 };

describe("simple toolbar split (M13 T8)", () => {
  it("page (nothing selected): Layout / Background / Pages + More", () => {
    const s = split(ctxFor());
    expect(s.primary).toEqual(["layout", "background", "pages"]);
    expect(s.more).toEqual(["add-page", "page-menu", "see-photos", "upgrade"]);
    expect(split(ctxFor({ isPaid: true })).more).toEqual(["add-page", "page-menu", "see-photos", "pdf"]);
  });

  it("More (nothing selected): See all photos always (read-only too); Redo with AI only when aiPath allows (M13 review)", () => {
    const withAi = (aiPath: EditorContextValue["aiPath"], readOnly = false) =>
      split({ ...ctxFor({ readOnly }), aiPath } as EditorContextValue).more;
    expect(withAi({ makeWithAi: false, redoWithAi: true })).toEqual(["add-page", "page-menu", "see-photos", "redo-ai", "upgrade"]);
    expect(withAi({ makeWithAi: true, redoWithAi: false })).not.toContain("redo-ai");
    expect(withAi(undefined)).not.toContain("redo-ai");
    // Read-only: the doc tools and Redo hide; See all photos stays (it only looks).
    const ro = splitTools(visibleTools(EDITOR_TOOLS, { ...ctxFor({ readOnly: true }), aiPath: { makeWithAi: false, redoWithAi: true } } as EditorContextValue), ctxFor({ readOnly: true }));
    const ids = [...ro.primary, ...ro.more].map((t) => t.id);
    expect(ids).toContain("see-photos");
    expect(ids).not.toContain("redo-ai");
    // Selected photo/caption: not offered (page-level only).
    expect(split(ctxFor({ selection: SLOT })).more).not.toContain("see-photos");
  });

  it("MoreSheet renders link entries as real links to the review screen", () => {
    const ctx = { ...ctxFor(), aiPath: { makeWithAi: false, redoWithAi: true } } as EditorContextValue;
    const tools = EDITOR_TOOLS.filter((t) => t.id === "see-photos" || t.id === "redo-ai");
    const html = renderToStaticMarkup(<MoreSheet id="m" tools={tools} ctx={ctx} onClose={vi.fn()} onPick={vi.fn()} />);
    const bookId = ctx.book.id;
    expect(html).toContain(`<a class="`);
    expect(html).toMatch(new RegExp(`<a[^>]*data-testid="editor-tool-see-photos"[^>]*href="/books/${bookId}/review"`));
    expect(html).toMatch(new RegExp(`<a[^>]*data-testid="editor-tool-redo-ai"[^>]*href="/books/${bookId}/review"`));
    expect(html).toContain("See all photos");
    expect(html).toContain("Redo with AI");
  });

  it("photo: Replace / Crop + More (Layout behind More)", () => {
    const s = split(ctxFor({ selection: SLOT }));
    expect(s.primary).toEqual(["replace", "crop"]);
    expect(s.more).toContain("layout");
    expect(s.more).toContain("add-page");
  });

  it("caption: Edit / AI help + More (Font, Layout…)", () => {
    const s = split(ctxFor({ selection: CAPTION }));
    expect(s.primary).toEqual(["caption", "ai-caption"]);
    expect(s.more).toContain("caption-style");
  });

  it("every selection: ≤ 4 row buttons, ≤ 3 primary, every visible tool in the row or More (≤ 2 taps)", () => {
    const cases: EditorContextValue[] = [
      ctxFor(),
      ctxFor({ isPaid: true }),
      ctxFor({ page: "cover" }),
      ctxFor({ selection: SLOT }),
      ctxFor({ selection: CAPTION }),
      ctxFor({ selection: { kind: "cover", part: "photo" }, page: "cover" }),
      ctxFor({ selection: { kind: "cover", part: "text" }, page: "cover" }),
      ctxFor({ readOnly: true }),
    ];
    for (const ctx of cases) {
      const shown = visibleTools(EDITOR_TOOLS, ctx);
      const s = splitTools(shown, ctx);
      const buttons = s.primary.length + (s.more.length > 0 ? 1 : 0);
      expect(buttons).toBeLessThanOrEqual(4);
      expect(s.more.length === 0 || s.primary.length <= MAX_PRIMARY_TOOLS).toBe(true);
      expect(s.more.length).not.toBe(1);
      expect([...s.primary, ...s.more].map((t) => t.id).sort()).toEqual(shown.map((t) => t.id).sort());
    }
  });

  it("caps primaries at 3, folds a lone More tool into the row", () => {
    const t = (id: string, tier?: EditorTool["tier"]): EditorTool => ({ id, label: id, icon: Circle, scopes: "always", tier });
    const ctx = ctxFor();
    const four = splitTools([t("a", "primary"), t("b", "primary"), t("c", "primary"), t("d", "primary"), t("e")], ctx);
    expect(four.primary.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(four.more.map((x) => x.id)).toEqual(["d", "e"]);
    const lone = splitTools([t("a", "primary"), t("b")], ctx);
    expect(lone.primary.map((x) => x.id)).toEqual(["a", "b"]);
    expect(lone.more).toEqual([]);
  });

  it("tier resolves per selection kind, default more", () => {
    expect(toolTier({}, "none")).toBe("more");
    expect(toolTier({ tier: "primary" }, "slot")).toBe("primary");
    expect(toolTier({ tier: { none: "primary" } }, "none")).toBe("primary");
    expect(toolTier({ tier: { none: "primary" } }, "slot")).toBe("more");
  });

  it("plain labels", () => {
    const label = (id: string) => EDITOR_TOOLS.find((t) => t.id === id)?.label;
    expect(label("caption")).toBe("Edit");
    expect(label("ai-caption")).toBe("AI help");
    expect(label("page-menu")).toBe("Page options");
    expect(label("pdf")).toBe("Download PDF");
  });
});

describe("MoreSheet markup", () => {
  it("labelled modal dialog; tools keep editor-tool-<id> testids; disabled and active states", () => {
    const ctx = { ...ctxFor(), activeTool: "page-menu" } as EditorContextValue;
    const tools: EditorTool[] = [
      { id: "x1", label: "One", icon: Circle, scopes: "always", Panel: () => null },
      { id: "page-menu", label: "Page options", icon: Circle, scopes: "always", Panel: () => null },
      { id: "x3", label: "Three", icon: Circle, scopes: "always", isDisabled: () => true, run: () => {} },
    ];
    const html = renderToStaticMarkup(<MoreSheet id="more-1" tools={tools} ctx={ctx} onClose={() => {}} onPick={() => {}} />);
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="[^"]+"/);
    expect(html).toContain('id="more-1"');
    expect(html).toContain(MORE_SHEET_TITLE);
    expect(html).toContain('data-testid="editor-more-sheet"');
    expect(html).toContain('data-testid="editor-more-close"');
    for (const t of tools) expect(html).toContain(`data-testid="editor-tool-${t.id}"`);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="editor-tool-page-menu"/);
    expect(html).toMatch(/disabled=""[^>]*data-testid="editor-tool-x3"/);
    // ≥ 44 px rows (min-h-12 = 48 px).
    expect(html.match(/min-h-12/g)?.length).toBe(3);
  });
});

describe("plain review words (M13 T8)", () => {
  it("In your book / Left out / Apply photo changes", () => {
    expect(REVIEW_TAB_LABELS).toEqual({ kept: "In your book", dropped: "Left out" });
    expect(REVIEW_EMPTY_TAB_COPY.dropped).toBe("Nothing left out — every photo is in your book.");
    expect(REVIEW_MOVED_COPY.kept).toBe("Moved to In your book");
    expect(UPDATE_ALBUM_LABEL).toBe("Apply photo changes");
  });
});
