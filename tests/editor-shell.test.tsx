import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EditorShell } from "@/components/editor/EditorShell";
import { pageCounterLabel } from "@/components/editor/PageCarousel";
import { SaveBanner, SaveStatus, saveStatusLabel } from "@/components/editor/SaveStatus";
import { toolbarHint } from "@/components/editor/EditorToolbar";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { autoOpenTool, EDITOR_TOOLS, visibleTools } from "@/components/editor/tools/registry";
import type { EditorTool } from "@/components/editor/tools/types";
import { devEditorData, devTransport } from "@/lib/editor/dev-fixture";
import { editorRedirect, toEditorShellData } from "@/lib/editor/page-data";
import { mergePhotoUrls, PhotoUrlRefresher, MAX_REFRESHES_PER_PHOTO } from "@/lib/editor/photo-urls";
import { initEditorState, type EditorSelection } from "@/lib/editor/store";
import type { EditorData } from "@/lib/db/editor";

// The editor registry → UpgradeSheet → UpgradeButton imports the upgrade server action (server-only).
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

const Icon = () => null;

function ctxWith(selection: EditorSelection, readOnly = false): EditorContextValue {
  const data = devEditorData("ok");
  const state = { ...initEditorState(data.doc, { readOnly }), selection };
  return { state, readOnly } as unknown as EditorContextValue;
}

describe("EditorShell render smoke", () => {
  it("renders header, carousel, counter and toolbar hint", () => {
    // tools={[]}: the hint only shows when no tool applies (the real registry has "always" tools).
    const html = renderToStaticMarkup(<EditorShell data={devEditorData("ok")} transport={devTransport("ok")} tools={[]} />);
    expect(html).toContain('data-testid="editor-shell"');
    expect(html).toContain('data-testid="editor-title"');
    expect(html).toContain("Sara &amp; Omar");
    expect(html).toContain('data-testid="page-carousel"');
    expect(html).toContain('data-testid="page-counter"');
    expect(html).toContain("Cover · ");
    expect(html).toContain("Tap a photo or caption to edit it");
    expect(html).toContain('data-testid="slot-target"');
    expect(html).toContain('data-testid="caption-target"');
    expect(html).toContain('aria-label="Undo"');
    expect(html).toContain("Saved ✓");
    // All caption text uses dir="auto".
    const captions = html.match(/<span[^>]*data-testid="page-caption"[^>]*>/g) ?? [];
    expect(captions.length).toBeGreaterThan(0);
    for (const c of captions) expect(c).toContain('dir="auto"');
    expect(html).toMatch(/<h1 [^>]*data-testid="editor-title"><span dir="auto">/);
  });

  it("read-only: banner, no tap targets, static captions", () => {
    const html = renderToStaticMarkup(
      <EditorShell data={devEditorData("readonly")} transport={devTransport("readonly")} tools={[]} />,
    );
    expect(html).toContain('data-testid="save-banner-readOnly"');
    expect(html).toContain('data-readonly="true"');
    expect(html).toContain("Saving unavailable");
    expect(html).not.toContain('data-testid="slot-target"');
    expect(html).not.toContain('data-testid="caption-target"');
    expect(html).toContain("Read-only");
  });

  it("windowing: only pages near the current one render a BookPage", () => {
    const html = renderToStaticMarkup(<EditorShell data={devEditorData("ok")} transport={devTransport("ok")} />);
    const items = html.match(/data-testid="carousel-item"/g) ?? [];
    const pages = html.match(/data-testid="editor-page"/g) ?? [];
    expect(items.length).toBe(devEditorData("ok").doc.pages.length + 1);
    expect(pages.length).toBe(3); // cover + 2 neighbours
  });
});

describe("SaveStatus", () => {
  it("labels every state", () => {
    expect(saveStatusLabel({ kind: "idle" })).toBe("Saved ✓");
    expect(saveStatusLabel({ kind: "saved", savedAt: null })).toBe("Saved ✓");
    expect(saveStatusLabel({ kind: "pending" })).toBe("Saving…");
    expect(saveStatusLabel({ kind: "saving" })).toBe("Saving…");
    expect(saveStatusLabel({ kind: "retrying", attempt: 2 })).toBe("Offline – retrying");
    expect(saveStatusLabel({ kind: "retrying", attempt: 2, reason: "network" })).toBe("Offline – retrying");
    expect(saveStatusLabel({ kind: "retrying", attempt: 1, reason: "server" })).toBe("Saving delayed – retrying");
    expect(saveStatusLabel({ kind: "conflict" })).toBe("Changed in another tab");
    expect(saveStatusLabel({ kind: "unavailable" })).toBe("Saving unavailable");
    expect(saveStatusLabel({ kind: "readOnly" })).toBe("Saving unavailable");
  });

  it("conflict shows a Reload action; banners only for states that need the user", () => {
    expect(renderToStaticMarkup(<SaveStatus status={{ kind: "conflict" }} />)).toContain("Reload");
    expect(renderToStaticMarkup(<SaveBanner status={{ kind: "saved", savedAt: null }} bookId="b" />)).toBe("");
    expect(renderToStaticMarkup(<SaveBanner status={{ kind: "invalid", code: "page_limit" }} bookId="b" />)).toContain("Remove a page");
    expect(renderToStaticMarkup(<SaveBanner status={{ kind: "signedOut" }} bookId="b" />)).toContain(
      "/login?next=%2Fbooks%2Fb%2Fedit",
    );
  });
});

describe("toolbar registry", () => {
  const tools: EditorTool[] = [
    { id: "pages", label: "Pages", icon: Icon, scopes: "always", order: 80 },
    { id: "replace", label: "Replace", icon: Icon, scopes: ["slot", "cover"], order: 10 },
    { id: "crop", label: "Crop", icon: Icon, scopes: ["slot"], order: 12 },
    { id: "caption", label: "Caption", icon: Icon, scopes: ["caption"], order: 30, openOnSelect: true, Panel: () => null },
    { id: "upgrade", label: "Upgrade", icon: Icon, scopes: "always", order: 90, editsDoc: false },
    { id: "hidden", label: "X", icon: Icon, scopes: "always", isAvailable: () => false },
  ];

  it("registered tools have unique ids", () => {
    const ids = EDITOR_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("filters by selection scope and sorts by order", () => {
    expect(visibleTools(tools, ctxWith(null)).map((t) => t.id)).toEqual(["pages", "upgrade"]);
    expect(visibleTools(tools, ctxWith({ kind: "slot", pageIdx: 0, slotIdx: 0 })).map((t) => t.id)).toEqual([
      "replace",
      "crop",
      "pages",
      "upgrade",
    ]);
    expect(visibleTools(tools, ctxWith({ kind: "cover", part: "photo" })).map((t) => t.id)).toEqual(["replace", "pages", "upgrade"]);
  });

  it("hides doc-editing tools when read-only", () => {
    expect(visibleTools(tools, ctxWith({ kind: "slot", pageIdx: 0, slotIdx: 0 }, true)).map((t) => t.id)).toEqual(["upgrade"]);
  });

  it("auto-opens openOnSelect tools for a matching selection only", () => {
    expect(autoOpenTool(tools, ctxWith({ kind: "caption", pageIdx: 0 }))?.id).toBe("caption");
    expect(autoOpenTool(tools, ctxWith({ kind: "slot", pageIdx: 0, slotIdx: 0 }))).toBeNull();
    expect(autoOpenTool(tools, ctxWith(null))).toBeNull();
  });

  it("toolbar hint text", () => {
    expect(toolbarHint(ctxWith(null))).toMatch(/Tap a photo/);
    expect(toolbarHint(ctxWith(null, true))).toMatch(/Read-only/);
  });

  it("page counter", () => {
    expect(pageCounterLabel(0, 20)).toBe("Cover · 20 pages");
    expect(pageCounterLabel(0, 1)).toBe("Cover · 1 page");
    expect(pageCounterLabel(3, 20)).toBe("3 / 20");
  });
});

describe("editor page data", () => {
  const book = { id: "b1" } as EditorData["book"];
  it("redirects to build while a run is active, and for an empty doc", () => {
    expect(editorRedirect({ book, activeBuildRunId: "r", docError: null, photos: [] })).toBe("/books/b1/build");
    expect(editorRedirect({ book, activeBuildRunId: null, docError: "empty", photos: [] })).toBe("/books/b1/upload");
    expect(
      editorRedirect({ book, activeBuildRunId: null, docError: "empty", photos: [{} as EditorData["photos"][number]] }),
    ).toBe("/books/b1/build");
    expect(editorRedirect({ book, activeBuildRunId: null, docError: "invalid", photos: [] })).toBeNull();
    expect(editorRedirect({ book, activeBuildRunId: null, docError: null, photos: [] })).toBeNull();
  });

  it("maps loader data to serializable shell props (null for no doc)", () => {
    const fx = devEditorData("ok");
    const data: EditorData = { ...fx, docError: null, activeBuildRunId: null, expiresAt: null, hasBuildRun: true };
    const out = toEditorShellData(data);
    // + the free-link state (never published) and the AI entry points (M13 review fixes).
    expect(out).toEqual({ ...fx, freeLink: { kind: "unpublished" }, aiPath: out!.aiPath });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    expect(toEditorShellData({ ...data, doc: null, docError: "invalid" })).toBeNull();
  });
});

describe("photo url refresh", () => {
  function fake() {
    const tasks: (() => void)[] = [];
    return {
      timers: { set: (fn: () => void) => tasks.push(fn), clear: () => void tasks.splice(0) },
      runAll: () => tasks.splice(0).forEach((f) => f()),
    };
  }

  it("batches reported ids into one request and merges by id", async () => {
    const t = fake();
    const requests: string[][] = [];
    const merged: unknown[] = [];
    const r = new PhotoUrlRefresher(
      async (ids) => {
        requests.push(ids);
        return ids.map((id) => ({ id, webUrl: `new-${id}`, thumbUrl: null }));
      },
      (fresh) => merged.push(fresh),
      t.timers,
    );
    r.report("a");
    r.report("b");
    r.report("a");
    t.runAll();
    await new Promise((res) => setTimeout(res, 0));
    expect(requests).toEqual([["a", "b"]]);
    expect(merged).toHaveLength(1);
  });

  it(`stops after ${MAX_REFRESHES_PER_PHOTO} refreshes of the same photo`, () => {
    const t = fake();
    const r = new PhotoUrlRefresher(async () => [], () => {}, t.timers);
    for (let i = 0; i < MAX_REFRESHES_PER_PHOTO; i++) {
      expect(r.report("a")).toBe(true);
      t.runAll();
    }
    expect(r.report("a")).toBe(false);
  });

  it("mergePhotoUrls keeps identity when nothing changes and keeps old URLs for nulls", () => {
    const photos = [
      { id: "a", webUrl: "w1", thumbUrl: "t1" },
      { id: "b", webUrl: "w2", thumbUrl: "t2" },
    ];
    expect(mergePhotoUrls(photos, [])).toBe(photos);
    expect(mergePhotoUrls(photos, [{ id: "a", webUrl: "w1", thumbUrl: "t1" }])).toBe(photos);
    const out = mergePhotoUrls(photos, [{ id: "a", webUrl: "w9", thumbUrl: null }, { id: "zz", webUrl: "x", thumbUrl: "y" }]);
    expect(out[0]).toEqual({ id: "a", webUrl: "w9", thumbUrl: "t1" });
    expect(out[1]).toBe(photos[1]);
    expect(out).toHaveLength(2);
  });
});
