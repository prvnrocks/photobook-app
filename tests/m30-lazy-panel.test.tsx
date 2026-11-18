// @vitest-environment jsdom
// Lazy tool panels (M30 review, D-091): the description / accent panels load in their own chunks.
// The descriptors stay static; a panel shows a sized placeholder while its chunk loads, never
// remounts when the chunk arrives, and mounts directly once the chunk is there.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorContextValue } from "@/components/editor/editor-context";
import { accentColourTool } from "@/components/editor/tools/accent-colour";
import { AccentColourPanel } from "@/components/editor/tools/accent-colour-panel";
import { aiDescriptionTool, chapterDescriptionTool } from "@/components/editor/tools/chapter-description";
import { AiDescriptionPanel, ChapterDescriptionPanel } from "@/components/editor/tools/chapter-description-panel";
import { lazyPanel, preloadLazyPanels } from "@/components/editor/tools/lazy-panel";
import type { EditorPanelProps } from "@/components/editor/tools/types";
import { m30EditorDoc } from "@/lib/book/dev-m30";
import { initEditorState } from "@/lib/editor/store";

// The AI panel → UpgradeSheet → UpgradeButton imports the upgrade server action (server-only).
vi.mock("@/app/books/[id]/upgrade/actions", () => ({ startUpgradeCheckout: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(el: React.ReactElement) {
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
});
const q = (testId: string) => host!.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const props = { ctx: {} as EditorContextValue, close: () => {} } satisfies EditorPanelProps;

function Counter() {
  const [n, setN] = useState(0);
  return (
    <button type="button" data-testid="counter" onClick={() => setN(n + 1)}>
      {n}
    </button>
  );
}

describe("lazyPanel", () => {
  it("shows a sized placeholder until the chunk arrives, then the panel; state survives later chunk loads", async () => {
    let resolve!: (c: typeof Counter) => void;
    let calls = 0;
    const Panel = lazyPanel(() => {
      calls++;
      return new Promise<typeof Counter>((r) => (resolve = r));
    }, "min-h-56");
    mount(<Panel {...props} />);
    const placeholder = q("editor-panel-loading")!;
    expect(placeholder.getAttribute("role")).toBe("status");
    expect(placeholder.getAttribute("aria-busy")).toBe("true");
    expect(placeholder.className).toContain("min-h-56");
    expect(placeholder.textContent).toBe("Loading…");
    expect(q("counter")).toBeNull();

    await act(async () => resolve(Counter));
    expect(q("editor-panel-loading")).toBeNull();
    expect(q("counter")!.textContent).toBe("0");
    expect(calls).toBe(1);

    // The mounted panel keeps its state across re-renders (no remount once the chunk is cached).
    await act(async () => q("counter")!.click());
    act(() => root!.render(<Panel {...props} />));
    expect(q("counter")!.textContent).toBe("1");

    // A second mount is synchronous: no placeholder.
    act(() => root!.unmount());
    mount(<Panel {...props} />);
    expect(q("editor-panel-loading")).toBeNull();
    expect(q("counter")!.textContent).toBe("0");
    expect(calls).toBe(1);
  });

  it("retries a failed chunk load once", async () => {
    let calls = 0;
    const Panel = lazyPanel(() => (++calls === 1 ? Promise.reject(new Error("ChunkLoadError")) : Promise.resolve(Counter)), "min-h-36");
    mount(<Panel {...props} />);
    await act(async () => {});
    expect(calls).toBe(2);
    expect(q("counter")).not.toBeNull();
  });
});

describe("description / accent tools", () => {
  it("descriptors are static; their panels come from the lazy chunks", async () => {
    expect(chapterDescriptionTool).toMatchObject({ id: "description", label: "Edit", scopes: ["description"], openOnSelect: true, panelTitle: "About this chapter" });
    expect(aiDescriptionTool).toMatchObject({ id: "ai-description", label: "AI help", scopes: ["description"] });
    expect(accentColourTool).toMatchObject({ id: "accent", label: "Accent colour", scopes: ["none"], dockOnMobile: true });
    for (const [tool, Real] of [
      [chapterDescriptionTool, ChapterDescriptionPanel],
      [aiDescriptionTool, AiDescriptionPanel],
      [accentColourTool, AccentColourPanel],
    ] as const) {
      expect(tool.Panel).toBeTypeOf("function");
      expect(tool.Panel).not.toBe(Real);
    }

    // Opened before its chunk: placeholder first, then the real swatches.
    const state = initEditorState(m30EditorDoc("magazine", "A5_PORTRAIT"), { page: "cover" });
    const ctx = { state, readOnly: false, actions: { edit: () => {} } } as unknown as EditorContextValue;
    const Panel = accentColourTool.Panel!;
    mount(<Panel ctx={ctx} close={() => {}} />);
    expect(q("editor-panel-loading")).not.toBeNull();
    expect(q("accent-picker")).toBeNull();
    await act(async () => {
      await preloadLazyPanels();
    });
    expect(q("editor-panel-loading")).toBeNull();
    expect(host!.querySelectorAll('[data-testid="accent-option"]')).toHaveLength(6);
  });
});
